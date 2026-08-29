import { z } from "zod";

/** 마스킹 대상 헤더/필드. Evidence Agent와 Network Reviewer가 공유한다. */
export const SENSITIVE_HEADERS = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-auth-token",
  "x-api-key",
  "proxy-authorization",
] as const;

export const SENSITIVE_BODY_KEYS = [
  "password",
  "passwd",
  "pwd",
  "token",
  "accesstoken",
  "refreshtoken",
  "secret",
  "sessionid",
  "jsessionid",
  "authorization",
] as const;

export const REDACTED = "***REDACTED***";

export const ConsoleEntry = z.object({
  level: z.enum(["error", "warning", "info", "log", "debug"]),
  text: z.string(),
  /** 반복 오류 병합용 지문: 메시지에서 숫자/URL/해시를 제거한 뒤 sha1 */
  signature: z.string(),
  /**
   * unhandled promise rejection에서 온 항목인가.
   *
   * Playwright의 `pageerror`는 uncaught exception과 rejection을 구별해 주지 않는다.
   * 페이지에 심은 `unhandledrejection` 리스너가 표시해 준 것만 참이 된다.
   * CON-REJECTION과 CON-UNCAUGHT를 가르는 유일한 근거다.
   */
  isRejection: z.boolean().default(false),
  url: z.string().nullable(),
  lineNumber: z.number().int().nullable(),
  stack: z.string().nullable(),
  at: z.string().datetime(),
  stateKey: z.string(),
});
export type ConsoleEntry = z.infer<typeof ConsoleEntry>;

export const NetworkEntry = z.object({
  method: z.string(),
  url: z.string(),
  /** 쿼리와 id 세그먼트를 제거한 엔드포인트 템플릿. dedup 키로 쓴다. */
  endpointTemplate: z.string(),
  status: z.number().int().nullable(),
  statusText: z.string().nullable(),
  ok: z.boolean(),
  failureText: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  resourceType: z.string(),
  /** 마스킹 후의 헤더만 담는다. 원본은 어디에도 저장하지 않는다. */
  requestHeaders: z.record(z.string()),
  responseHeaders: z.record(z.string()),
  /** 본문은 기본 미저장. 저장 시에도 SENSITIVE_BODY_KEYS는 마스킹. */
  responseBodySnippet: z.string().nullable(),
  at: z.string().datetime(),
  stateKey: z.string(),
});
export type NetworkEntry = z.infer<typeof NetworkEntry>;

/** 룰 기반 Visual 검출기가 화면에서 재는 값. AI 없이 Phase 3에서 판정한다. */
export const VisualMetrics = z.object({
  viewportWidth: z.number().int(),
  viewportHeight: z.number().int(),
  scrollWidth: z.number().int(),
  scrollHeight: z.number().int(),
  hasHorizontalOverflow: z.boolean(),
  /** viewport 밖으로 삐져나간 요소 */
  overflowingElements: z.array(z.object({ selector: z.string(), overflowPx: z.number() })),
  /** 서로 겹치는 요소 쌍 */
  overlappingPairs: z.array(z.object({ a: z.string(), b: z.string(), areaPx: z.number() })),
  /** text-overflow로 잘린 요소 (scrollWidth > clientWidth) */
  truncatedTexts: z.array(z.object({ selector: z.string(), text: z.string() })),
  /** 화면에 보이지만 클릭 불가하게 가려진 주요 버튼 */
  obscuredCtas: z.array(z.object({ selector: z.string(), label: z.string() })),
  /** 비정상적으로 큰 빈 영역의 비율 0~1 */
  emptyAreaRatio: z.number().min(0).max(1),
});
export type VisualMetrics = z.infer<typeof VisualMetrics>;

export const EvidenceKind = z.enum([
  "screenshot",
  "dom",
  "aria",
  "console",
  "network",
  "visual",
  "action",
  "timing",
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

/**
 * 증적 1건. 실제 바이너리/대용량 본문은 파일로 떨어뜨리고 여기에는 상대경로만 담는다.
 * 모든 최종 Issue는 최소 1개의 Evidence를 가져야 한다.
 */
export const Evidence = z.object({
  id: z.string(),
  kind: EvidenceKind,
  stateKey: z.string(),
  screenName: z.string(),
  /** runs/<runId> 기준 상대경로 */
  path: z.string().nullable(),
  /** 인라인으로 들고 다닐 요약 (리포트에 그대로 인용 가능한 크기) */
  summary: z.string(),
  at: z.string().datetime(),
  /** Before/After 쌍인 경우 짝 id */
  pairedWithId: z.string().nullable().default(null),
});
export type Evidence = z.infer<typeof Evidence>;
