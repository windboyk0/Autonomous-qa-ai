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

/** PATH 를 직접 훑는다. Windows 는 확장자를 붙여 봐야 한다. */
function fromPath(): string | null {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())
      : [""];

  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `claude${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
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

  cached = fromPath() ?? knownLocations().find((p) => existsSync(p)) ?? null;
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
 */
export function runClaude(
  exe: string,
  args: string[],
  input: string | null,
  timeoutMs: number,
): Promise<CliResult> {
  const isWrapper = /\.(cmd|bat)$/i.test(exe);
  const useShell = isWrapper && process.platform === "win32";

  const file = useShell ? (process.env.ComSpec ?? "cmd.exe") : exe;
  const argv = useShell ? ["/d", "/s", "/c", `"${exe}" ${args.join(" ")}`] : args;

  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Claude CLI 응답이 ${Math.round(timeoutMs / 1000)}초를 넘었습니다.`));
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });

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
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(`Claude CLI 가 종료 코드 ${code} 로 끝났습니다. ${stderr.trim()}`));
    });

    if (input !== null) child.stdin.write(input, "utf8");
    child.stdin.end();
  });
}
