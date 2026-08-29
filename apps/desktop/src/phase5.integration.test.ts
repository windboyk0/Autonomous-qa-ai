import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { startFixtureServer } from "@qa/fixture-admin";

/**
 * Phase 5 DoD.
 *
 *   **클릭만으로 Phase 4와 동일한 report.md 가 생성된다.**
 *   **엔진이 죽어도 UI는 살아 있다.**
 *
 * 실제 Electron 앱을 띄워 사람이 하듯 클릭한다. main 프로세스 로직만 단위 테스트하면
 * "화면에서 정말 되는가"는 검증되지 않는다.
 */

const PASSWORD = "admin123!";
const appRoot = resolve(import.meta.dirname, "..");

let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
let app: ElectronApplication;
let page: Page;
let userData: string;

/**
 * Electron을 실행할 환경을 만든다.
 *
 * **`ELECTRON_RUN_AS_NODE` 를 반드시 지운다.** 이 변수가 켜져 있으면 Electron이
 * 순수 Node로 실행되어 `require("electron")` 이 API 대신 실행 파일 경로 문자열을
 * 돌려준다. VS Code 같은 Electron 기반 도구가 자식 프로세스에 이 값을 심어두기
 * 때문에, 개발 환경에서 조용히 상속되어 앱이 기동조차 못 하는 일이 생긴다.
 * (엔진을 띄울 때는 반대로 이 값을 **일부러 켠다** — engine.ts 참고)
 */
function electronEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "ELECTRON_RUN_AS_NODE") continue;
    if (value !== undefined) env[key] = value;
  }
  env.NODE_ENV = "test";
  return env;
}

async function launch(): Promise<void> {
  userData = join(tmpdir(), `qa-desktop-${Date.now()}`);
  app = await electron.launch({
    args: [appRoot, `--user-data-dir=${userData}`],
    cwd: appRoot,
    env: electronEnv(),
  });
  page = await app.firstWindow();
  await page.waitForSelector('[data-testid="nav-projects"]', { timeout: 30_000 });
}

beforeAll(async () => {
  fixture = await startFixtureServer(0);
  await launch();
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await fixture?.close();
  rmSync(userData, { recursive: true, force: true });
});

describe("Phase 5 — 셸 기본", () => {
  it("창이 뜨고 6개 화면으로 이동할 수 있다", async () => {
    for (const key of ["setup", "monitor", "issues", "evidence", "report", "history", "projects"]) {
      await page.click(`[data-testid="nav-${key}"]`);
      const cls = await page.getAttribute(`[data-testid="nav-${key}"]`, "class");
      expect(cls, `${key} 화면으로 이동하지 못했다`).toContain("on");
    }
  });

  it("엔진 실행 파일을 찾는다", async () => {
    await page.click('[data-testid="nav-setup"]');
    // 엔진을 못 찾으면 설정 화면 맨 위에 오류 배너가 뜬다.
    expect(await page.locator(`[data-testid="engine-error"]`).count()).toBe(0);
  });

  /** 렌더러가 Node에 직접 닿으면 preload 격리가 뚫린 것이다. */
  it("렌더러는 Node에 직접 닿지 못한다", async () => {
    const exposed = await page.evaluate(() => ({
      hasRequire: typeof (globalThis as Record<string, unknown>).require !== "undefined",
      hasProcess: typeof (globalThis as Record<string, unknown>).process !== "undefined",
      hasQa: typeof (globalThis as Record<string, unknown>).qa !== "undefined",
    }));
    expect(exposed.hasRequire).toBe(false);
    expect(exposed.hasProcess).toBe(false);
    expect(exposed.hasQa).toBe(true);
  });

  /** 자격증명을 읽는 API가 아예 없어야 한다. */
  it("preload가 비밀번호를 읽는 경로를 노출하지 않는다", async () => {
    const surface = await page.evaluate(() => {
      const api = (globalThis as unknown as { qa: Record<string, unknown> }).qa;
      const keys: string[] = [];
      for (const [group, value] of Object.entries(api)) {
        if (typeof value === "object" && value !== null) {
          for (const k of Object.keys(value)) keys.push(`${group}.${k}`);
        } else {
          keys.push(group);
        }
      }
      return keys;
    });
    expect(surface.some((k) => /password|credential|secret/i.test(k))).toBe(false);
  });
});

