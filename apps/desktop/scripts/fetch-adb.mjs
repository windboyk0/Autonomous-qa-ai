import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

/**
 * Android platform-tools(adb) 내려받기.
 *
 * 앱 QA 는 adb 없이는 한 줄도 못 돈다. Chromium 을 동봉한 것과 같은 이유로 adb 도 동봉한다 —
 * 사용자가 SDK 를 따로 깔고 PATH 를 잡아야 한다면 "설치 후 5분 내 QA 시작"이 깨진다.
 *
 * 저장소에는 넣지 않는다(10MB 바이너리). 여기서 한 번 받아 캐시에 두고,
 * 스테이징이 그것을 설치본으로 복사한다. Playwright 브라우저를 다루는 방식과 같다.
 */

const URL = "https://dl.google.com/android/repository/platform-tools-latest-windows.zip";

/** Windows 에서 adb 가 실제로 필요로 하는 파일. 나머지(fastboot 등)는 넣지 않는다. */
const NEEDED = ["adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll"];

const here = import.meta.dirname;
const cacheRoot = resolve(here, "..", "vendor", "platform-tools");

function hasAll(dir) {
  return NEEDED.every((f) => existsSync(join(dir, f)));
}

async function download(url, to) {
  mkdirSync(dirname(to), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`내려받기 실패: HTTP ${res.status} ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(to));
  return statSync(to).size;
}

/**
 * zip 을 푼다.
 *
 * `tar` 를 그냥 부르면 안 된다 — Git Bash 의 GNU tar 가 먼저 잡히는데 그것은 zip 을
 * 풀지 못한다(실측: 종료 코드 128). Windows 기본 bsdtar 를 절대 경로로 부르고,
 * 없으면 PowerShell 로 넘어간다.
 */
function unzip(zip, into) {
  mkdirSync(into, { recursive: true });

  const bsdtar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  if (existsSync(bsdtar)) {
    execFileSync(bsdtar, ["-xf", zip, "-C", into], { stdio: "ignore" });
    return;
  }

  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${into}' -Force`,
    ],
    { stdio: "ignore" },
  );
}

if (hasAll(cacheRoot)) {
  console.log(`[adb] 이미 있음: ${cacheRoot}`);
  process.exit(0);
}

const tmp = join(cacheRoot, "..", "platform-tools.zip");
console.log(`[adb] 내려받는 중: ${URL}`);
const bytes = await download(URL, tmp);
console.log(`[adb] ${Math.round(bytes / 1024 / 1024)}MB 받음`);

const extractTo = join(cacheRoot, "..", "_extract");
rmSync(extractTo, { recursive: true, force: true });
unzip(tmp, extractTo);

// zip 안은 platform-tools/ 한 겹이다.
const inner = join(extractTo, "platform-tools");
const src = existsSync(inner) ? inner : extractTo;

rmSync(cacheRoot, { recursive: true, force: true });
mkdirSync(cacheRoot, { recursive: true });
for (const name of readdirSync(src)) {
  if (!NEEDED.includes(name)) continue;
  renameSync(join(src, name), join(cacheRoot, name));
}

rmSync(extractTo, { recursive: true, force: true });
rmSync(tmp, { force: true });

if (!hasAll(cacheRoot)) {
  throw new Error(`[adb] 필요한 파일을 모두 얻지 못했습니다: ${NEEDED.join(", ")}`);
}

const total = NEEDED.reduce((sum, f) => sum + statSync(join(cacheRoot, f)).size, 0);
console.log(`[adb] 준비 완료: ${cacheRoot} (${NEEDED.length}개 · ${Math.round(total / 1024 / 1024)}MB)`);
