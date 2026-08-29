import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { RunConfig } from "@qa/shared";

/**
 * Playwright 기동.
 *
 * Phase 7에서 Chromium 번들링 방침이 정해지면 executablePath만 여기서 바꾸면 되도록
 * 실행 경로 결정을 한 곳에 모아둔다.
 */

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export async function launch(config: RunConfig): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless: config.headless });

  const context = await browser.newContext({
    viewport: config.viewport,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    // 대상이 사내 개발 서버인 경우가 많아 자체 서명 인증서를 허용한다.
    ignoreHTTPSErrors: true,
  });
  context.setDefaultTimeout(config.budget.navigationTimeoutMs);
  context.setDefaultNavigationTimeout(config.budget.navigationTimeoutMs);

  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    async close() {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}

/** Chromium이 설치되어 있는지 확인한다. 없으면 사용자가 할 일을 알려준다. */
export async function preflightBrowser(): Promise<{ ok: boolean; remediation: string | null }> {
  try {
    const b = await chromium.launch({ headless: true });
    await b.close();
    return { ok: true, remediation: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|playwright install/i.test(msg)) {
      return {
        ok: false,
        remediation: "Chromium이 설치되지 않았습니다. `pnpm exec playwright install chromium` 을 실행하세요.",
      };
    }
    return { ok: false, remediation: `브라우저 기동 실패: ${msg}` };
  }
}
