import { z } from "zod";
import { Evidence, ConsoleEntry, NetworkEntry, VisualMetrics } from "./evidence.js";
import { IssueCandidate, Issue, Severity } from "./issue.js";
import { PageState } from "./state.js";
import { ActionResult } from "./action.js";
import { RunSummary } from "./report.js";

/**
 * AI Provider 계약.
 *
 * 철칙 2가지:
 *  1. AI는 **판정하지 않는다.** PASS/FAIL은 Playwright가 관측한 사실(HTTP/DOM/재조회)로 정한다.
 *     AI는 원인 분석·설명·개선안·중복 판단·문장 생성에만 쓴다.
 *  2. AI가 실패해도 룰 기반 결과는 그대로 살아남는다. 모든 호출부는 실패를 흡수해야 한다.
 *
 * 모든 응답은 아래 스키마로 파싱한다. 파싱 실패 시 1회 재시도 후 그 호출은 폐기한다.
 */

export const ProviderStatus = z.object({
  available: z.boolean(),
  kind: z.enum(["none", "ollama", "claude"]),
  model: z.string(),
  visionCapable: z.boolean(),
  detail: z.string(),
  /** 사용자에게 보여줄 조치 안내. 예: "Claude Code가 설치되어 있지 않습니다." */
  remediation: z.string().nullable().default(null),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;

// ── analyzePage ────────────────────────────────────────────────────────────
export const PageAnalysisInput = z.object({
  state: PageState,
  visibleText: z.string(),
  /** 텍스트 노드를 제거하고 축약한 DOM. 토큰 절약용. */
  domOutline: z.string(),
  ariaSnapshot: z.string(),
});
export const PageAnalysisResult = z.object({
  /** 이 화면이 무슨 업무 화면인지 한 줄 */
  screenPurpose: z.string(),
  /** 관리자 업무 흐름상 있어야 하는데 안 보이는 기능 후보 */
  missingFeatureCandidates: z.array(z.string()),
  notes: z.array(z.string()),
});

// ── analyzeFunction ────────────────────────────────────────────────────────
/**
 * 설명을 요청할 결함의 사실 관계.
 *
 * **여기 담긴 것만 모델에게 준다.** 실측에서 이걸 소홀히 했다가 대가를 치렀다:
 * 네트워크 결함(`/api/stats/export` 500)에 무관한 화면 이동 액션을 입력으로 넘겼더니
 * 모델이 그 액션에 대해 그럴듯한 분석을 써냈고, 그게 올바른 룰 문장을 덮어썼다.
 * 잘못된 입력을 주면 모델은 조용히, 자신 있게 잘못된 답을 낸다.
 */
export const AnalysisFinding = z.object({
  ruleId: z.string(),
  title: z.string(),
  description: z.string(),
  screens: z.array(z.string()),
  occurrenceCount: z.number().int().positive(),
});
export type AnalysisFinding = z.infer<typeof AnalysisFinding>;

export const FunctionalAnalysisInput = z.object({
  /**
   * 액션에서 비롯된 판정이면 그 액션.
   * 네트워크·콘솔·화면 결함처럼 특정 액션에 귀속되지 않으면 null이다.
   * **없는데 아무거나 채워 넣지 말 것.**
   */
  action: ActionResult.nullable(),
  finding: AnalysisFinding,
  /** 룰이 이미 내린 판정. AI는 이걸 뒤집지 않고 원인만 설명한다. */
  ruleVerdict: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
  networkEntries: z.array(NetworkEntry),
  consoleEntries: z.array(ConsoleEntry),
  beforeDomOutline: z.string(),
  afterDomOutline: z.string(),
});
export const FunctionalAnalysisResult = z.object({
  rootCause: z.string(),
  impact: z.string(),
  recommendation: z.string(),
  confidence: z.number().min(0).max(1),
});

// ── analyzeScreenshot ──────────────────────────────────────────────────────
export const VisualAnalysisInput = z.object({
  screenName: z.string(),
  /** base64 PNG. visionCapable=false인 Provider에는 전달하지 않는다. */
  screenshotBase64: z.string(),
  /** 룰 검출기가 이미 잰 값. AI는 이 위에 얹어서만 말한다. */
  metrics: VisualMetrics,
});
export const VisualAnalysisResult = z.object({
  findings: z.array(
    z.object({
      title: z.string(),
      severity: Severity,
      area: z.string(),
      description: z.string(),
      recommendation: z.string(),
    }),
  ),
  overallImpression: z.string(),
});

// ── judgeIssues ────────────────────────────────────────────────────────────
export const IssueJudgeInput = z.object({
  candidates: z.array(IssueCandidate),
  evidences: z.array(Evidence),
});
export const IssueJudgeResult = z.object({
  /** 후보 id → 병합 그룹 id. 룰 dedup이 놓친 것만 AI가 추가로 묶는다. */
  mergeGroups: z.array(z.object({ groupId: z.string(), candidateIds: z.array(z.string()).min(1) })),
  /** 오탐으로 판단한 후보. 삭제하지 않고 리포트 말미에 "제외됨"으로 남긴다. */
  falsePositiveIds: z.array(z.string()),
  severityOverrides: z.array(
    z.object({ candidateId: z.string(), severity: Severity, reason: z.string() }),
  ),
});

// ── generateReport ─────────────────────────────────────────────────────────
export const ReportInput = z.object({
  summary: RunSummary,
  issues: z.array(Issue),
});

export type PageAnalysisInput = z.infer<typeof PageAnalysisInput>;
export type PageAnalysisResult = z.infer<typeof PageAnalysisResult>;
export type FunctionalAnalysisInput = z.infer<typeof FunctionalAnalysisInput>;
export type FunctionalAnalysisResult = z.infer<typeof FunctionalAnalysisResult>;
export type VisualAnalysisInput = z.infer<typeof VisualAnalysisInput>;
export type VisualAnalysisResult = z.infer<typeof VisualAnalysisResult>;
export type IssueJudgeInput = z.infer<typeof IssueJudgeInput>;
export type IssueJudgeResult = z.infer<typeof IssueJudgeResult>;
export type ReportInput = z.infer<typeof ReportInput>;

export interface AiProvider {
  healthCheck(): Promise<ProviderStatus>;
  analyzePage(input: PageAnalysisInput): Promise<PageAnalysisResult>;
  analyzeFunction(input: FunctionalAnalysisInput): Promise<FunctionalAnalysisResult>;
  analyzeScreenshot(input: VisualAnalysisInput): Promise<VisualAnalysisResult>;
  judgeIssues(input: IssueJudgeInput): Promise<IssueJudgeResult>;
  /** 실패 시 룰 기반 템플릿 리포트로 폴백한다. */
  generateReport(input: ReportInput): Promise<string>;
}
