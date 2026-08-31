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
  /**
   * 이 정규식에 걸리는 라벨/URL은 위험도와 무관하게 절대 클릭하지 않는다.
   * **정규식 소스 문자열이다.** `new RegExp(p, "i")`로 컴파일되므로
   * 백슬래시를 두 번 써야 한다(`"\\s"`). 한 번만 쓰면 JS가 `\s`를 `s`로 삼켜
   * 패턴이 조용히 무력화된다. run-config.test.ts가 이를 막는다.
   */
  denyLabelPatterns: z
    .array(z.string())
    .default([
      "로그아웃",
      "logout",
      "sign\\s*out",
      "탈퇴",
      "초기화",
      "일괄",
      "전체\\s*삭제",
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

/**
 * QA 모드 (CLAUDE.md §2-1).
 *
 * 브라우저 QA와 소스 QA는 찾는 문제가 다르다. 하나로 뭉뚱그리면 둘 다 얕아진다.
 */
export const QaMode = z.enum(["runtime", "source", "integrated", "app"]);
export type QaMode = z.infer<typeof QaMode>;

/**
 * 소스가 AI로 나가는 범위 (CLAUDE.md §16-1).
 *
 * 저장소 전체를 넘기는 선택지는 두지 않는다. 넘길 수도 없고 넘겨서도 안 된다.
 */
export const SourceAiUpload = z.enum(["none", "snippets", "files"]);
export type SourceAiUpload = z.infer<typeof SourceAiUpload>;

export const SourceConfig = z.object({
  /** 프로젝트 루트 절대 경로 */
  rootDir: z.string().default(""),
  aiUpload: SourceAiUpload.default("snippets"),
  /**
   * Change Impact 비교 기준 (git). 비우면 커밋하지 않은 변경을 보고,
   * 작업 트리가 깨끗하면 마지막 커밋으로 물러선다.
   * `changeImpact` 가 꺼져 있으면 아무것도 하지 않는다.
   */
  changeImpact: z.boolean().default(false),
  changeBase: z.string().default(""),
  /** 스캔 상한. 예산 없는 스캔은 큰 저장소에서 끝나지 않는다. */
  maxFiles: z.number().int().positive().default(5_000),
  maxFileBytes: z.number().int().positive().default(512 * 1024),
  maxTotalBytes: z.number().int().positive().default(64 * 1024 * 1024),
  /**
   * 빌드·테스트 실행 동의 (CLAUDE.md §9).
   * 기본은 전부 false 다. 동의가 있어도 의존성 설치는 하지 않는다.
   */
  allowBuild: z.boolean().default(false),
  allowTest: z.boolean().default(false),
});
export type SourceConfig = z.infer<typeof SourceConfig>;

/**
 * 앱 QA 설정 (Android).
 *
 * iOS 는 대상이 아니다. adb 는 Android 전용이고, iOS 는 전송 계층이 통째로 달라
 * 같은 설정으로 다룰 수 없다. 지원하지 않는 것을 지원하는 척하지 않는다.
 */
export const AppConfig = z.object({
  /** 대상 앱 패키지. 예: com.attendance.attendance_mobile */
  packageName: z.string().default(""),
  /** 기기 시리얼. 비우면 붙어 있는 기기가 하나일 때만 진행한다. */
  deviceSerial: z.string().default(""),
  /** adb 실행 파일. 비우면 동봉본 → PATH → 알려진 SDK 위치 순으로 찾는다. */
  adbPath: z.string().default(""),
  /**
   * 조작 후 화면이 안정될 때까지 기다리는 시간.
   * 웹의 settleMs 와 같은 역할이지만, 기기는 느리므로 기본값이 더 크다.
   */
  settleMs: z.number().int().nonnegative().default(1_500),
  /** 탐색 상한. 예산이 없으면 자율 탐색은 끝나지 않는다. */
  maxSteps: z.number().int().positive().default(80),
  maxScreens: z.number().int().positive().default(60),
  maxDurationMs: z.number().int().positive().default(15 * 60 * 1000),
  /**
   * 되돌리기 어려운 동작을 **탐색 맨 마지막에 한 번씩만** 시도할지.
   * 출근하기·퇴근하기는 실제 근태 기록을 남긴다. 기본은 하지 않는다.
   */
  tryRiskyLast: z.boolean().default(false),
});
export type AppConfig = z.infer<typeof AppConfig>;

export const RunConfig = z.object({
  mode: QaMode.default("runtime"),
  projectName: z.string().min(1),
  /**
   * zod의 `.url()`만으로는 부족하다. `localhost:3100`은 스킴이 `localhost:`인
   * 유효한 URL로 파싱되어 통과해버리는데, Playwright는 이 주소로 이동할 수 없다.
   * 사용자가 가장 흔히 치는 실수라 http/https를 명시적으로 강제한다.
   */
  targetUrl: z
    .string()
    .default("")
    .refine(
      (v) => {
        // 소스 모드에는 URL이 없다. 빈 값은 여기서 통과시키고 모드별 필수 여부는 아래에서 본다.
        if (v === "") return true;
        try {
          return /^https?:$/.test(new URL(v).protocol);
        } catch {
          return false;
        }
      },
      { message: "http:// 또는 https:// 로 시작해야 합니다" },
    ),
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
  source: SourceConfig.default({}),
  app: AppConfig.default({}),
  ai: AiProviderConfig.default({}),
  /** 증적 출력 루트. 실제 Run 디렉터리는 <outDir>/<runId> */
  outDir: z.string().default("runs"),
})
  /**
   * 모드마다 필요한 입력이 다르다.
   *
   * 이것을 필드 수준에서 강제할 수 없어 객체 수준에서 본다. 여기서 막지 않으면
   * 소스 경로 없이 소스 QA가 시작되어 "결함 0건"이라는 **거짓 안심**을 준다.
   * 실행 QA에서 targetUrl 없이 시작하는 것도 마찬가지다.
   */
  .superRefine((c, ctx) => {
    if (c.mode === "app" && c.app.packageName.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["app", "packageName"],
        message: "앱 QA 에는 대상 앱의 패키지명이 필요합니다",
      });
    }
    if (c.mode !== "source" && c.mode !== "app" && c.targetUrl === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetUrl"],
        message: `${c.mode} 모드에는 Target URL이 필요합니다`,
      });
    }
    if (c.mode !== "runtime" && c.mode !== "app" && c.source.rootDir.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source", "rootDir"],
        message: `${c.mode} 모드에는 프로젝트 폴더가 필요합니다`,
      });
    }
  });
export type RunConfig = z.infer<typeof RunConfig>;

/** 로그·이벤트·리포트로 나가기 전에 반드시 통과시켜야 하는 마스킹 함수. */
export function redactRunConfig(config: RunConfig): RunConfig {
  return {
    ...config,
    login: { ...config.login, password: config.login.password ? "***REDACTED***" : "" },
  };
}