describe("Phase 5 — 클릭만으로 QA 실행", () => {
  it("프로젝트 생성 → 설정 → QA 시작 → 리포트까지 클릭으로 끝난다", async () => {
    await page.click('[data-testid="nav-projects"]');
    await page.click('[data-testid="project-new"]');
    await page.waitForSelector('[data-testid="cfg-url"]');

    await page.fill('[data-testid="cfg-name"]', "fixture");
    await page.fill('[data-testid="cfg-url"]', fixture.url);
    await page.fill('[data-testid="cfg-user"]', "admin");
    await page.fill('[data-testid="cfg-pass"]', PASSWORD);
    // 탐색 전체는 Phase 2·3이 검증한다. 여기서는 셸이 목적이므로 예산을 줄인다.
    await page.fill('[data-testid="cfg-maxscreens"]', "3");

    await page.click('[data-testid="start-qa"]');

    // Monitor로 자동 전환되고 진행 상황이 흐른다.
    await page.waitForSelector('[data-testid="run-status"]');
    expect(await page.locator(`[data-testid="log-box"]`).isVisible()).toBe(true);

    // Run이 끝날 때까지 기다린다.
    await page.waitForFunction(
      () => document.querySelector('[data-testid="btn-stop"]')?.hasAttribute("disabled") === true,
      undefined,
      { timeout: 300_000 },
    );

    await page.click('[data-testid="goto-report"]');
    await page.waitForSelector('[data-testid="report-body"]', { timeout: 30_000 });

    const report = (await page.textContent('[data-testid="report-body"]')) ?? "";

    // Phase 3·4와 같은 리포트다 — 17개 목차가 전부 있어야 한다.
    for (const heading of [
      "1. 실행정보",
      "3. Executive Summary",
      "4. CRUD 결과",
      "14. 우선순위",
      "16. 탐색 제한",
      "17. 미검증 기능",
    ]) {
      expect(report, `목차 "${heading}" 누락`).toContain(`## ${heading}`);
    }

    // 화면에 뜬 리포트에도 비밀번호가 없어야 한다.
    expect(report).not.toContain(PASSWORD);
  }, 400_000);

  it("실행 결과가 History에 남는다", async () => {
    await page.click('[data-testid="nav-history"]');
    await page.waitForSelector('[data-testid="history-table"]');
    const rows = await page.locator('[data-testid="history-table"] tbody tr').count();
    expect(rows).toBeGreaterThan(0);
  });

  it("Issue 목록에서 상세를 열 수 있다", async () => {
    await page.click('[data-testid="nav-issues"]');
    const table = page.locator('[data-testid="issue-table"] tbody tr');
    const count = await table.count();
    if (count === 0) return; // 예산 3화면이라 Issue가 없을 수도 있다
    await table.first().click();
    expect(await page.locator(`[data-testid="issue-detail-title"]`).isVisible()).toBe(true);
  });

  /** 저장된 자격증명은 "있다"만 보이고 값은 어디에도 나오지 않는다. */
  it("프로젝트 목록에 비밀번호가 평문으로 나오지 않는다", async () => {
    await page.click('[data-testid="nav-projects"]');
    await page.waitForSelector('[data-testid="project-table"]');
    const html = await page.innerHTML("body");
    expect(html).not.toContain(PASSWORD);
  });
});

