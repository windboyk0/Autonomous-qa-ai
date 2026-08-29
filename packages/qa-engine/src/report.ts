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

function issueSection(issue: Issue, evidences: readonly Evidence[]): string {
  const links = issue.evidenceIds
    .map((id) => evidences.find((e) => e.id === id))
    .filter((e): e is Evidence => e !== undefined && e.path !== null)
    .map((e) => `[${e.path}](${e.path})`);

  const lines = [
    `### ${issue.id} · ${SEVERITY_LABEL[issue.severity]} · ${issue.priority} · ${issue.title}`,
    "",
    `**화면** ${issue.screens.join(", ")}`,
    "",
    `**설명** ${issue.description.split("\n")[0]}`,
    "",
    `**영향** ${issue.impact}`,
    "",
    "**재현**",
    ...issue.reproduction.map((r) => `  ${r}`),
    "",
    `**증적** ${links.length > 0 ? links.join(", ") : "(파일 없음)"}`,
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
    `| 브라우저 | Chromium (${cfg.headless ? "headless" : "headed"}) |`,
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
  push(
    "## 13. 기능 누락 후보",
    "",
    summary.aiStatus === "ok"
      ? "AI 분석 결과가 없습니다."
      : "AI 분석을 사용하지 않아 기능 누락 후보는 판정하지 않았습니다. (Phase 4)",
  );

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

  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}
