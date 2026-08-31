import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EngineEvent, type EngineCommand, type RunConfig } from "@qa/shared";

/**
 * QA 엔진 자식 프로세스 관리자.
 *
 * **엔진은 절대 Electron 프로세스 안에서 돌지 않는다.** Playwright나 AI Provider가
 * 죽어도 UI는 살아 있어야 한다(CLAUDE.md §24). 그래서 별도 프로세스로 띄우고
 * stdout의 JSON Lines만 읽는다.
 *
 * 통신 계약은 Phase 0에 확정한 `EngineEvent` / `EngineCommand` 그대로다.
 * 여기서 새 규약을 만들지 않는다.
 */

const here = __dirname;

/**
 * 엔진 CLI 위치.
 *
 * 개발 중에는 워크스페이스의 빌드 산출물을 쓴다.
 * Phase 7에서 패키징하면 `process.resourcesPath` 아래로 들어가므로 그 경로를 먼저 본다.
 */
export function resolveEnginePath(): string {
  const candidates = [
    // 패키징된 앱: resources/engine/cli.js
    join(process.resourcesPath ?? "", "engine", "cli.js"),
    // 개발 중 스테이징 결과 (패키징 전에 확인할 때)
    resolve(here, "../../resources/engine/cli.js"),
    // 개발: apps/desktop/dist/electron → 저장소 루트로 올라가서 찾는다
    resolve(here, "../../../../packages/qa-engine/dist/cli.js"),
    resolve(here, "../../../packages/qa-engine/dist/cli.js"),
  ];
  for (const path of candidates) {
    if (path && existsSync(path)) return path;
  }
  throw new Error(
    `QA 엔진을 찾을 수 없습니다. 먼저 \`pnpm build\` 를 실행하세요.\n확인한 경로:\n${candidates.join("\n")}`,
  );
}

/**
 * 동봉한 브라우저 위치.
 *
 * 설치본에는 풀 크로미움이 `resources/browsers` 에 들어 있다.
 * 찾으면 `PLAYWRIGHT_BROWSERS_PATH` 로 엔진에 알려주고, 없으면(개발 환경)
 * 건드리지 않아 개발자 PC의 기본 캐시를 그대로 쓰게 둔다.
 */
