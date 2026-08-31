import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/**
 * adb 전송 계층.
 *
 * 앱 QA 의 모든 조작이 여기를 지난다. Playwright 의 `Page` 에 해당하는 자리다.
 *
 * `mobile/explore.py` 를 TypeScript 로 옮겼다. **Python 을 요구하지 않기 위해서다** —
 * 설치본이 Python 을 필요로 하면 "설치 후 5분 내 QA 시작"(CLAUDE.md §29)이 깨진다.
 */

/** 명령 하나의 상한. 기기가 응답하지 않을 때 영원히 기다리지 않는다. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 화면 덤프·스크린샷은 크다. 넉넉히 잡되 무한은 아니다. */
const MAX_BUFFER = 32 * 1024 * 1024;

function knownLocations(): string[] {
  const home = homedir();
  const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  return [
    // 설치본에 동봉한 것. 가장 먼저 본다 — 사용자가 아무것도 안 해도 되어야 한다.
    join(process.env.QA_RESOURCES_DIR ?? "", "platform-tools", "adb.exe"),
    join(local, "Android", "Sdk", "platform-tools", "adb.exe"),
    join(home, "AppData", "Local", "Android", "Sdk", "platform-tools", "adb.exe"),
    "C:\\platform-tools\\adb.exe",
    "C:\\platform-tools-latest-windows\\platform-tools\\adb.exe",
    "/usr/local/bin/adb",
    "/opt/homebrew/bin/adb",
  ].filter((p) => p !== "" && !p.startsWith(join("", "platform-tools")));
}

