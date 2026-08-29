import { z } from "zod";
import { RiskLevel } from "./run-config.js";

export const ActionType = z.enum([
  "CLICK",
  "NAVIGATE",
  "FILL",
  "SELECT",
  "CHECK",
  "SUBMIT",
  "OPEN_MODAL",
  "CLOSE_MODAL",
  "SORT",
  "PAGE",
  "SEARCH",
]);
export type ActionType = z.infer<typeof ActionType>;

/** Action Discovery가 한 화면에서 찾아낸 실행 후보 1건. */
export const DiscoveredAction = z.object({
  id: z.string(),
  type: ActionType,
  label: z.string(),
  /** Playwright locator 문자열. data-testid > role+name > css 순으로 안정적인 것을 고른다. */
  selector: z.string(),
  selectorStrategy: z.enum(["testid", "role", "text", "css"]),
  risk: RiskLevel,
  /** 위험도 판정 근거. 리포트와 디버깅에 그대로 노출된다. */
  riskReason: z.string(),
  /** 분류 신뢰도 0~1. 낮으면 실행하지 않고 skip으로 기록한다. */
  confidence: z.number().min(0).max(1),
  /** 이 액션을 발견한 화면 */
  stateKey: z.string(),
  screenName: z.string(),
});
export type DiscoveredAction = z.infer<typeof DiscoveredAction>;

export const ActionOutcome = z.enum([
  "EXECUTED",
  "SKIPPED_RISK",
  "SKIPPED_BUDGET",
  "SKIPPED_DENYLIST",
  "SKIPPED_LOW_CONFIDENCE",
  "SKIPPED_VISITED",
  "FAILED",
]);
export type ActionOutcome = z.infer<typeof ActionOutcome>;

/** 실행 결과. 실행하지 않은 것도 이유와 함께 반드시 기록한다(= 미검증 영역 리포트의 근거). */
export const ActionResult = z.object({
  action: DiscoveredAction,
  outcome: ActionOutcome,
  reason: z.string(),
  fromStateKey: z.string(),
  toStateKey: z.string().nullable(),
  /** 상태가 실제로 바뀌었는가 */
  stateChanged: z.boolean(),
  startedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  evidenceIds: z.array(z.string()).default([]),
  error: z.string().nullable().default(null),
});
export type ActionResult = z.infer<typeof ActionResult>;
