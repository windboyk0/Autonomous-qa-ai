import type { Evidence, Issue, RunSummary, Severity } from "@qa/shared";

/**
 * Report Writer Agent (룰 템플릿).
 *
 * **AI 없이도 리포트가 완성된다.** AI(Phase 4)는 요약 문장을 다듬을 뿐이고,
 * "AI 실패로 리포트 생성 불가"는 있을 수 없다.
 *
 * CLAUDE.md §25의 17개 목차를 전부 채운다. 특히 16(탐색 제한)과 17(미검증 기능)은
 * 절대 생략하지 않는다 — 못 본 영역을 안 적으면 사용자는 다 봤다고 착각한다.
 * 이 도구의 가장 위험한 실패 모드다.
 */

/** 모드는 리포트를 읽는 방식을 바꾼다. 무엇을 보고 만든 리포트인지 먼저 밝힌다. */
const MODE_LABEL: Record<string, string> = {
  runtime: "실행 QA (URL)",
  source: "소스 QA (프로젝트 폴더)",
  integrated: "통합 QA (실행 + 소스)",
};

/** 소스가 외부로 나갔는지는 사용자가 알아야 할 사실이다. */
const UPLOAD_LABEL: Record<string, string> = {
  none: "전송하지 않음",
  snippets: "결함이 걸린 구간만",
  files: "결함이 걸린 파일 전체",
};

const SEVERITY_LABEL: Record<Severity, string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}

/** AI 보강이 description 뒤에 덧붙이는 문단의 표식. enrich.ts와 짝을 이룬다. */
const AI_MARKER = "[AI 원인 분석]";

/**
 * 설명을 관측 사실과 AI 분석으로 나눈다.
 *
 * 스택 트레이스가 통째로 리포트에 쏟아지면 읽을 수 없으므로 관측 사실은
 * 첫 문단만 쓴다. 다만 그 뒤에 붙은 AI 분석까지 잘라버리면 AI를 켠 의미가 없다.
 */
function splitDescription(description: string): { observed: string; ai: string | null } {
  const index = description.indexOf(AI_MARKER);
  if (index === -1) {
    return { observed: description.split("\n")[0] ?? "", ai: null };
  }
  return {
    observed: description.slice(0, index).split("\n")[0] ?? "",
    ai: description.slice(index + AI_MARKER.length).trim(),
  };
}

function issueSection(issue: Issue, evidences: readonly Evidence[]): string {
  const links = issue.evidenceIds
    .map((id) => evidences.find((e) => e.id === id))
    .filter((e): e is Evidence => e !== undefined && e.path !== null)
    .map((e) => `[${e.path}](${e.path})`);

  const { observed, ai } = splitDescription(issue.description);

  const lines = [
    `### ${issue.id} · ${SEVERITY_LABEL[issue.severity]} · ${issue.priority} · ${issue.title}`,
    "",
    `**화면** ${issue.screens.join(", ")}`,
    "",
    `**설명** ${observed}`,
    "",
    ...(ai ? [`**AI 원인 분석** ${ai}`, ""] : []),
    `**영향** ${issue.impact}`,
    "",
    "**재현**",
    ...issue.reproduction.map((r) => `  ${r}`),
    "",
    `**증적** ${links.length > 0 ? links.join(", ") : "(파일 없음)"}`,
    "",
    /*
     * "어느 파일 몇 번째 줄을 고쳐야 하나" 가 소스 QA 의 존재 이유다.
     * confidence 를 같이 적어 **확정과 추정을 구분한다** — 추측을 사실처럼
     * 적으면 개발자가 엉뚱한 파일을 열고, 그 순간 이 리포트의 신뢰가 끝난다.
     */
    ...(issue.codeRefs.length > 0
      ? [
          "**관련 소스**",
          ...issue.codeRefs.map(
            (r) =>
              `  ${r.file}${r.line === null ? "" : `:${r.line}`}` +
              `${r.symbol ? ` (${r.symbol})` : ""}` +
              `${r.confidence >= 1 ? "" : ` — 추정 ${Math.round(r.confidence * 100)}%`}` +
              `${r.reason ? ` · ${r.reason}` : ""}`,
          ),
        ]
      : []),
    "",
    `**권장** ${issue.recommendation}`,
    "",
    `**발생** ${issue.occurrenceCount}회 / ${issue.screens.length}개 화면 · 우선순위 점수 ${issue.priorityFactors.score}`,
    "",
  ];
  return lines.join("\n");
}