export function resolveBrowsersPath(): string | null {
  const candidates = [
    join(process.resourcesPath ?? "", "browsers"),
    resolve(here, "../../resources/browsers"),
  ];
  for (const path of candidates) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

/**
 * 설정을 CLI 인자로 바꾼다. 비밀번호는 인자에 넣지 않는다 — 환경변수로 간다.
 *
 * **모드가 요구하는 것만 넘긴다.** 예전에는 `--url` 을 무조건 넘겼는데,
 * 소스 QA 에는 URL 이 없어 빈 문자열이 갔고 엔진은 "대상이 없다"며 USAGE 를 뿌리고
 * 종료 코드 2 로 끝났다(실측). 화면에는 "엔진이 비정상 종료했습니다" 만 보였다.
 *
 * 엔진은 `--url` / `--source` 중 **무엇을 줬는지로 모드를 정한다.**
 * 그러니 여기서도 모드를 따로 넘기지 않고 필요한 것만 넣는다.
 */
export function toCliArgs(config: RunConfig): string[] {
  const args = [
    "--name",
    config.projectName,
    "--out",
    config.outDir,
    "--provider",
    config.ai.kind,
  ];

  // ── 대상 ────────────────────────────────────────────────────────────
  if (config.mode !== "source" && config.mode !== "app") {
    args.push("--url", config.targetUrl, "--start-path", config.startPath);
  }
  if (config.mode !== "runtime" && config.source.rootDir) {
    args.push("--source", config.source.rootDir);
  }

  // ── 앱 QA ───────────────────────────────────────────────────────────
  if (config.mode === "app") {
    args.push("--package", config.app.packageName);
    if (config.app.deviceSerial) args.push("--device", config.app.deviceSerial);
    if (config.app.adbPath) args.push("--adb", config.app.adbPath);
    args.push("--app-steps", String(config.app.maxSteps));
    // 되돌릴 수 없는 동작은 **동의했을 때만** 넘긴다. 넘기지 않으면 시도하지 않는다.
    if (config.app.tryRiskyLast) args.push("--try-risky-last");
  }

  // ── 실행 QA 에만 의미 있는 것 ───────────────────────────────────────
  if (config.mode !== "source" && config.mode !== "app") {
    args.push(
      "--max-screens",
      String(config.budget.maxScreens),
      "--max-duration",
      String(config.budget.maxDurationMs),
    );
    if (config.headless) args.push("--headless");
    if (config.login.enabled && config.login.username) args.push("--user", config.login.username);
    if (!config.login.enabled) args.push("--no-login");
    if (config.crud.create) args.push("--create");
    if (config.crud.update) args.push("--update");
    if (config.crud.delete) args.push("--delete");
    if (config.crud.deleteConsent) args.push("--delete-consent");
  }

  // ── 소스 QA ─────────────────────────────────────────────────────────
  if (config.mode !== "runtime" && config.mode !== "app") {
    if (config.source.changeImpact) args.push("--change-impact");
    if (config.source.changeBase) args.push("--change-base", config.source.changeBase);
    args.push("--ai-upload", config.source.aiUpload);
    // 동의한 것만 넘긴다. 넘기지 않으면 엔진은 아무 명령도 실행하지 않는다.
    if (config.source.allowTest) args.push("--allow-test");
    if (config.source.allowBuild) args.push("--allow-build");
  }

  // ── AI ──────────────────────────────────────────────────────────────
  if (config.ai.model) args.push("--model", config.ai.model);
  if (config.ai.baseUrl) args.push("--ollama-url", config.ai.baseUrl);
  if (config.ai.visionCapable) args.push("--vision");

  return args;
}

/**
 * 동봉한 adb 경로.
 *
 * 엔진은 자식 프로세스라 설치본의 resources 위치를 스스로 알지 못한다.
 * 브라우저 경로를 알려주는 것과 같은 방식으로 환경변수에 실어 보낸다.
 */
export function resolveBundledAdb(): string | null {
  const candidates = [
    join(process.resourcesPath ?? "", "platform-tools", "adb.exe"),
    resolve(here, "../../resources/platform-tools/adb.exe"),
    resolve(here, "../../vendor/platform-tools/adb.exe"),
  ];
  return candidates.find((p) => p !== "" && existsSync(p)) ?? null;
}

export interface EngineHandlers {
  onEvent: (event: EngineEvent) => void;
  /** 파싱할 수 없는 줄. 엔진이 stdout을 오염시켰다는 뜻이라 그냥 버리지 않고 알린다. */
  onRawLine: (line: string) => void;
  onStderr: (text: string) => void;
  onExit: (code: number | null, signal: string | null) => void;
}

export class EngineProcess {
  private child: ChildProcess | null = null;
  private stopping = false;

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /**
   * 엔진을 띄운다.
   *
   * `ELECTRON_RUN_AS_NODE=1` 로 Electron 자신을 Node로 재사용한다.
   * 사용자 PC에 Node.js가 없어도 동작해야 하고(설치본은 Electron만 들어간다),
   * Phase 7 패키징에서도 같은 방식이 그대로 쓰인다.
   */
  start(
    config: RunConfig,
    password: string,
    /** 증적(runs/)을 쓸 위치. 설치본에서 프로그램 폴더는 쓰기 금지라 반드시 밖에서 정해 준다. */
    workDir: string,
    handlers: EngineHandlers,
  ): void {
    if (this.running) throw new Error("이미 실행 중인 Run이 있습니다.");

    const enginePath = resolveEnginePath();
    const browsersPath = resolveBrowsersPath();
    // 설정에서 지정한 adb 가 있으면 그것을, 없으면 동봉본을 쓴다.
    const adbPath = config.app.adbPath.trim() !== "" ? config.app.adbPath : resolveBundledAdb();

    this.stopping = false;
    this.child = spawn(process.execPath, [enginePath, ...toCliArgs(config)], {
      cwd: workDir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        // 비밀번호는 명령행이 아니라 환경변수로 넘긴다.
        // 인자로 넘기면 OS 프로세스 목록에 평문으로 보인다.
        ...(password ? { QA_PASSWORD: password } : {}),
        // 동봉한 브라우저를 쓰게 한다. 없으면 개발 PC의 기본 캐시를 그대로 쓴다.
        ...(browsersPath ? { PLAYWRIGHT_BROWSERS_PATH: browsersPath } : {}),
        // 앱 QA 용 adb. 사용자가 설정에서 직접 지정하면 그쪽이 이긴다.
        ...(adbPath ? { QA_ADB_PATH: adbPath } : {}),
        // 엔진이 INIT_CWD 기준으로 runs/ 를 만든다.
        INIT_CWD: workDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdout = this.child.stdout;
    if (stdout) {
      const lines = createInterface({ input: stdout });
      lines.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const parsed = EngineEvent.safeParse(JSON.parse(trimmed));
          if (parsed.success) handlers.onEvent(parsed.data);
          else handlers.onRawLine(trimmed);
        } catch {
          handlers.onRawLine(trimmed);
        }
      });
    }

    this.child.stderr?.on("data", (chunk: Buffer) => handlers.onStderr(chunk.toString("utf8")));

    this.child.on("error", (err) => {
      handlers.onStderr(`엔진 프로세스 오류: ${err.message}`);
    });

    this.child.on("exit", (code, signal) => {
      this.child = null;
      handlers.onExit(code, signal);
    });
  }

  /** stdin으로 제어 명령을 보낸다. 엔진이 다음 액션을 꺼내기 전에 반응한다. */
  private send(command: EngineCommand): boolean {
    if (!this.child?.stdin?.writable) return false;
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    return true;
  }

  pause(): boolean {
    return this.send({ type: "pause" });
  }

  resume(): boolean {
    return this.send({ type: "resume" });
  }

  /**
   * 중단. **버리지 않고 리포트를 만들고 끝내라**는 뜻이다(CLAUDE.md §24).
   * 엔진이 응답하지 않으면 그때 강제 종료한다.
   */
  stop(graceMs = 15_000): void {
    if (!this.child) return;
    this.stopping = true;
    if (!this.send({ type: "stop" })) {
      this.kill();
      return;
    }
    setTimeout(() => {
      if (this.stopping && this.running) this.kill();
    }, graceMs);
  }

  kill(): void {
    this.child?.kill();
    this.child = null;
  }
}
