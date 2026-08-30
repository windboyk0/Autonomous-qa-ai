import { RunConfig, redactRunConfig } from "@qa/shared";
import { emit, log, registerSecret } from "./emitter.js";
import { RunContext, makeRunId } from "./run-context.js";
import { runQa } from "./run.js";
import { RunControl } from "./control.js";

/**
 * QA 엔진 CLI 진입점.
 *
 * 사용:
 *   pnpm qa --url http://localhost:3100 --user admin --pass 'admin123!' --provider none
 *
 * 역할은 인자 파싱과 이벤트 스트림 개시까지다. Run 본체는 run.ts 에 있다.
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
사용법: qa --url <URL> [옵션]          실행 QA
       qa --source <DIR> [옵션]       소스 QA
       qa --url <URL> --source <DIR>  통합 QA

대상 (모드는 준 것에 따라 정해진다)
  --url <URL>              대상 관리자웹 주소
  --source <DIR>           대상 프로젝트 폴더

소스 QA
  --change-impact          이번 변경(git)이 닿는 화면부터 본다
  --change-base <REF>      비교 기준. 비우면 커밋하지 않은 변경
  --ai-upload <none|snippets|files>  소스가 AI로 나가는 범위. 기본 snippets
  --allow-test             이 프로젝트의 테스트·린트를 실행한다 (동의)
  --allow-build            이 프로젝트의 빌드를 실행한다 (동의)

로그인
  --user <ID>              로그인 아이디
  --no-login               로그인 없이 탐색

  비밀번호는 아래 중 하나로 전달한다 (위에서부터 우선):
    QA_PASSWORD 환경변수    권장. Electron이 자식 프로세스를 띄울 때 쓰는 경로
    --pass-stdin           stdin 첫 줄을 비밀번호로 읽는다
    --pass <PW>            비권장. 셸 히스토리와 프로세스 목록에 그대로 남는다

AI
  --claude-status                   Claude Code 설치·로그인 상태만 확인하고 끝낸다
  --provider <none|ollama|claude>   기본 none
  --model <MODEL>                   ollama 모델명
  --ollama-url <URL>                기본 http://localhost:11434
  --vision                          모델이 Vision을 지원할 때만 지정 (기본 꺼짐)
  --ai-timeout <MS>                 호출당 상한, 기본 120000
  --ai-concurrency <N>              동시 호출 상한, 기본 2

범위
  --create --update --delete        쓰기 테스트 활성화 (delete는 --delete-consent 필요)
  --form-validation                 필수 항목 검증 탐침 (폼당 최대 3건 데이터 생성)
  --max-screens <N>                 기본 120
  --max-duration <MS>               기본 900000

기타
  --out <DIR>              증적 출력 루트 (기본 runs)
  --headless               헤드리스로 실행
  --start-path <PATH>      로그인 후 시작 경로
`.trim();

/** stdin 첫 줄을 읽는다. 파이프가 없으면 빈 문자열. */
async function readPasswordFromStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
    if (Buffer.concat(chunks).includes(0x0a)) break;
  }
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
}

/**
 * 비밀번호 출처를 정한다.
 *
 * `--pass`는 편의를 위해 남겨두지만 셸 히스토리와 OS 프로세스 목록에 평문으로 남는다.
 * 엔진이 아무리 마스킹해도 이 경로는 막을 수 없으므로 사용 시 경고한다.
 * Electron(Phase 5)은 자식 프로세스 env로 QA_PASSWORD를 넘긴다.
 */
async function resolvePassword(args: RawArgs): Promise<{ password: string; warning: string | null }> {
  const fromEnv = process.env.QA_PASSWORD;
  if (fromEnv) return { password: fromEnv, warning: null };

  if (args["pass-stdin"] === true) {
    return { password: await readPasswordFromStdin(), warning: null };
  }

  if (typeof args.pass === "string") {
    return {
      password: args.pass,
      warning:
        "--pass 로 넘긴 비밀번호는 셸 히스토리와 프로세스 목록에 평문으로 남습니다. " +
        "QA_PASSWORD 환경변수 또는 --pass-stdin 을 사용하세요.",
    };
  }

  return { password: "", warning: null };
}