export function renderReport(input: {
  summary: RunSummary;
  issues: Issue[];
  evidences: readonly Evidence[];
  /** AI가 만든 요약. 없으면 룰 기반 문장을 쓴다. */
  aiSummary?: string | null;
  /** AI가 제안한 기능 누락 후보 (§13). */
  missingFeatures?: string[];
  /** AI가 오탐으로 본 Issue. 지우지 않고 말미에 표시만 한다. */
  suspectedFalsePositives?: Array<{ id: string; title: string }>;
}): string {
  const { summary, issues, evidences } = input;
  const cfg = summary.config;
  const bySeverity = (s: Severity) => issues.filter((i) => i.severity === s);

  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines, "");

  push(`# QA 리포트 — ${cfg.projectName}`);

  // ── 1. 실행정보 ─────────────────────────────────────────────────────
  push(
    "## 1. 실행정보",
    "",
    "| 항목 | 값 |",
    "|---|---|",
    `| Run ID | ${summary.runId} |`,
    `| 상태 | ${summary.status} |`,
    `| 시작 | ${summary.startedAt} |`,
    `| 종료 | ${summary.finishedAt ?? "-"} |`,
    `| 소요 | ${fmtDuration(summary.durationMs)} |`,
    `| 대상 URL | ${cfg.targetUrl} |`,
    `| AI Provider | ${cfg.ai.kind}${cfg.ai.model ? ` (${cfg.ai.model})` : ""} · ${summary.aiStatus} |`,
  );

  // ── 2. 테스트환경 ───────────────────────────────────────────────────
  push(
    "## 2. 테스트환경",
    "",
    "| 항목 | 값 |",
    "|---|---|",
    `| QA 모드 | ${MODE_LABEL[cfg.mode]} |`,
    ...(cfg.mode === "runtime"
      ? []
      : [
          `| 소스 AI 전송 범위 | ${UPLOAD_LABEL[cfg.source.aiUpload]} |`,
          `| 빌드·테스트 실행 | ${cfg.source.allowBuild || cfg.source.allowTest ? "동의함" : "하지 않음"} |`,
        ]),
    ...(cfg.mode === "source"
      ? []
      : [`| 브라우저 | Chromium (${cfg.headless ? "headless" : "headed"}) |`]),
    `| 뷰포트 | ${cfg.viewport.width} × ${cfg.viewport.height} |`,
    `| CRUD 범위 | ${(["create", "read", "update", "delete"] as const)
      .filter((k) => cfg.crud[k])
      .join(", ") || "없음"} |`,
    `| 자동 실행 허용 위험도 | ${cfg.safety.maxAutoRisk} |`,
    `| 탐색 예산 | 화면 ${cfg.budget.maxScreens} · 액션 ${cfg.budget.maxActions} · 깊이 ${cfg.budget.maxDepth} · ${fmtDuration(cfg.budget.maxDurationMs)} |`,
  );

  // ── 3. Executive Summary ───────────────────────────────────────────
  const counts = summary.issueCounts;
  const worst = issues[0];
  const headline = input.aiSummary
    ? input.aiSummary
    : worst
      ? `가장 급한 것은 **${worst.id} ${worst.title}** (${SEVERITY_LABEL[worst.severity]}, ${worst.priority}) 입니다.`
      : "발견된 문제가 없습니다.";

  push(
    "## 3. Executive Summary",
    "",
    headline,
    "",
    `화면 ${summary.screensExplored}개를 탐색해 액션 ${summary.actionsExecuted}건을 실행했고, ` +
      `Issue ${issues.length}건을 확정했습니다 ` +
      `(Critical ${counts.critical} · High ${counts.high} · Medium ${counts.medium} · Low ${counts.low}).`,
    "",
    summary.aiStatus === "not_used"
      ? "AI 분석은 사용하지 않았습니다. 아래 내용은 전부 관측된 사실에 기반한 룰 판정입니다."
      : summary.aiStatus === "ok"
        ? "AI 분석이 정상 동작했습니다."
        : `AI 분석을 사용할 수 없어 룰 기반 결과만 담았습니다. (${summary.aiFailureReason ?? "사유 미상"})`,
  );

  // ── 4. CRUD 결과 ────────────────────────────────────────────────────
  push(
    "## 4. CRUD 결과",
    "",
    "| 구분 | 실행 | PASS | FAIL | SKIP | 미실행 사유 |",
    "|---|---|---|---|---|---|",
    ...summary.crud.map(
      (c) =>
        `| ${c.kind} | ${c.executed ? "예" : "아니오"} | ${c.pass} | ${c.fail} | ${c.skipped} | ${c.notExecutedReason ?? "-"} |`,
    ),
  );

  // ── 5~8. Severity별 ────────────────────────────────────────────────
  for (const [idx, sev] of (["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).entries()) {
    const list = bySeverity(sev);
    push(`## ${5 + idx}. ${SEVERITY_LABEL[sev]}`);
    if (list.length === 0) {
      push("해당 없음.");
    } else {
      for (const issue of list) out.push(issueSection(issue, evidences));
    }
  }

  // ── 9. 화면별 개선점 ────────────────────────────────────────────────
  const byScreen = new Map<string, Issue[]>();
  for (const issue of issues) {
    for (const s of issue.screens) {
      const list = byScreen.get(s) ?? [];
      list.push(issue);
      byScreen.set(s, list);
    }
  }
  push("## 9. 화면별 개선점");
  if (byScreen.size === 0) {
    push("해당 없음.");
  } else {
    push(
      "| 화면 | Issue |",
      "|---|---|",
      ...[...byScreen.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([screen, list]) => `| ${screen} | ${list.map((i) => i.id).join(", ")} |`),
    );
  }

  // ── 10~12. 출처별 ───────────────────────────────────────────────────
  const sourceSections: Array<[number, string, Issue["source"][]]> = [
    [10, "Console 오류", ["console"]],
    [11, "Network/API 오류", ["network"]],
    [12, "UX/UI 개선", ["visual"]],
  ];
  for (const [n, title, sources] of sourceSections) {
    const list = issues.filter((i) => sources.includes(i.source));
    push(`## ${n}. ${title}`);
    if (list.length === 0) {
      push("해당 없음.");
    } else {
      push(
        "| ID | 심각도 | 제목 | 발생 |",
        "|---|---|---|---|",
        ...list.map(
          (i) => `| ${i.id} | ${SEVERITY_LABEL[i.severity]} | ${i.title} | ${i.occurrenceCount}회 |`,
        ),
      );
    }
  }

  // ── 13. 기능 누락 후보 ──────────────────────────────────────────────
  const missing = input.missingFeatures ?? [];
  push("## 13. 기능 누락 후보");
  if (missing.length > 0) {
    push(
      "AI가 관리자 업무 흐름을 기준으로 제안한 후보입니다. **검증된 결함이 아닙니다.**",
      "",
      ...missing.map((m) => `- ${m}`),
    );
  } else if (summary.aiStatus === "not_used") {
    push("AI Provider를 사용하지 않아 판정하지 않았습니다.");
  } else if (summary.aiStatus === "failed") {
    push(`AI 분석을 사용할 수 없어 판정하지 않았습니다. (${summary.aiFailureReason ?? "사유 미상"})`);
  } else {
    push("AI가 제안한 기능 누락 후보가 없습니다.");
  }

  // ── 14. 우선순위 ────────────────────────────────────────────────────
  push("## 14. 우선순위");
  if (issues.length === 0) {
    push("해당 없음.");
  } else {
    push(
      "| 우선순위 | ID | 심각도 | 제목 | 점수 |",
      "|---|---|---|---|---|",
      ...issues.map(
        (i) =>
          `| ${i.priority} | ${i.id} | ${SEVERITY_LABEL[i.severity]} | ${i.title} | ${i.priorityFactors.score} |`,
      ),
    );
  }

  // ── 15. 권장 수정 순서 ──────────────────────────────────────────────
  push("## 15. 권장 수정 순서");
  if (issues.length === 0) {
    push("해당 없음.");
  } else {
    push(
      ...issues.map(
        (i, n) => `${n + 1}. **${i.id}** ${i.title} — ${i.recommendation}`,
      ),
    );
  }

  // ── 16. 탐색 제한 ───────────────────────────────────────────────────
  push("## 16. 탐색 제한");
  if (summary.explorationLimits.length === 0) {
    push("예산 안에서 탐색을 완료했습니다.");
  } else {
    push(...summary.explorationLimits.map((l) => `- ${l}`));
  }

  // ── 17. 미검증 기능 ─────────────────────────────────────────────────
  push(
    "## 17. 미검증 기능",
    "",
    "**아래 항목은 검증되지 않았습니다.** 문제가 없다는 뜻이 아닙니다.",
  );
  if (summary.unverifiedAreas.length === 0) {
    push("- 없음");
  } else {
    push(...summary.unverifiedAreas.map((a) => `- ${a}`));
  }

  // ── 부록: AI가 오탐으로 본 항목 ─────────────────────────────────────
  //   지우지 않고 남긴다. AI가 틀렸을 때 사람이 되짚을 수 있어야 한다.
  const fp = input.suspectedFalsePositives ?? [];
  if (fp.length > 0) {
    push(
      "## 부록. AI가 오탐으로 본 항목",
      "",
      "아래 Issue는 AI가 실제 결함이 아니라고 판단했습니다.",
      "**목록에서 지우지 않았습니다.** AI 판단이 틀릴 수 있으므로 직접 확인하세요.",
      "",
      ...fp.map((f) => `- ${f.id} ${f.title}`),
    );
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}
