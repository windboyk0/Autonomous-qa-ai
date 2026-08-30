import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

/**
 * 실측 회귀 — 소스 QA 를 화면에서 끝까지.
 *
 * 소스 QA 를 고르고 시작하면 엔진이 종료 코드 2 로 죽었다. 화면에는
 * "엔진이 비정상 종료했습니다" 만 보였다. 단위 테스트로는 잡히지 않는 자리라
 * (화면 → IPC → 인자 → 엔진 전체가 이어져야 드러난다) 여기서 실제로 눌러 본다.
 */

const APP_ROOT = resolve(import.meta.dirname, "..");
const FIXTURE_SRC = resolve(APP_ROOT, "..", "..", "packages", "fixture-src", "project");

let app: ElectronApplication;
let page: Page;
let userData: string;

beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "qa-src-e2e-"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // VS Code 에서 물려받은 이 변수가 남아 있으면 Electron 이 노드로 뜬다.
    if (k === "ELECTRON_RUN_AS_NODE") continue;
    if (v !== undefined) env[k] = v;
  }
  app = await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userData}`],
    cwd: APP_ROOT,
    env,
  });
  page = await app.firstWindow();
  await page.waitForSelector('[data-testid="nav-projects"]', { timeout: 60_000 });
}, 120_000);

afterAll(async () => {
  await app?.close();
  rmSync(userData, { recursive: true, force: true });
});

describe("소스 QA — 화면에서 끝까지", () => {
  it("폴더만 주고 시작하면 결함이 나온다", async () => {
    await page.click('[data-testid="nav-projects"]');
    await page.click('[data-testid="project-new"]');
    await page.waitForSelector('[data-testid="mode-source"]');

    await page.check('[data-testid="mode-source"]');
    await page.fill('[data-testid="cfg-source-dir"]', FIXTURE_SRC);
    await page.fill('[data-testid="cfg-name"]', "소스 QA 검증");

    // 소스 모드에는 URL·로그인 입력이 아예 없어야 한다.
    expect(await page.locator('[data-testid="cfg-url"]').count()).toBe(0);

    const start = page.locator('[data-testid="start-qa"]');
    await expect.poll(() => start.isEnabled(), { timeout: 15_000 }).toBe(true);
    await start.click();

    // 크래시 배너가 뜨면 그 자리에서 실패시킨다 — 이것이 원래 증상이었다.
    const crash = page.locator('[data-testid="crash-banner"]');
    await expect
      .poll(
        async () => {
          if ((await crash.count()) > 0) return "crashed";
          return await page.locator('[data-testid="run-status"]').innerText();
        },
        { timeout: 180_000, interval: 1000 },
      )
      .toBe("COMPLETED");

    await page.click('[data-testid="goto-report"]');
    await page.waitForSelector('[data-testid="report-body"]', { timeout: 30_000 });
    const report = await page.locator('[data-testid="report-body"]').innerText();

    expect(report).toContain("소스 QA (프로젝트 폴더)");
    expect(report).toContain("권한 검사가 없는 엔드포인트");
    expect(report).toContain("**관련 소스**");
    // 시크릿 값은 어디에도 실리지 않는다.
    expect(report).not.toContain("CHANGE_ME_fixture_only");
  }, 300_000);
});
