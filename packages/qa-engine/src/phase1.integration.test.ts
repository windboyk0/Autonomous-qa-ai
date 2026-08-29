import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "@qa/fixture-admin";
import { RunConfig } from "@qa/shared";
import { RunContext, makeRunId } from "./run-context.js";
import { registerSecret } from "./emitter.js";
import { runQa } from "./run.js";

/**
 * Phase 1 DoD.
 *
 *   fixture 로그인 성공 + runs/ 트리 생성 + 증적 어디에도 비밀번호가 남지 않음
 *
 * 실제 Chromium을 띄운다. `pnpm exec playwright install chromium` 이 선행되어야 한다.
 */

const PASSWORD = "admin123!";
const WRONG_PASSWORD = "definitely-wrong-9182";

let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
let outDir: string;

/** 디렉터리 아래 모든 파일 경로를 평평하게 편다. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * Phase 1이 보는 것은 로그인과 증적 수집까지다.
 * `runQa`는 Phase 2부터 전체 탐색까지 하므로, 여기서는 예산을 최소로 묶어
 * 로그인 직후 화면 몇 개만 보고 끝내게 한다. (탐색 자체는 phase2 테스트가 본다)
 */
function makeConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return RunConfig.parse({
    projectName: "fixture",
    targetUrl: fixture.url,
    headless: true,
    login: { enabled: true, username: "admin", password: PASSWORD },
    budget: { maxScreens: 2, settleMs: 100 },
    ...overrides,
  });
}

beforeAll(async () => {
  fixture = await startFixtureServer(0); // 0 = OS가 빈 포트를 준다
  outDir = join(tmpdir(), `qa-phase1-${Date.now()}`);
  registerSecret(PASSWORD);
  registerSecret(WRONG_PASSWORD);
}, 30_000);

afterAll(async () => {
  await fixture.close();
  rmSync(outDir, { recursive: true, force: true });
});