function fromPath(): string | null {
  const exts = process.platform === "win32" ? [".exe", ".bat", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `adb${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

let cached: string | null | undefined;

/**
 * adb 실행 파일. 못 찾으면 null.
 *
 * 찾는 순서: 설정에서 직접 지정 → 동봉본 → PATH → 알려진 SDK 위치.
 * Claude CLI 를 찾을 때와 같은 이유로 PATH 만 믿지 않는다 —
 * Electron 앱은 로그인 셸을 거치지 않아 사용자 터미널과 PATH 가 다르다.
 */
export function resolveAdb(configured = ""): string | null {
  if (configured.trim() !== "" && existsSync(configured)) return configured;
  if (cached !== undefined) return cached;

  const bundled = process.env.QA_ADB_PATH;
  if (bundled && existsSync(bundled)) {
    cached = bundled;
    return cached;
  }

  cached = fromPath() ?? knownLocations().find((p) => existsSync(p)) ?? null;
  return cached;
}

export function resetAdbCache(): void {
  cached = undefined;
}

export function searchedAdbLocations(): string[] {
  return ["QA_ADB_PATH", "PATH", ...knownLocations()];
}

export interface AdbDevice {
  serial: string;
  /** device / unauthorized / offline */
  state: string;
  model: string | null;
}

/**
 * 붙어 있는 기기 목록.
 *
 * `unauthorized`(폰에서 USB 디버깅 허용을 누르지 않음)를 **연결됨과 구분해서** 돌려준다.
 * 이 둘을 뭉뚱그리면 사용자는 "기기가 보이는데 왜 안 되지"에서 막힌다.
 */
export function listDevices(adbPath: string): AdbDevice[] {
  let out = "";
  try {
    out = execFileSync(adbPath, ["devices", "-l"], {
      encoding: "utf8",
      timeout: DEFAULT_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    return [];
  }

  const devices: AdbDevice[] = [];
  for (const line of out.split(/\r?\n/).slice(1)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("*")) continue;
    const [serial, state, ...rest] = trimmed.split(/\s+/);
    if (!serial || !state) continue;
    const model = /model:(\S+)/.exec(rest.join(" "))?.[1] ?? null;
    devices.push({ serial, state, model });
  }
  return devices;
}

export interface AdbResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** 상한을 넘겨 끊겼는가. 기기가 멈춘 것과 명령이 실패한 것은 다르다. */
  timedOut: boolean;
}

export class Adb {
  constructor(
    private readonly adbPath: string,
    private readonly serial: string | null = null,
  ) {}

  private args(rest: string[]): string[] {
    return this.serial ? ["-s", this.serial, ...rest] : rest;
  }

  /** 원시 실행. 실패해도 던지지 않는다 — 기기는 언제든 뽑힐 수 있다. */
  run(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): AdbResult {
    const res = spawnSync(this.adbPath, this.args(args), {
      encoding: "buffer",
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    return {
      stdout: (res.stdout ?? Buffer.alloc(0)).toString("utf8"),
      stderr: (res.stderr ?? Buffer.alloc(0)).toString("utf8"),
      code: res.status,
      timedOut: res.error !== undefined && /ETIMEDOUT|timed? ?out/i.test(String(res.error.message)),
    };
  }

  shell(command: string[], timeoutMs = DEFAULT_TIMEOUT_MS): AdbResult {
    return this.run(["shell", ...command], timeoutMs);
  }

  /** 기기의 파일을 PC 로 가져온다. */
  pull(remote: string, local: string): boolean {
    mkdirSync(dirname(local), { recursive: true });
    const res = this.run(["pull", remote, local], 60_000);
    return res.code === 0 && existsSync(local);
  }

  /**
   * UI 트리 덤프.
   *
   * uiautomator 는 화면이 바뀌는 중에 실패한다. 몇 번 다시 시도하되,
   * 끝내 못 얻으면 **빈 문자열을 돌려주고 호출자가 그 사실을 기록하게 한다.**
   * 조용히 "요소 없음"으로 넘어가면 탐색이 아무것도 못 본 채 끝난다.
   */
  dumpUi(attempts = 3): string {
    for (let i = 0; i < attempts; i += 1) {
      const dumped = this.shell(["uiautomator", "dump", "/sdcard/qa-ui.xml"]);
      if (/dumped to|UI hier[ac]rchy/i.test(dumped.stdout + dumped.stderr)) break;
      this.sleep(800);
    }
    const xml = this.shell(["cat", "/sdcard/qa-ui.xml"], 20_000).stdout;
    // 대상 기기에 우리 흔적을 남기지 않는다.
    this.shell(["rm", "-f", "/sdcard/qa-ui.xml"]);
    return xml.includes("<hierarchy") ? xml : "";
  }

  screenshot(localPath: string): boolean {
    this.shell(["screencap", "-p", "/sdcard/qa-shot.png"], 20_000);
    const ok = this.pull("/sdcard/qa-shot.png", localPath);
    this.shell(["rm", "-f", "/sdcard/qa-shot.png"]);
    return ok;
  }

  tap(x: number, y: number): void {
    this.shell(["input", "tap", String(x), String(y)]);
  }

  back(): void {
    this.shell(["input", "keyevent", "KEYCODE_BACK"]);
  }

  swipe(x1: number, y1: number, x2: number, y2: number, ms = 300): void {
    this.shell(["input", "swipe", String(x1), String(y1), String(x2), String(y2), String(ms)]);
  }

  /** 현재 포그라운드 패키지/액티비티. 앱 밖으로 나갔는지 판정하는 근거다. */
  currentFocus(): string {
    const out = this.shell(["dumpsys", "window"], 20_000).stdout;
    return (
      /mCurrentFocus=Window\{[^}]*\s+([\w.]+\/[\w.$]+)/.exec(out)?.[1] ??
      /mCurrentFocus=.*?([\w.]+\.[\w.]+)\//.exec(out)?.[1] ??
      "unknown"
    );
  }

  launch(packageName: string): void {
    this.shell([
      "monkey",
      "-p",
      packageName,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ]);
  }

  isInstalled(packageName: string): boolean {
    const out = this.shell(["pm", "list", "packages", packageName]).stdout;
    return out.split(/\r?\n/).some((l) => l.trim() === `package:${packageName}`);
  }

  /** 화면 크기. 스와이프 좌표를 기기에 맞추기 위해 필요하다. */
  screenSize(): { width: number; height: number } | null {
    const out = this.shell(["wm", "size"]).stdout;
    const m = /(\d+)x(\d+)/.exec(out);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  }

  clearLogcat(): void {
    this.run(["logcat", "-c"]);
  }

  /** 마지막 호출 이후의 로그. 전체를 다시 읽지 않도록 마커를 들고 다닌다. */
  logcatSince(marker: string | null): { lines: string[]; marker: string | null } {
    const out = this.run(["logcat", "-d", "-v", "time"], 30_000).stdout;
    const all = out.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (all.length === 0) return { lines: [], marker };

    let fresh = all;
    if (marker !== null) {
      const at = all.lastIndexOf(marker);
      if (at >= 0) fresh = all.slice(at + 1);
    }
    return { lines: fresh, marker: all[all.length - 1] ?? null };
  }

  sleep(ms: number): void {
    // 동기 대기. 탐색 루프는 한 번에 하나씩만 하므로 이벤트 루프를 막아도 문제가 없고,
    // 이 편이 "탭 → 화면 전환 대기 → 관찰" 순서를 읽기 쉽게 만든다.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}
