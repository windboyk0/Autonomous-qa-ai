import { z } from "zod";
import { ActionResult } from "./action.js";
import { PageState } from "./state.js";
import { RunStatus, RunSummary } from "./report.js";
import { Issue } from "./issue.js";

/**
 * 엔진 → 바깥세상 이벤트 스트림.
 *
 * qa-engine은 이 이벤트를 **stdout에 JSON Lines로** 흘린다.
 * CLI는 그대로 사람이 읽게 출력하고, Electron Main은 파싱해 IPC로 Renderer에 중계한다.
 * 즉 Phase 5의 UI는 새 통신 규약을 만들지 않고 이 스트림만 구독하면 된다.
 *
 * 규칙: 이 스트림에는 절대 비밀번호/토큰이 실리지 않는다.
 */

export const EngineEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run:status"),
    at: z.string().datetime(),
    runId: z.string(),
    status: RunStatus,
    message: z.string(),
  }),
  z.object({
    type: z.literal("run:progress"),
    at: z.string().datetime(),
    screensExplored: z.number().int(),
    screensQueued: z.number().int(),
    actionsExecuted: z.number().int(),
    /** 지금 무슨 일을 하는 중인지 한 줄. Monitor 화면에 그대로 표시된다. */
    currentTask: z.string(),
    currentScreen: z.string(),
  }),
  z.object({
    type: z.literal("state:visited"),
    at: z.string().datetime(),
    state: PageState,
    /** runs/<runId> 기준 상대경로. Monitor의 실시간 미리보기가 이걸 읽는다. */
    screenshotPath: z.string().nullable(),
  }),
  z.object({
    type: z.literal("action:result"),
    at: z.string().datetime(),
    result: ActionResult,
  }),
  z.object({
    type: z.literal("issue:found"),
    at: z.string().datetime(),
    issue: Issue,
  }),
  z.object({
    type: z.literal("ai:status"),
    at: z.string().datetime(),
    available: z.boolean(),
    detail: z.string(),
  }),
  z.object({
    type: z.literal("run:finished"),
    at: z.string().datetime(),
    summary: RunSummary,
    reportPath: z.string(),
    issuesPath: z.string(),
  }),
  z.object({
    type: z.literal("log"),
    at: z.string().datetime(),
    level: z.enum(["debug", "info", "warn", "error"]),
    message: z.string(),
  }),
]);
export type EngineEvent = z.infer<typeof EngineEvent>;

/** 바깥세상 → 엔진 제어 명령 (stdin JSON Lines). */
export const EngineCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("stop") }),
]);
export type EngineCommand = z.infer<typeof EngineCommand>;