function buildConfig(args: RawArgs, password: string): RunConfig {
  const url = typeof args.url === "string" ? args.url : "";
  const sourceDir = typeof args.source === "string" ? args.source : "";

  // 모드는 따로 받지 않는다. **무엇을 줬는지가 곧 모드다.**
  // 플래그를 하나 더 두면 "--mode source 인데 --url 을 줬다" 같은 모순이 생긴다.
  if (!url && !sourceDir) {
    process.stderr.write(USAGE + "\n");
    process.exit(2);
  }
  const mode = url && sourceDir ? "integrated" : url ? "runtime" : "source";

  const str = (k: string, d = ""): string => (typeof args[k] === "string" ? (args[k] as string) : d);
  const num = (k: string, d: number): number => {
    const v = args[k];
    return typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : d;
  };

  const parsed = RunConfig.safeParse({
    projectName: str("name", url ? new URL(url).host : sourceDir.split(/[\\/]/).pop() || "project"),
    mode,
    targetUrl: url,
    source: {
      rootDir: sourceDir,
      aiUpload: str("ai-upload", "snippets"),
      changeImpact: args["change-impact"] === true,
      changeBase: str("change-base"),
      allowBuild: args["allow-build"] === true,
      allowTest: args["allow-test"] === true,
    },
    startPath: str("start-path", "/"),
    headless: args.headless === true,
    login: {
      enabled: args["no-login"] !== true,
      username: str("user"),
      password,
    },
    crud: {
      create: args.create === true,
      read: true,
      update: args.update === true,
      delete: args.delete === true,
      deleteConsent: args["delete-consent"] === true,
    },
    checks: { formValidation: args["form-validation"] === true },
    ai: {
      kind: (["none", "ollama", "claude"] as const).includes(str("provider", "none") as never)
        ? (str("provider", "none") as "none" | "ollama" | "claude")
        : "none",
      baseUrl: str("ollama-url", "http://localhost:11434"),
      model: str("model"),
      visionCapable: args.vision === true,
      timeoutMs: num("ai-timeout", 120_000),
      maxConcurrency: num("ai-concurrency", 2),
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true || args.h === true) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  /*
   * Claude Code 연결 점검.
   *
   * Electron 이 이 정보를 직접 구하려면 엔진 모듈을 main 프로세스로 import 해야 하고,
   * 그러면 Playwright 까지 main 번들에 딸려 들어간다. 엔진에게 물어보는 편이 낫다 —
   * 찾기 규칙도 한 곳에만 있게 된다.
   */
  if (args["claude-status"] === true) {
    const { ClaudeProvider } = await import("./ai/claude.js");
    const { resolveClaudeCli } = await import("./ai/claude-cli.js");
    const status = await new ClaudeProvider({
      kind: "claude",
      baseUrl: "",
      model: "",
      claudeMode: "cli",
      timeoutMs: 30_000,
      maxConcurrency: 1,
      visionCapable: true,
    }).healthCheck();

    process.stdout.write(
      JSON.stringify({
        ok: status.available,
        detail: status.detail,
        remediation: status.remediation,
        needsLogin: !status.available && status.detail.includes("로그인"),
        exe: resolveClaudeCli(),
      }) + "\n",
    );
    return;
  }

  const { password, warning } = await resolvePassword(args);
  const config = buildConfig(args, password);

  // 비밀번호는 이 시점 이후 모든 출력에서 자동 마스킹된다.
  if (config.login.password) registerSecret(config.login.password);
  if (warning) log("warn", warning);

  if (config.crud.delete && !config.crud.deleteConsent) {
    process.stderr.write("--delete 는 --delete-consent 없이 사용할 수 없습니다.\n");
    process.exit(2);
  }

  const runId = makeRunId();
  // pnpm은 스크립트를 패키지 디렉터리에서 실행하므로 process.cwd()를 쓰면
  // 증적이 packages/qa-engine/runs 안에 생긴다. INIT_CWD(사용자가 명령을 친 위치)를 우선한다.
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const ctx = new RunContext(runId, config.outDir, baseDir);

  emit({
    type: "run:status",
    at: new Date().toISOString(),
    runId,
    status: "RUNNING",
    message: `Run 시작: ${config.targetUrl}`,
  });

  // 설정 스냅샷은 반드시 마스킹된 형태로만 남긴다.
  log("info", `설정: ${JSON.stringify(redactRunConfig(config))}`);
  log("info", `증적 디렉터리: ${ctx.runDir}`);

  // Electron이 stdin으로 보내는 일시정지·중단 명령을 받는다.
  const control = new RunControl();
  control.listen();

  const outcome = await runQa(config, ctx, { control });
  control.close();

  emit({
    type: "run:status",
    at: new Date().toISOString(),
    runId,
    status: outcome.status,
    message: outcome.message,
  });

  if (outcome.status === "FAILED") process.exitCode = 1;
}

main().catch((err: unknown) => {
  log("error", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
