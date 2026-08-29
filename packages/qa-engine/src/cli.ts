import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { RunConfig, redactRunConfig } from "@qa/shared";
import { emit, log, registerSecret } from "./emitter.js";

/**
 * QA 엔진 CLI 진입점.
 *
 * 사용:
 *   pnpm qa --url http://localhost:3100 --user admin --pass 'admin123!' --provider none
 *
 * Phase 0 시점의 범위: 인자 파싱 → RunConfig 검증 → Run 디렉터리 생성 → 이벤트 스트림 개시.
 * 브라우저 구동(로그인/증적)은 Phase 1에서 붙인다.
 */

interface RawArgs {
  [key: string]: string | boolean;
}

function parseArgs(argv: string[]): RawArgs {
  const out: RawArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const USAGE = `
사용법: qa --url <URL> [옵션]

필수
  --url <URL>              대상 관리자웹 주소

로그인
  --user <ID>              로그인 아이디
  --pass <PW>              로그인 비밀번호 (로그·증적 어디에도 기록되지 않음)
  --no-login               로그인 없이 탐색

AI
  --provider <none|ollama|claude>   기본 none
  --model <MODEL>                   ollama 모델명
  --ollama-url <URL>                기본 http://localhost:11434

범위
  --create --update --delete        쓰기 테스트 활성화 (delete는 --delete-consent 필요)
  --max-screens <N>                 기본 120
  --max-duration <MS>               기본 900000

기타
  --out <DIR>              증적 출력 루트 (기본 runs)
  --headless               헤드리스로 실행
  --start-path <PATH>      로그인 후 시작 경로
`.trim();

function buildConfig(args: RawArgs): RunConfig {
  const url = typeof args.url === "string" ? args.url : "";
  if (!url) {
    process.stderr.write(USAGE + "\n");
    process.exit(2);
  }

  const str = (k: string, d = ""): string => (typeof args[k] === "string" ? (args[k] as string) : d);
  const num = (k: string, d: number): number => {
    const v = args[k];
    return typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : d;
  };

  const parsed = RunConfig.safeParse({
    projectName: str("name", new URL(url).host),
    targetUrl: url,
    startPath: str("start-path", "/"),
    headless: args.headless === true,
    login: {
      enabled: args["no-login"] !== true,
      username: str("user"),
      password: str("pass"),
    },
    crud: {
      create: args.create === true,
      read: true,
      update: args.update === true,
      delete: args.delete === true,
      deleteConsent: args["delete-consent"] === true,
    },
    ai: {
      kind: (["none", "ollama", "claude"] as const).includes(str("provider", "none") as never)
        ? (str("provider", "none") as "none" | "ollama" | "claude")
        : "none",
      baseUrl: str("ollama-url", "http://localhost:11434"),
      model: str("model"),
    },
    budget: {
      maxScreens: num("max-screens", 120),
      maxDurationMs: num("max-duration", 15 * 60 * 1000),
    },
    outDir: str("out", "runs"),
  });

  if (!parsed.success) {
    process.stderr.write("설정 오류:\n");
    for (const issue of parsed.error.issues) {
      process.stderr.write(`  - ${issue.path.join(".")}: ${issue.message}\n`);
    }
    process.exit(2);
  }

  return parsed.data;
}

/** Run 디렉터리 이름. 정렬 가능하고 파일시스템에 안전한 형태. */
function makeRunId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true || args.h === true) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  const config = buildConfig(args);

  // 비밀번호는 이 시점 이후 모든 출력에서 자동 마스킹된다.
  if (config.login.password) registerSecret(config.login.password);

  if (config.crud.delete && !config.crud.deleteConsent) {
    process.stderr.write("--delete 는 --delete-consent 없이 사용할 수 없습니다.\n");
    process.exit(2);
  }

  const runId = makeRunId();
  const runDir = resolve(process.cwd(), config.outDir, runId);
  for (const sub of ["screenshots", "dom", "aria", "network", "console", "actions"]) {
    mkdirSync(join(runDir, sub), { recursive: true });
  }

  emit({
    type: "run:status",
    at: new Date().toISOString(),
    runId,
    status: "RUNNING",
    message: `Run 시작: ${config.targetUrl}`,
  });

  // 설정 스냅샷은 반드시 마스킹된 형태로만 남긴다.
  log("info", `설정: ${JSON.stringify(redactRunConfig(config))}`);
  log("info", `증적 디렉터리: ${runDir}`);

  // ── Phase 1에서 여기에 붙는다 ────────────────────────────────────────
  //   1. Playwright 브라우저 기동 (config.headless / config.viewport)
  //   2. Login Agent — 로그인 폼 탐지 → 실행 → 성공 판정
  //   3. Evidence Agent — screenshot/dom/aria/console/network 수집
  // ────────────────────────────────────────────────────────────────────
  log("warn", "탐색 엔진은 Phase 1에서 구현됩니다. 현재는 Run 스캐폴딩까지만 동작합니다.");

  emit({
    type: "run:status",
    at: new Date().toISOString(),
    runId,
    status: "COMPLETED",
    message: "Phase 0 스캐폴딩 완료",
  });
}

main().catch((err: unknown) => {
  log("error", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