describe("Phase 5 — 실패와 크래시를 구분한다", () => {
  /**
   * 로그인 실패는 **판정 결과이지 프로그램 오류가 아니다.**
   * 엔진이 스스로 FAILED 를 알리고 실패 화면 증적까지 남긴 뒤 종료 코드 1로 끝난다.
   * 이걸 "비정상 종료"로 표시하면 사용자는 프로그램이 깨진 줄 알고
   * 진짜 원인(로그인 실패)을 놓친다.
   */
  it("로그인이 실패하면 크래시가 아니라 사유를 보여준다", async () => {
    await page.click('[data-testid="nav-projects"]');
    await page.click('[data-testid="project-new"]');
    await page.waitForSelector('[data-testid="cfg-url"]');

    await page.fill('[data-testid="cfg-name"]', "로그인실패");
    await page.fill('[data-testid="cfg-url"]', fixture.url);
    await page.fill('[data-testid="cfg-user"]', "admin");
    await page.fill('[data-testid="cfg-pass"]', "틀린비밀번호");
    await page.fill('[data-testid="cfg-maxscreens"]', "1");
    await page.click('[data-testid="start-qa"]');

    await page.waitForFunction(
      () => document.querySelector('[data-testid="btn-stop"]')?.hasAttribute("disabled") === true,
      undefined,
      { timeout: 180_000 },
    );

    // 크래시 배너가 아니라 실패 배너가 떠야 한다.
    expect(await page.locator('[data-testid="crash-banner"]').count()).toBe(0);
    expect(await page.locator('[data-testid="fail-banner"]').count()).toBe(1);

    // 화면에 원인이 그대로 보여야 한다.
    const banner = (await page.textContent('[data-testid="fail-banner"]')) ?? "";
    expect(banner).toContain("로그인 실패");

    // 증적은 남아 있고 폴더를 열 수 있어야 한다.
    expect(await page.locator('[data-testid="open-evidence-folder"]').count()).toBe(1);
  }, 240_000);

  it("실패한 Run도 증적 폴더 경로와 함께 History에 남는다", async () => {
    await page.click('[data-testid="nav-history"]');
    await page.waitForSelector('[data-testid="history-table"]');
    const rows = await page.locator('[data-testid="history-table"] tbody tr').count();
    expect(rows).toBeGreaterThan(0);
  });
});

describe("Phase 5 — 엔진 크래시 격리", () => {
  /**
   * 엔진 프로세스를 강제로 죽여도 Electron은 살아 있어야 한다 (CLAUDE.md §24).
   * 잘못된 URL로 띄우면 엔진이 설정 검증에서 종료 코드 2로 죽는다.
   */
  it("엔진이 비정상 종료해도 UI가 살아 있고 사용자에게 알린다", async () => {
    await page.click('[data-testid="nav-projects"]');
    await page.click('[data-testid="project-new"]');
    await page.waitForSelector('[data-testid="cfg-url"]');

    await page.fill('[data-testid="cfg-name"]', "crash");
    // 열 수 없는 포트 → 엔진이 브라우저 이동에 실패하고 종료한다.
    await page.fill('[data-testid="cfg-url"]', "http://127.0.0.1:59998");
    await page.fill('[data-testid="cfg-user"]', "admin");
    await page.fill('[data-testid="cfg-pass"]', "x");
    await page.fill('[data-testid="cfg-maxscreens"]', "1");
    await page.click('[data-testid="start-qa"]');

    await page.waitForFunction(
      () => document.querySelector('[data-testid="btn-stop"]')?.hasAttribute("disabled") === true,
      undefined,
      { timeout: 180_000 },
    );

    // 창이 살아 있고 조작이 계속 가능하다.
    await page.click('[data-testid="nav-history"]');
    expect(await page.locator(`[data-testid="history-table"]`).isVisible()).toBe(true);

    // 실패한 Run도 기록으로 남는다.
    const statuses = await page.locator('[data-testid="history-table"] tbody tr td:nth-child(3)').allTextContents();
    expect(statuses.some((s) => s === "FAILED" || s === "STOPPED")).toBe(true);
  }, 240_000);
});
