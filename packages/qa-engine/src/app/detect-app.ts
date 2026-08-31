import type { IssueCandidate } from "@qa/shared";
import { createHash } from "node:crypto";
import type { RunContext } from "../run-context.js";
import type { AppExploreResult } from "./explorer.js";

/**
 * 앱 탐색 결과에서 결함 후보를 뽑는다.
 *
 * 웹의 검출기들과 **같은 자리로 들어간다.** 앱 결함을 따로 담아 두면 사용자가
 * 리포트를 두 개 읽어야 하고, 우선순위도 두 군데서 매겨진다.
 * 여기서 만든 후보는 웹 후보와 같은 judge 를 통과한다.
 *
 * 룰만 쓴다. AI 는 나중에 보강만 한다 — 근거 없는 결함을 만들지 않는다.
 */

/** 같은 예외가 여러 화면에서 나와도 하나로 묶이도록 지문을 만든다. */
function signature(parts: string[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

/**
 * 로그·예외 문자열에서 **변하는 부분을 지운다.**
 *
 * 주소값·타임스탬프·행 번호가 그대로 있으면 같은 결함이 매번 다른 것으로 잡혀
 * "결함 40건" 같은 숫자가 나온다. 사람이 보기에 같은 것은 하나로 센다.
 */
function normalize(text: string): string {
  return text
    .replace(/0x[0-9a-f]+/gi, "0x#")
    .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[.\d]*/g, "#시각")
    .replace(/:\d+\)/g, ":#)")
    .replace(/\b\d+\b/g, "#")
    .trim()
    .slice(0, 200);
}

export function detectAppIssues(result: AppExploreResult, ctx: RunContext): IssueCandidate[] {
  const candidates: IssueCandidate[] = [];
  const at = () => new Date().toISOString();

  const push = (input: {
    ruleId: string;
    title: string;
    description: string;
    stateKey: string;
    screenName: string;
    severity: IssueCandidate["suggestedSeverity"];
    dedupParts: string[];
    evidenceSummary: string;
    evidenceKind: "console" | "action";
  }): void => {
    const ev = ctx.addEvidence({
      kind: input.evidenceKind,
      stateKey: input.stateKey,
      screenName: input.screenName,
      path: null,
      summary: input.evidenceSummary,
    });
    candidates.push({
      id: `cand-app-${candidates.length + 1}`,
      source: input.evidenceKind === "console" ? "console" : "functional",
      ruleId: input.ruleId,
      title: input.title,
      description: input.description,
      stateKey: input.stateKey,
      screenName: input.screenName,
      suggestedSeverity: input.severity,
      dedupKey: signature([input.ruleId, ...input.dedupParts]),
      evidenceIds: [ev.id],
      codeRefs: [],
      apiRef: null,
      aiRationale: null,
      detectedAt: at(),
    });
  };

  /*
   * 1. 화면에 그대로 노출된 예외.
   *
   * 사용자가 스택 트레이스를 보는 것은 그 자체로 결함이다. 앱이 죽지 않았어도
   * 처리되지 않은 상태가 화면까지 새어 나온 것이다.
   */
  for (const screen of result.screens) {
    for (const text of screen.screenErrors) {
      push({
        ruleId: "APP-SCREEN-ERROR",
        title: `화면에 예외가 노출됩니다: ${normalize(text).slice(0, 60)}`,
        description: text.slice(0, 500),
        stateKey: screen.stateKey,
        screenName: screen.screenName,
        severity: "HIGH",
        dedupParts: [normalize(text)],
        evidenceSummary: `화면 예외: ${text.slice(0, 200)}`,
        evidenceKind: "console",
      });
    }
  }

  for (const action of result.actions) {
    // 2. 조작 직후 로그에 찍힌 오류.
    for (const text of action.errors) {
      push({
        ruleId: "APP-LOG-ERROR",
        title: `조작 후 오류 로그: ${normalize(text).slice(0, 60)}`,
        description: `"${action.label}" 을(를) 누른 직후 로그에 나온 오류입니다.\n\n${text.slice(0, 500)}`,
        stateKey: action.fromStateKey,
        screenName: action.screenName,
        severity: "MEDIUM",
        dedupParts: [normalize(text)],
        evidenceSummary: `"${action.label}" 직후: ${text.slice(0, 200)}`,
        evidenceKind: "console",
      });
    }

    // 3. 조작 자체가 실패한 것.
    if (action.outcome === "FAILED") {
      push({
        ruleId: "APP-ACTION-FAILED",
        title: `조작이 실패했습니다: "${action.label}"`,
        description: action.reason,
        stateKey: action.fromStateKey,
        screenName: action.screenName,
        severity: "MEDIUM",
        dedupParts: [action.label, normalize(action.reason)],
        evidenceSummary: `"${action.label}" 실패: ${action.reason}`,
        evidenceKind: "action",
      });
      continue;
    }

    /*
     * 4. 눌렀는데 아무 일도 일어나지 않은 것.
     *
     * **LOW 로 둔다.** 탭 다시 누르기나 이미 선택된 항목처럼 정상적으로 아무 일도
     * 없는 경우가 많다. 확실하지 않은 것을 높은 심각도로 올리면 리포트 전체가
     * 믿기 어려워진다 — 사람이 확인할 목록으로만 남긴다.
     */
    if (action.outcome === "EXECUTED" && !action.stateChanged) {
      push({
        ruleId: "APP-DEAD-CONTROL",
        title: `눌러도 화면이 바뀌지 않습니다: "${action.label}"`,
        description:
          `"${action.label}" 을(를) 눌렀지만 화면이 그대로였습니다.\n` +
          "이미 선택된 항목이거나 같은 화면을 다시 그리는 것일 수 있으니 확인이 필요합니다.",
        stateKey: action.fromStateKey,
        screenName: action.screenName,
        severity: "LOW",
        dedupParts: [action.screenName, action.label],
        evidenceSummary: `"${action.label}" — 화면 변화 없음 (${action.durationMs}ms)`,
        evidenceKind: "action",
      });
    }
  }

  return candidates;
}

/**
 * 탐색이 **하지 않은 것**을 사람 말로 적는다.
 *
 * 되돌릴 수 없어서 건너뛴 동작은 "확인되지 않은 영역"이지 결함이 아니다.
 * 이것을 적지 않으면 사용자는 앱 전체가 검증된 줄 안다.
 */
export function appUnverifiedAreas(result: AppExploreResult): string[] {
  const skipped = result.actions.filter((a) => a.outcome !== "EXECUTED" && a.outcome !== "FAILED");
  const byReason = new Map<string, { count: number; screens: Set<string> }>();

  for (const a of skipped) {
    const key = `"${a.label}" — ${a.reason}`;
    const entry = byReason.get(key) ?? { count: 0, screens: new Set<string>() };
    entry.count += 1;
    entry.screens.add(a.screenName);
    byReason.set(key, entry);
  }

  return [...byReason.entries()].map(
    ([key, v]) => `${key} (${v.count}회, 화면: ${[...v.screens].join(", ")})`,
  );
}
