import { z } from "zod";

export const Severity = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
export type Severity = z.infer<typeof Severity>;

export const Priority = z.enum(["P0", "P1", "P2", "P3"]);
export type Priority = z.infer<typeof Priority>;

export const IssueSource = z.enum(["console", "network", "visual", "functional", "crud", "ai"]);
export type IssueSource = z.infer<typeof IssueSource>;

/**
 * 검출기가 만든 후보. 아직 Issue가 아니다.
 * Issue Judge가 dedup·그룹핑·심각도 확정을 거쳐야 Issue가 된다.
 */
export const IssueCandidate = z.object({
  id: z.string(),
  source: IssueSource,
  /** 룰 id. 예: NET-5XX, CON-UNCAUGHT, VIS-OVERFLOW, FUNC-NO-RESPONSE */
  ruleId: z.string(),
  title: z.string(),
  description: z.string(),
  stateKey: z.string(),
  screenName: z.string(),
  suggestedSeverity: Severity,
  /**
   * 병합 키. 같은 dedupKey를 가진 후보는 Issue 1개 + Evidence N개로 합쳐진다.
   * 구성: source + ruleId + (endpointTemplate | errorSignature | selector) + httpStatus
   */
  dedupKey: z.string(),
  evidenceIds: z.array(z.string()).min(1),
  /** 룰이 아니라 AI가 만든 후보인 경우 근거 문장 */
  aiRationale: z.string().nullable().default(null),
  detectedAt: z.string().datetime(),
});
export type IssueCandidate = z.infer<typeof IssueCandidate>;

/** Priority Score = SeverityWeight × BusinessImpact × Frequency × UserExposure ÷ FixEffort */
export const PriorityFactors = z.object({
  severityWeight: z.number().positive(),
  businessImpact: z.number().min(1).max(5),
  frequency: z.number().min(1).max(5),
  userExposure: z.number().min(1).max(5),
  fixEffort: z.number().min(1).max(5),
  score: z.number(),
});
export type PriorityFactors = z.infer<typeof PriorityFactors>;

export const Issue = z.object({
  /** 사람이 부르는 ID. 예: QA-0007 */
  id: z.string(),
  title: z.string(),
  source: IssueSource,
  ruleId: z.string(),
  severity: Severity,
  priority: Priority,
  priorityFactors: PriorityFactors,
  /** 영향받는 화면들 (병합되어 여러 개일 수 있다) */
  screens: z.array(z.string()).min(1),
  description: z.string(),
  impact: z.string(),
  /** 재현 절차. Action History에서 자동 생성한다. */
  reproduction: z.array(z.string()),
  recommendation: z.string(),
  evidenceIds: z.array(z.string()).min(1),
  /** 이 Issue로 병합된 후보 수 = 발생 빈도 */
  occurrenceCount: z.number().int().positive(),
  dedupKey: z.string(),
});
export type Issue = z.infer<typeof Issue>;

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  CRITICAL: 10,
  HIGH: 6,
  MEDIUM: 3,
  LOW: 1,
};

const PRIORITY_ORDER: Priority[] = ["P0", "P1", "P2", "P3"];

/**
 * 심각도가 허용하는 우선순위 대역.
 *
 * 점수만으로 정하면 순서가 사람의 판단과 어긋난다. 실측 예:
 * 화면이 아예 열리지 않는 HIGH 결함(1개 화면)이 P3으로, 모든 화면에 반복되는
 * MEDIUM 콘솔 오류가 P0으로 나왔다. 곱셈식이라 "넓게 퍼짐"이 "심각함"을 덮어버린 것이다.
 *
 * 그래서 심각도가 대역을 정하고, 점수는 그 **대역 안에서** 순서를 정한다.
 */
const PRIORITY_BAND: Record<Severity, [Priority, Priority]> = {
  CRITICAL: ["P0", "P0"],
  HIGH: ["P0", "P1"],
  MEDIUM: ["P1", "P2"],
  LOW: ["P2", "P3"],
};

function fromScore(score: number): Priority {
  if (score >= 60) return "P0";
  if (score >= 25) return "P1";
  if (score >= 8) return "P2";
  return "P3";
}

export function toPriority(score: number, severity: Severity = "MEDIUM"): Priority {
  const [best, worst] = PRIORITY_BAND[severity];
  const raw = PRIORITY_ORDER.indexOf(fromScore(score));
  const clamped = Math.min(
    Math.max(raw, PRIORITY_ORDER.indexOf(best)),
    PRIORITY_ORDER.indexOf(worst),
  );
  return PRIORITY_ORDER[clamped]!;
}
