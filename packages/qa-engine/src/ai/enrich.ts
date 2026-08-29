import type {
  AiProvider,
  AiProviderConfig,
  ActionResult,
  Evidence,
  Issue,
  ProviderStatus,
  RunSummary,
  Severity,
} from "@qa/shared";
import { log } from "../emitter.js";
import { AiGuard, mapLimited, type AiStatus } from "./guard.js";

/**
 * AI 보강 단계.
 *
 * **탐색이 전부 끝난 뒤에 돈다.** 탐색 중에 AI를 부르면 결정성이 깨지고,
 * 모델이 느릴 때 브라우저 세션이 하염없이 열려 있게 된다.
 *
 * 여기서 하는 일은 전부 **덧붙이기**다. 룰이 만든 Issue를 지우거나 판정을
 * 뒤집지 않는다. AI가 통째로 죽어도 입력 그대로가 결과가 된다.
 */

export interface EnrichResult {
  issues: Issue[];
  /** 리포트 §3에 들어갈 요약. null이면 룰 기반 문장을 쓴다. */
  summaryText: string | null;
  /** 리포트 §13에 들어갈 기능 누락 후보. */
  missingFeatures: string[];
  /** AI가 오탐으로 본 Issue. 지우지 않고 표시만 한다. */
  suspectedFalsePositives: Array<{ id: string; title: string }>;
  status: AiStatus;
  failureReason: string | null;
}

/** 화면 분석은 비용이 크다. 대표 화면 몇 개만 본다. */
const PAGE_ANALYSIS_LIMIT = 5;

export function passthrough(issues: Issue[]): EnrichResult {
  return {
    issues,
    summaryText: null,
    missingFeatures: [],
    suspectedFalsePositives: [],
    status: "not_used",
    failureReason: null,
  };
}

