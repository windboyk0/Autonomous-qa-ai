import type { Page } from "playwright";
import type { Evidence } from "@qa/shared";
import type { Collector } from "./collector.js";
import { RunContext } from "./run-context.js";
import { log } from "./emitter.js";

/**
 * Evidence Agent (캡처부).
 *
 * 한 화면에 대해 screenshot / dom / aria / console / network 를 한 묶음으로 남긴다.
 *
 * 개별 캡처 실패는 절대 위로 던지지 않는다. 스크린샷 1장 실패로 탐색이 멈추면 안 된다.
 */

export interface CaptureOptions {
  /** 비밀번호가 입력된 상태의 화면은 찍지 않는다. 찍기 전에 비운다. */
  clearPasswordFields?: boolean;
  fullPage?: boolean;
}

/** DOM에서 script/style 내용을 제거한다. 원본의 1/5 이하로 줄고 토큰·디스크를 아낀다. */
async function sanitizedHtml(page: Page): Promise<string> {
  return page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    for (const el of Array.from(clone.querySelectorAll("script, style"))) {
      el.textContent = "";
    }
    for (const el of Array.from(clone.querySelectorAll("input[type=password]"))) {
      el.setAttribute("value", "");
    }
    return "<!doctype html>\n" + clone.outerHTML;
  });
}

export async function captureScreen(
  page: Page,
  ctx: RunContext,
  collector: Collector,
  screen: { stateKey: string; screenName: string },
  options: CaptureOptions = {},
): Promise<Evidence[]> {
  const seq = ctx.nextSeq();
  const slug = RunContext.slug(screen.screenName);
  const base = `${seq}-${slug}`;
  const made: Evidence[] = [];

  if (options.clearPasswordFields) {
    // 스크린샷에 비밀번호가 찍히는 것을 막는다. 실패해도 진행한다.
    await page
      .evaluate(() => {
        for (const el of Array.from(document.querySelectorAll("input[type=password]"))) {
          (el as HTMLInputElement).value = "";
        }
      })
      .catch(() => undefined);
  }

  // ── screenshot ──────────────────────────────────────────────────────
  try {
    const buf = await page.screenshot({ fullPage: false });
    const rel = ctx.writeBinary("screenshots", `${base}.png`, buf);
    made.push(
      ctx.addEvidence({
        kind: "screenshot",
        ...screen,
        path: rel,
        summary: `${screen.screenName} viewport 스크린샷`,
      }),
    );
  } catch (err) {
    log("warn", `스크린샷 실패 (${screen.screenName}): ${String(err)}`);
  }

  if (options.fullPage !== false) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const rel = ctx.writeBinary("screenshots", `${base}.full.png`, buf);
      made.push(
        ctx.addEvidence({
          kind: "screenshot",
          ...screen,
          path: rel,
          summary: `${screen.screenName} 전체 페이지 스크린샷`,
        }),
      );
    } catch (err) {
      log("warn", `전체 스크린샷 실패 (${screen.screenName}): ${String(err)}`);
    }
  }

  // ── dom ─────────────────────────────────────────────────────────────
  try {
    const html = await sanitizedHtml(page);
    const rel = ctx.writeText("dom", `${base}.html`, html);
    made.push(
      ctx.addEvidence({
        kind: "dom",
        ...screen,
        path: rel,
        summary: `DOM ${html.length.toLocaleString()}자 (script/style 내용 제거)`,
      }),
    );
  } catch (err) {
    log("warn", `DOM 저장 실패 (${screen.screenName}): ${String(err)}`);
  }

  // ── aria ────────────────────────────────────────────────────────────
  try {
    const aria = await page.locator("body").ariaSnapshot();
    const rel = ctx.writeText("aria", `${base}.yaml`, aria);
    made.push(
      ctx.addEvidence({
        kind: "aria",
        ...screen,
        path: rel,
        summary: `ARIA 스냅샷 ${aria.split("\n").length}줄`,
      }),
    );
  } catch (err) {
    log("warn", `ARIA 스냅샷 실패 (${screen.screenName}): ${String(err)}`);
  }

  // ── console / network ───────────────────────────────────────────────
  const drained = collector.drain(screen);

  if (drained.console.length > 0) {
    const rel = ctx.writeJson("console", `${base}.json`, drained.console);
    const errors = drained.console.filter((c) => c.level === "error").length;
    made.push(
      ctx.addEvidence({
        kind: "console",
        ...screen,
        path: rel,
        summary: `콘솔 ${drained.console.length}건 (error ${errors}건)`,
      }),
    );
  }

  if (drained.network.length > 0) {
    const rel = ctx.writeJson("network", `${base}.json`, drained.network);
    const bad = drained.network.filter((n) => !n.ok).length;
    made.push(
      ctx.addEvidence({
        kind: "network",
        ...screen,
        path: rel,
        summary: `요청 ${drained.network.length}건 (실패 ${bad}건)`,
      }),
    );
  }

  return made;
}