describe("Phase 1 — 로그인 + 증적 수집", () => {
  let ctx: RunContext;
  let outcome: Awaited<ReturnType<typeof runQa>>;

  beforeAll(async () => {
    ctx = new RunContext(makeRunId(), outDir, ".");
    outcome = await runQa(makeConfig(), ctx);
  }, 300_000);

  it("로그인에 성공하고 Run이 완료된다", () => {
    expect(outcome.status).toBe("COMPLETED");
  });

  it("로그인 판정 근거가 기록된다", () => {
    const login = JSON.parse(readFileSync(join(ctx.runDir, "actions", "login.json"), "utf8"));
    expect(login.success).toBe(true);
    expect(login.landedUrl).toContain("/dashboard");
    expect(login.signals).toMatchObject({ urlChanged: true, formGone: true, newCookie: true });
  });

  /**
   * 인증 API 응답이 **가장 믿을 만한 신호다.**
   * 실측: 토큰 기반 SPA에서 `POST /auth/login → 200` 으로 성공했는데
   * 쿠키·URL·폼 신호가 모두 거짓이라 실패로 오판한 적이 있다.
   */
  it("인증 API 응답을 신호로 기록한다", () => {
    const login = JSON.parse(readFileSync(join(ctx.runDir, "actions", "login.json"), "utf8"));
    expect(login.signals.authOk).toBe(true);
    expect(login.signals.authRejected).toBe(false);
    expect(login.signals.authStatus).toBeGreaterThanOrEqual(200);
    expect(login.signals.authStatus).toBeLessThan(400);
  });

  it("증적 트리가 만들어진다", () => {
    const files = walk(ctx.runDir).map((f) => f.replace(ctx.runDir, "").replace(/\\/g, "/"));
    for (const sub of ["/screenshots/", "/dom/", "/aria/", "/network/", "/console/", "/actions/"]) {
      expect(files.some((f) => f.startsWith(sub)), `${sub} 증적 없음`).toBe(true);
    }
  });

  it("증적 색인의 모든 path가 실제 파일을 가리킨다", () => {
    const index = JSON.parse(readFileSync(join(ctx.runDir, "evidence.json"), "utf8"));
    expect(index.evidences.length).toBeGreaterThan(0);
    for (const ev of index.evidences) {
      if (ev.path === null) continue;
      expect(() => statSync(join(ctx.runDir, ev.path)), `깨진 링크: ${ev.path}`).not.toThrow();
    }
  });

  /** Phase 1의 핵심 DoD. 이 테스트가 깨지면 어떤 이유로도 머지하지 않는다. */
  it("증적 어디에도 비밀번호가 남지 않는다", () => {
    const hits: string[] = [];
    for (const file of walk(ctx.runDir)) {
      if (/\.(png|jpg|jpeg)$/i.test(file)) continue; // 바이너리는 텍스트 검색 대상이 아니다
      if (readFileSync(file, "utf8").includes(PASSWORD)) hits.push(file);
    }
    expect(hits, `비밀번호가 남은 파일: ${hits.join(", ")}`).toEqual([]);
  });

  it("로그인 화면 DOM에 password 필드 값이 비어 있다", () => {
    const domFile = walk(join(ctx.runDir, "dom")).find((f) => f.includes("로그인"));
    expect(domFile).toBeDefined();
    const html = readFileSync(domFile!, "utf8");
    expect(html).toMatch(/type="password"/);
    expect(html).not.toContain(PASSWORD);
  });

  it("BUG-02(공지 뱃지 404)가 네트워크 증적에 잡힌다", () => {
    const entries = walk(join(ctx.runDir, "network")).flatMap(
      (f) => JSON.parse(readFileSync(f, "utf8")) as Array<{ endpointTemplate: string; status: number | null; ok: boolean }>,
    );
    const badge = entries.find((e) => e.endpointTemplate === "/api/notice/badge");
    expect(badge?.status).toBe(404);
    expect(badge?.ok).toBe(false);
  });

  it("정상 리다이렉트(302)를 실패로 세지 않는다", () => {
    const entries = walk(join(ctx.runDir, "network")).flatMap(
      (f) => JSON.parse(readFileSync(f, "utf8")) as Array<{ status: number | null; ok: boolean }>,
    );
    const redirects = entries.filter((e) => e.status !== null && e.status >= 300 && e.status < 400);
    expect(redirects.length).toBeGreaterThan(0);
    expect(redirects.every((e) => e.ok)).toBe(true);
  });

  it("BUG-04(처리되지 않은 rejection)가 콘솔 증적에 잡힌다", () => {
    const entries = walk(join(ctx.runDir, "console")).flatMap(
      (f) => JSON.parse(readFileSync(f, "utf8")) as Array<{ text: string; level: string }>,
    );
    expect(entries.some((e) => e.text.includes("dashboard widget init failed"))).toBe(true);
  });

  it("네트워크에서 이미 잡은 404를 콘솔에서 중복으로 세지 않는다", () => {
    const entries = walk(join(ctx.runDir, "console")).flatMap(
      (f) => JSON.parse(readFileSync(f, "utf8")) as Array<{ text: string }>,
    );
    expect(entries.some((e) => /^Failed to load resource/.test(e.text))).toBe(false);
  });

  it("민감 헤더가 마스킹된다", () => {
    const entries = walk(join(ctx.runDir, "network")).flatMap(
      (f) =>
        JSON.parse(readFileSync(f, "utf8")) as Array<{
          requestHeaders: Record<string, string>;
          responseHeaders: Record<string, string>;
        }>,
    );
    const withCookie = entries.filter(
      (e) => "cookie" in e.requestHeaders || "set-cookie" in e.responseHeaders,
    );
    expect(withCookie.length, "쿠키가 오간 요청이 하나도 없다면 테스트가 무의미하다").toBeGreaterThan(0);
    for (const e of withCookie) {
      if (e.requestHeaders.cookie !== undefined) {
        expect(e.requestHeaders.cookie).toBe("***REDACTED***");
      }
      if (e.responseHeaders["set-cookie"] !== undefined) {
        expect(e.responseHeaders["set-cookie"]).toBe("***REDACTED***");
      }
    }
  });
});

describe("Phase 1 — 로그인 실패 경로", () => {
  it("잘못된 비밀번호면 FAILED로 끝나고 실패 화면 증적을 남긴다", async () => {
    const ctx = new RunContext(makeRunId(new Date(Date.now() + 1000)), outDir, ".");
    const outcome = await runQa(
      makeConfig({ login: { enabled: true, username: "admin", password: WRONG_PASSWORD } }),
      ctx,
    );

    expect(outcome.status).toBe("FAILED");

    const login = JSON.parse(readFileSync(join(ctx.runDir, "actions", "login.json"), "utf8"));
    expect(login.success).toBe(false);

    /**
     * 서버가 거절한 것과 "아무 반응이 없는 것"은 사용자가 취할 조치가 다르다.
     * 전자는 계정을 확인하면 되고, 후자는 로그인 방식을 의심해야 한다.
     * 그래서 상태 코드를 그대로 알려준다.
     */
    expect(login.signals.authRejected).toBe(true);
    expect(login.signals.authStatus).toBe(401);
    expect(login.reason).toContain("거절");
    expect(login.reason).toContain("401");

    const shots = walk(join(ctx.runDir, "screenshots")).map((f) => f.replace(/\\/g, "/"));
    expect(shots.some((f) => f.includes("로그인실패"))).toBe(true);

    for (const file of walk(ctx.runDir)) {
      if (/\.(png|jpg|jpeg)$/i.test(file)) continue;
      expect(readFileSync(file, "utf8"), `${file} 에 비밀번호 노출`).not.toContain(WRONG_PASSWORD);
    }
  }, 300_000);
});
