import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Claude Code CLI 실행기.
 *
 * 이 파일이 있는 이유는 실측 때문이다. **PATH 에 `claude` 가 없어도 설치되어 있다.**
 * Windows 에서 실제로 이랬다.
 *
 *   PATH 에 claude 없음
 *   실제 위치: C:\\Users\\<user>\\.local\\bin\\claude.exe
 *              C:\\Users\\<user>\\AppData\\Local\\Programs\\claude-cli\\claude.cmd
 *
 * `execFile("claude", ...)` 는 여기서 ENOENT 로 떨어지고, 그러면 "Claude Code CLI를
 * 찾을 수 없습니다" 로 끝나 사용자는 AI 없이 QA 가 돈 것을 나중에야 안다.
 * Electron 앱은 로그인 셸을 거치지 않으므로 사용자 터미널의 PATH 와 다르다 —
 * 터미널에서 `claude` 가 되는데 앱에서는 안 되는 상황이 정상적으로 발생한다.
 */

/** 설치 관리자들이 실제로 쓰는 자리. 위에서부터 찾는다. */
function knownLocations(): string[] {
  const home = homedir();
  const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  const roaming = process.env.APPDATA ?? join(home, "AppData", "Roaming");

  return [
    join(home, ".local", "bin", "claude.exe"),
    join(home, ".local", "bin", "claude"),
    join(local, "Programs", "claude-cli", "claude.exe"),
    join(local, "Programs", "claude-cli", "claude.cmd"),
    join(roaming, "npm", "claude.cmd"),
    join(roaming, "npm", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
}

/**
 * 확장자 우선순위. **네이티브 실행 파일을 먼저 고른다.**
 *
 * `.cmd` 는 배치 래퍼라 Node 가 직접 spawn 하지 못하고 cmd.exe 를 거쳐야 하는데,
 * 그 경로는 따옴표 규칙이 까다롭다(실측에서 여기서 깨졌다).
 * 같은 PC 에 `.exe` 와 `.cmd` 가 둘 다 있으면 `.exe` 를 쓰는 것이 언제나 낫다.
 */
function extRank(path: string): number {
  const p = path.toLowerCase();
  if (p.endsWith(".exe") || p.endsWith(".com")) return 0;
  if (p.endsWith(".cmd") || p.endsWith(".bat")) return 2;
  return 1;
}

/** PATH 를 훑어 후보를 모두 모은 뒤, 다루기 쉬운 것부터 고른다. */
function fromPath(): string | null {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())
      : [""];

  const found: string[] = [];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `claude${ext}`);
      if (existsSync(candidate)) found.push(candidate);
    }
  }
  if (found.length === 0) return null;
  return found.sort((a, b) => extRank(a) - extRank(b))[0]!;
}

let cached: string | null | undefined;

/**
 * Claude Code 실행 파일의 실제 경로. 못 찾으면 null.
 *
 * `QA_CLAUDE_PATH` 로 직접 지정할 수 있다 — 찾기 규칙이 못 따라가는 설치 방식이
 * 언제든 나올 수 있고, 그때 사용자가 손쓸 방법이 있어야 한다.
 */
export function resolveClaudeCli(): string | null {
  if (cached !== undefined) return cached;

  const override = process.env.QA_CLAUDE_PATH;
  if (override && existsSync(override)) {
    cached = override;
    return cached;
  }

  const known = knownLocations().filter((p) => existsSync(p));
  cached = fromPath() ?? known.sort((a, b) => extRank(a) - extRank(b))[0] ?? null;
  return cached;
}

/** 어디를 찾아봤는지. 못 찾았을 때 사용자에게 그대로 보여준다. */
export function searchedLocations(): string[] {
  return ["PATH", ...knownLocations()];
}

/** 테스트용. 탐색 결과 캐시를 지운다. */
export function resetClaudeCliCache(): void {
  cached = undefined;
}

/**
 * 출력을 읽는다.
 *
 * Claude CLI 자체는 UTF-8 로 쓰지만, **cmd.exe 가 내는 오류 메시지는 OEM 코드페이지**다.
 * UTF-8 로만 읽으면 한국어 Windows 에서 "'\"C:\\...\"'��(��) ���� ..." 처럼 깨져
 * 사용자도 우리도 원인을 읽을 수 없다(실측).
 */
