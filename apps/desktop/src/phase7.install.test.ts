import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { startFixtureServer } from "@qa/fixture-admin";

/**
 * Phase 7 DoD — 설치본 검증.
 *
 *   **설치 후 5분 이내에 QA를 시작할 수 있다.**
 *   Node.js도, Playwright 캐시도 없는 PC를 가정한다.
 *
 * 이 테스트는 `pnpm --filter @qa/desktop package` 로 만든 설치본을 실제로 설치한
 * 폴더를 대상으로 한다. 없으면 건너뛴다 — 설치본 빌드는 몇 분 걸리므로
 * 일상 테스트에서 매번 돌리지 않는다.
 *
 * `QA_INSTALL_DIR` 로 설치 위치를 알려준다.
 */

/**
 * 검증용 설치 위치.
 *
 * `%TEMP%` 에 두면 안 된다 — 700MB짜리 설치본이 디스크 정리 대상이 되어
 * 실측에서 설치 직후 폴더가 통째로 비워진 적이 있다.
 */
const installDir = process.env.QA_INSTALL_DIR ?? join(homedir(), "qa-install-test");
const available = existsSync(join(installDir, "resources", "engine", "cli.js"));

const PASSWORD = "admin123!";

let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
let app: ElectronApplication;
let page: Page;
let userData: string;

/**
 * **설치된 PC를 흉내 내는 환경.**
 *
 * - `PATH` 에서 Node.js를 제거한다 — 설치본은 Electron을 Node로 재사용해야 한다
 * - `PLAYWRIGHT_BROWSERS_PATH` 를 지운다 — 동봉한 브라우저를 스스로 찾아야 한다
 * - `ELECTRON_RUN_AS_NODE` 를 지운다 — 켜져 있으면 Electron이 순수 Node로 뜬다
 */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "ELECTRON_RUN_AS_NODE") continue;
    if (key === "PLAYWRIGHT_BROWSERS_PATH") continue;
    if (value === undefined) continue;
    if (key.toUpperCase() === "PATH") {
      env[key] = value
        .split(";")
        .filter((p) => !/node-v\d|nodejs|\\node\\|corepack/i.test(p))
        .join(";");
      continue;
    }
    env[key] = value;
  }
  return env;
}

/** 설치 폴더에는 언인스톨러도 함께 있다. 그걸 실행하면 앱이 지워진다. */
function exeName(): string {
  const found = readdirSync(installDir).find(
    (f) => f.endsWith(".exe") && !f.startsWith("__") && !/uninstall/i.test(f),
  );
  if (!found) throw new Error(`${installDir} 에 실행 파일이 없습니다.`);
  return found;
}

beforeAll(async () => {
  if (!available) return;
  fixture = await startFixtureServer(0);
  userData = join(tmpdir(), `qa-installed-${Date.now()}`);
  app = await electron.launch({
    executablePath: join(installDir, exeName()),
    args: [`--user-data-dir=${userData}`],
    env: cleanEnv(),
  });
  page = await app.firstWindow();
  await page.waitForSelector('[data-testid="nav-projects"]', { timeout: 60_000 });
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await fixture?.close();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

describe("Phase 7 — 설치본", () => {
  it("설치본이 존재한다", () => {
    if (!available) {
      console.log(`[skip] 설치본 없음: ${installDir} (pnpm --filter @qa/desktop package 후 설치하세요)`);
      return;
    }
    expect(existsSync(join(installDir, "resources", "browsers"))).toBe(true);
  });

  /** 사용자 PC에는 Playwright 캐시가 없다. 설치본이 스스로 브라우저를 들고 있어야 한다. */
  it("풀 크로미움이 동봉되어 있다", () => {
    if (!available) return;
    const browsers = join(installDir, "resources", "browsers");
    const dirs = readdirSync(browsers);
    expect(dirs.some((d) => /^chromium-\d+$/.test(d)), `동봉된 브라우저: ${dirs.join(", ")}`).toBe(true);

    // 헤드리스 셸은 넣지 않는다 — 풀 크로미움이 두 모드를 다 처리한다.
    expect(dirs.some((d) => d.startsWith("chromium_headless_shell"))).toBe(false);
  });

  it("엔진 번들이 CommonJS로 고정되어 있다", () => {
    if (!available) return;
    // 이 표식이 없으면 상위 package.json 의 type:module 에 걸려 실행되지 않는다.
    const marker = join(installDir, "resources", "engine", "package.json");
    expect(existsSync(marker)).toBe(true);
  });

  it("창이 뜬다", async () => {
    if (!available) return;
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });

  /**
   * Phase 7의 핵심 DoD.
   * Node.js가 PATH에 없고 Playwright 캐시도 안 보이는 상태에서 QA가 끝까지 돌아야 한다.
   */
  it("설치 직후 클릭만으로 QA가 완료되고 리포트가 나온다", async () => {
    if (!available) return;

    const started = Date.now();

    await page.click('[data-testid="nav-projects"]');
    await page.click('[data-testid="project-new"]');
    await page.waitForSelector('[data-testid="cfg-url"]');

    await page.fill('[data-testid="cfg-name"]', "설치본 검증");
    await page.fill('[data-testid="cfg-url"]', fixture.url);
    await page.fill('[data-testid="cfg-user"]', "admin");
    await page.fill('[data-testid="cfg-pass"]', PASSWORD);
    await page.fill('[data-testid="cfg-maxscreens"]', "3");

    await page.click('[data-testid="start-qa"]');
    await page.waitForSelector('[data-testid="run-status"]');

    await page.waitForFunction(
      () => document.querySelector('[data-testid="btn-stop"]')?.hasAttribute("disabled") === true,
      undefined,
      { timeout: 300_000 },
    );

    // 엔진이 죽지 않았어야 한다.
    expect(await page.locator('[data-testid="crash-banner"]').count()).toBe(0);

    await page.click('[data-testid="goto-report"]');
    await page.waitForSelector('[data-testid="report-body"]', { timeout: 30_000 });
    const report = (await page.textContent('[data-testid="report-body"]')) ?? "";

    for (const heading of ["1. 실행정보", "3. Executive Summary", "17. 미검증 기능"]) {
      expect(report, `목차 "${heading}" 누락`).toContain(`## ${heading}`);
    }
    expect(report).not.toContain(PASSWORD);

    const elapsed = (Date.now() - started) / 1000;
    console.log(`[phase7] 설치 후 QA 완료까지 ${elapsed.toFixed(0)}초`);
    expect(elapsed, "설치 후 5분 이내에 QA가 끝나야 한다").toBeLessThan(300);
  }, 400_000);

  /** 프로그램 폴더는 쓰기 권한이 없을 수 있다. 증적은 userData 로 가야 한다. */
  it("증적을 프로그램 폴더에 쓰지 않는다", () => {
    if (!available) return;
    expect(existsSync(join(installDir, "runs"))).toBe(false);
    const runs = join(userData, "runs");
    expect(existsSync(runs), `증적이 ${runs} 에 없다`).toBe(true);
    expect(readdirSync(runs).length).toBeGreaterThan(0);
  });

  it("설치 크기가 기록된 범위 안에 있다", () => {
    if (!available) return;
    let total = 0;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else total += st.size;
      }
    };
    walk(installDir);
    const mb = Math.round(total / 1024 / 1024);
    console.log(`[phase7] 설치 크기 ${mb} MB`);
    // 풀 크로미움 동봉 기준. 크게 벗어나면 무엇이 늘었는지 확인해야 한다.
    expect(mb).toBeGreaterThan(600);
    expect(mb).toBeLessThan(900);
  });
});
