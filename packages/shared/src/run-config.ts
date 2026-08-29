import { z } from "zod";

/**
 * 하나의 QA Run을 정의하는 전체 설정.
 * Electron 설정화면과 qa-engine CLI 인자가 모두 이 스키마 하나로 수렴한다.
 */

export const RiskLevel = z.enum(["SAFE", "CAUTION", "DANGEROUS"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const CrudScope = z.object({
  create: z.boolean().default(false),
  read: z.boolean().default(true),
  update: z.boolean().default(false),
  /** Delete는 별도의 명시적 동의(deleteConsent) 없이는 켜져도 실행하지 않는다. */
  delete: z.boolean().default(false),
  deleteConsent: z.boolean().default(false),
});
export type CrudScope = z.infer<typeof CrudScope>;

export const CheckScope = z.object({
  visual: z.boolean().default(true),
  console: z.boolean().default(true),
  network: z.boolean().default(true),
  formValidation: z.boolean().default(false),
  searchFilter: z.boolean().default(true),
  tableSort: z.boolean().default(true),
  pagination: z.boolean().default(true),
  modal: z.boolean().default(true),
  accessibility: z.boolean().default(false),
});
export type CheckScope = z.infer<typeof CheckScope>;

/**
 * 탐색 예산. 이 값이 없으면 자율탐색은 끝나지 않는다. 전부 필수 상한이다.
 */
export const ExploreBudget = z.object({
  maxScreens: z.number().int().positive().default(120),
  maxActions: z.number().int().positive().default(600),
  maxDepth: z.number().int().positive().default(8),
  maxDurationMs: z.number().int().positive().default(15 * 60 * 1000),
  /** 액션 1회 실행 후 상태 안정화를 기다리는 시간 */
  settleMs: z.number().int().nonnegative().default(700),
  navigationTimeoutMs: z.number().int().positive().default(15_000),
});
export type ExploreBudget = z.infer<typeof ExploreBudget>;

export const SafetyPolicy = z.object({
  /** 자동 실행을 허용할 최대 위험도. DANGEROUS는 사용자가 명시적으로 올리지 않는 한 금지. */
  maxAutoRisk: RiskLevel.default("SAFE"),
  /** 이 정규식에 걸리는 라벨/URL은 위험도와 무관하게 절대 클릭하지 않는다. */
  denyLabelPatterns: z
    .array(z.string())
    .default([
      "로그아웃",
      "logout",
      "sign\s*out",
      "탈퇴",
      "초기화",
      "일괄",
      "전체\s*삭제",
      "발송",
      "전송",
      "승인",
      "반려",
      "게시",
      "배포",
    ]),
  /** 탐색을 허용할 origin. 비면 targetUrl의 origin만 허용한다. */
  allowedOrigins: z.array(z.string()).default([]),
  /** 로그아웃 방지: 세션이 끊기면 재로그인 후 이어서 탐색 */
  reloginOnSessionLoss: z.boolean().default(true),
});
export type SafetyPolicy = z.infer<typeof SafetyPolicy>;

export const LoginConfig = z.object({
  enabled: z.boolean().default(true),
  /** 비밀번호는 이 객체에 담기지만 절대 직렬화·로깅되지 않는다. redactRunConfig() 참조. */
  username: z.string().default(""),
  password: z.string().default(""),
  /** 비우면 Login Agent가 자동 탐지한다. */
  loginPath: z.string().optional(),
  usernameSelector: z.string().optional(),
  passwordSelector: z.string().optional(),
  submitSelector: z.string().optional(),
  /** 로그인 성공 판정에 쓸 추가 신호 (선택) */
  successUrlPattern: z.string().optional(),
});
export type LoginConfig = z.infer<typeof LoginConfig>;

export const AiProviderConfig = z.object({
  kind: z.enum(["none", "ollama", "claude"]).default("none"),
  /** ollama 전용 */
  baseUrl: z.string().default("http://localhost:11434"),
  model: z.string().default(""),
  /** claude 전용: PoC는 CLI(`claude -p`) */
  claudeMode: z.enum(["cli", "sdk"]).default("cli"),
  timeoutMs: z.number().int().positive().default(120_000),
  maxConcurrency: z.number().int().positive().default(2),
  /** Vision 분석 가능 여부. false면 Visual은 룰 결과만 사용한다. */
  visionCapable: z.boolean().default(false),
});
export type AiProviderConfig = z.infer<typeof AiProviderConfig>;

export const RunConfig = z.object({
  projectName: z.string().min(1),
  targetUrl: z.string().url(),
  startPath: z.string().default("/"),
  headless: z.boolean().default(false),
  viewport: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .default({ width: 1440, height: 900 }),
  login: LoginConfig.default({}),
  crud: CrudScope.default({}),
  checks: CheckScope.default({}),
  safety: SafetyPolicy.default({}),
  budget: ExploreBudget.default({}),
  ai: AiProviderConfig.default({}),
  /** 증적 출력 루트. 실제 Run 디렉터리는 <outDir>/<runId> */
  outDir: z.string().default("runs"),
});
export type RunConfig = z.infer<typeof RunConfig>;

/** 로그·이벤트·리포트로 나가기 전에 반드시 통과시켜야 하는 마스킹 함수. */
export function redactRunConfig(config: RunConfig): RunConfig {
  return {
    ...config,
    login: { ...config.login, password: config.login.password ? "***REDACTED***" : "" },
  };
}
