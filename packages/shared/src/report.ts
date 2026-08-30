import { z } from "zod";
import { Issue } from "./issue.js";
import { RunConfig } from "./run-config.js";

export const CrudResult = z.object({
  kind: z.enum(["CREATE", "READ", "UPDATE", "DELETE"]),
  executed: z.boolean(),
  pass: z.number().int().nonnegative(),
  fail: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  /** 실행하지 않았다면 그 이유 (설정 OFF / 동의 없음 / 대상 없음) */
  notExecutedReason: z.string().nullable().default(null),
});
export type CrudResult = z.infer<typeof CrudResult>;

export const RunStatus = z.enum(["PENDING", "RUNNING", "PAUSED", "COMPLETED", "STOPPED", "FAILED"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunSummary = z.object({
  runId: z.string(),
  status: RunStatus,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nonnegative(),
  /** 반드시 redactRunConfig()를 통과한 값 */
  config: RunConfig,
  screensExplored: z.number().int().nonnegative(),
  actionsExecuted: z.number().int().nonnegative(),
  actionsSkipped: z.number().int().nonnegative(),
  issueCounts: z.object({
    critical: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
  }),
  crud: z.array(CrudResult),
  /** AI Provider 상태. 실패해도 Run은 완료될 수 있다. */
  aiStatus: z.enum(["not_used", "ok", "degraded", "failed"]),
  aiFailureReason: z.string().nullable().default(null),
  /** 예산 소진·위험도 차단 등으로 탐색하지 못한 영역 */
  explorationLimits: z.array(z.string()),
  /**
   * 이번 변경이 닿는 영역. Change Impact 를 쓰지 않았으면 null.
   * **추정이라는 사실을 숨기지 않기 위해** 근거(notes)를 같이 싣는다.
   */
  changeImpact: z
    .object({
      comparedWith: z.string(),
      changedFiles: z.array(z.string()),
      endpoints: z.array(z.string()),
      apiPaths: z.array(z.string()),
      notes: z.array(z.string()),
    })
    .nullable()
    .default(null),
  unverifiedAreas: z.array(z.string()),
});
export type RunSummary = z.infer<typeof RunSummary>;

/** runs/<runId>/issues.json 의 최상위 형태 */
export const IssuesFile = z.object({
  schemaVersion: z.literal(1),
  summary: RunSummary,
  issues: z.array(Issue),
});
export type IssuesFile = z.infer<typeof IssuesFile>;