export async function enrich(input: {
  provider: AiProvider;
  config: AiProviderConfig;
  status: ProviderStatus;
  issues: Issue[];
  summary: RunSummary;
  evidences: readonly Evidence[];
  actionResults: ActionResult[];
  pages: Array<{ screenName: string; pathTemplate: string; visibleText: string; domOutline: string }>;
}): Promise<EnrichResult> {
  const { provider, config, issues } = input;
  const guard = new AiGuard(config.timeoutMs);

  // ── 1. Issue별 원인·영향·개선안 보강 ──────────────────────────────
  //    룰이 이미 정해둔 문장을 AI가 더 구체적인 것으로 바꾼다.
  //    실패하면 룰 문장이 그대로 남는다.
  const enriched = await mapLimited(issues, config.maxConcurrency, async (issue) => {
    /**
     * 액션에서 비롯된 결함에만 액션을 붙인다.
     *
     * 예전에는 "이슈의 첫 화면에서 발견된 아무 액션"을 넘겼는데, 그 결과
     * `/api/stats/export` 500 이슈에 화면 이동 액션이 붙어 모델이 엉뚱한
     * 분석을 내놓았고 그게 올바른 룰 문장을 덮어썼다. 없으면 없는 채로 넘긴다.
     */
    const related =
      issue.source === "functional" || issue.source === "crud"
        ? (input.actionResults.find(
            (r) => r.action.screenName === issue.screens[0] && r.outcome === "EXECUTED",
          ) ?? null)
        : null;

    const result = await guard.run(`analyzeFunction(${issue.id})`, () =>
      provider.analyzeFunction({
        action: related,
        finding: {
          ruleId: issue.ruleId,
          title: issue.title,
          description: issue.description,
          screens: issue.screens,
          occurrenceCount: issue.occurrenceCount,
        },
        ruleVerdict: "FAIL",
        networkEntries: [],
        consoleEntries: [],
        beforeDomOutline: "",
        afterDomOutline: "",
      }),
    );

    if (!result || !result.rootCause) return issue;

    /**
     * 확신이 낮으면 룰 문장을 지키다.
     * 작은 로컬 모델은 모르는 것도 자신 있게 쓴다. 검증된 룰 문장을 추측으로
     * 바꾸는 것은 이 도구의 신뢰를 깎는 쪽이다. 원인 분석은 덧붙이되,
     * 영향·권장은 확신이 있을 때만 대체한다.
     */
    const trusted = result.confidence >= 0.5;
    return {
      ...issue,
      description: `${issue.description}\n\n[AI 원인 분석] ${result.rootCause}`,
      impact: trusted && result.impact ? result.impact : issue.impact,
      recommendation: trusted && result.recommendation ? result.recommendation : issue.recommendation,
    };
  });

  // ── 2. 오탐 후보 표시 ─────────────────────────────────────────────
  //    **지우지 않는다.** 실제 결함을 지우는 쪽이 훨씬 큰 손해다.
  const suspectedFalsePositives: EnrichResult["suspectedFalsePositives"] = [];
  const severityOverrides = new Map<string, { severity: Severity; reason: string }>();

  if (enriched.length > 0) {
    const verdict = await guard.run("judgeIssues", () =>
      provider.judgeIssues({
        candidates: enriched.map((i) => ({
          id: i.id,
          source: i.source,
          ruleId: i.ruleId,
          title: i.title,
          description: i.description.slice(0, 400),
          stateKey: i.dedupKey,
          screenName: i.screens[0] ?? "",
          suggestedSeverity: i.severity,
          dedupKey: i.dedupKey,
          evidenceIds: i.evidenceIds,
          aiRationale: null,
          detectedAt: new Date().toISOString(),
        })),
        evidences: [...input.evidences],
      }),
    );

    if (verdict) {
      for (const id of verdict.falsePositiveIds) {
        const issue = enriched.find((i) => i.id === id);
        if (issue) suspectedFalsePositives.push({ id: issue.id, title: issue.title });
      }
      for (const o of verdict.severityOverrides) {
        severityOverrides.set(o.candidateId, { severity: o.severity, reason: o.reason });
      }
      if (verdict.mergeGroups.length > 0) {
        log("info", `AI가 추가 병합 ${verdict.mergeGroups.length}건을 제안했습니다 (기록만 합니다).`);
      }
    }
  }

  const withOverrides = enriched.map((issue) => {
    const o = severityOverrides.get(issue.id);
    if (!o) return issue;
    log("info", `AI 심각도 조정: ${issue.id} ${issue.severity} → ${o.severity} (${o.reason})`);
    return { ...issue, severity: o.severity };
  });

  // ── 3. 기능 누락 후보 ─────────────────────────────────────────────
  const missingFeatures: string[] = [];
  for (const page of input.pages.slice(0, PAGE_ANALYSIS_LIMIT)) {
    const result = await guard.run(`analyzePage(${page.screenName})`, () =>
      provider.analyzePage({
        state: {
          stateKey: "",
          signals: {
            pathTemplate: page.pathTemplate,
            queryKeys: [],
            title: page.screenName,
            heading: page.screenName,
            activeTab: null,
            dialogTitle: null,
            navLabels: [],
            structureHash: "",
          },
          url: "",
          depth: 0,
          arrivedByActionId: null,
          visitedAt: new Date().toISOString(),
          screenName: page.screenName,
        },
        visibleText: page.visibleText,
        domOutline: page.domOutline,
        ariaSnapshot: "",
      }),
    );
    for (const candidate of result?.missingFeatureCandidates ?? []) {
      missingFeatures.push(`${page.screenName}: ${candidate}`);
    }
  }

  // ── 4. Executive Summary ──────────────────────────────────────────
  const summaryText = await guard.run("generateReport", () =>
    provider.generateReport({ summary: input.summary, issues: withOverrides }),
  );

  const counts = guard.counts();
  log("info", `AI 보강 완료: 성공 ${counts.ok}건 · 실패 ${counts.failed}건`);

  return {
    issues: withOverrides,
    summaryText: summaryText && summaryText.trim() ? summaryText.trim() : null,
    missingFeatures,
    suspectedFalsePositives,
    status: guard.status(),
    failureReason: guard.failureReason(),
  };
}