function decodeOutput(buf: Buffer): string {
  const utf8 = buf.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  for (const enc of ["windows-949", "windows-1252"]) {
    try {
      return new TextDecoder(enc).decode(buf);
    } catch {
      /* 다음 후보로 */
    }
  }
  return utf8;
}

/**
 * 로그인 상태.
 *
 * `--version` 만 확인하면 **설치는 됐지만 로그인은 안 된** 상태를 통과시킨다.
 * 그러면 QA 는 시작되고, 분석 요청마다 실패하며, 사용자는 이유를 모른 채
 * 룰 결과만 받는다. `auth status --json` 은 API 호출 없이 이것을 알려준다.
 */
export interface ClaudeAuth {
  loggedIn: boolean;
  email: string | null;
  plan: string | null;
  /** 상태를 확인하지 못한 이유. 확인했으면 null */
  error: string | null;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Claude CLI 를 부른다. **프롬프트는 stdin 으로 넘긴다.**
 *
 * 인자로 넘기지 않는 이유가 둘이다.
 *   - Windows 명령줄은 약 32KB 가 상한이다. 화면 DOM 이 들어간 프롬프트는 쉽게 넘는다.
 *   - 프롬프트에는 대상 사이트에서 온 텍스트가 들어 있다. 그것을 명령줄에 실으면
 *     따옴표 하나로 인자 경계가 무너진다.
 *
 * `.cmd` 래퍼는 Node 20+ 가 직접 spawn 하지 못하므로(보안 수정 후 EINVAL)
 * cmd.exe 를 거친다. 이때 명령줄에 올라가는 것은 **실행 파일 경로와 우리가 만든
 * 고정 인자뿐**이고, 프롬프트는 여전히 stdin 으로 간다.
 *
 * **cmd.exe 에는 인자를 Node 에게 맡기면 안 된다.** Node 는 따옴표를 `\\"` 로
 * 이스케이프하는데 cmd 는 그 표기를 모른다. 실측에서 이렇게 나왔다.
 *
 *     '\\"C:\\Users\\...\\claude.cmd\\"' 은(는) 내부 또는 외부 명령... 아닙니다.
 *
 * 그래서 `windowsVerbatimArguments` 로 우리가 만든 명령줄을 그대로 넘기고,
 * `/s` 규칙에 맞춰 **전체를 따옴표로 한 번 더 감싼다.**
 */
export async function claudeAuthStatus(exe: string, timeoutMs = 20_000): Promise<ClaudeAuth> {
  try {
    const { stdout } = await runClaude(exe, ["auth", "status", "--json"], null, timeoutMs);
    const parsed = JSON.parse(stdout) as {
      loggedIn?: boolean;
      email?: string;
      subscriptionType?: string;
      authMethod?: string;
    };
    return {
      loggedIn: parsed.loggedIn === true,
      email: parsed.email ?? null,
      plan: parsed.subscriptionType ?? parsed.authMethod ?? null,
      error: null,
    };
  } catch (err) {
    /*
     * 이 하위 명령이 없는 옛 버전일 수 있다. 그때는 "로그인 안 됨"이라고 단정하지 않는다 —
     * 확인하지 못한 것과 확인해서 아닌 것은 다르다.
     */
    return {
      loggedIn: false,
      email: null,
      plan: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function runClaude(
  exe: string,
  args: string[],
  input: string | null,
  timeoutMs: number,
): Promise<CliResult> {
  const isWrapper = /\.(cmd|bat)$/i.test(exe);
  const useShell = isWrapper && process.platform === "win32";

  const file = useShell ? (process.env.ComSpec ?? "cmd.exe") : exe;
  const argv = useShell ? ["/d", "/s", "/c", `""${exe}" ${args.join(" ")}"`] : args;

  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: useShell,
    });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Claude CLI 응답이 ${Math.round(timeoutMs / 1000)}초를 넘었습니다.`));
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => outChunks.push(d));
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = decodeOutput(Buffer.concat(outChunks));
      const stderr = decodeOutput(Buffer.concat(errChunks));
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(`Claude CLI 가 종료 코드 ${code} 로 끝났습니다. ${stderr.trim()}`));
    });

    if (input !== null) child.stdin.write(input, "utf8");
    child.stdin.end();
  });
}
