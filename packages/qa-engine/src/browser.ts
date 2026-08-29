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

/**
 * esbuild(tsx·vitest)의 `keepNames` 변환은 이름 있는 함수를 `__name(fn, "이름")` 으로 감싼다.
 * 그 코드가 `page.evaluate`로 브라우저에 넘어가면 `__name`이 없어 ReferenceError로 죽는다.
 *
 * 빌드 설정으로 끄는 것보다 페이지 쪽에 항등 함수를 하나 놔두는 편이 확실하다 —
 * tsx로 실행하든 tsc로 빌드해 실행하든 똑같이 동작한다.
 */
function installEsbuildNameShim(): void {
  const g = globalThis as unknown as { __name?: (fn: unknown) => unknown };
  g.__name ??= (fn: unknown) => fn;
}

/** 콘솔 수집기가 rejection을 알아보기 위한 표식. collector.ts와 짝을 이룬다. */
export const REJECTION_MARKER = "[qa:unhandled-rejection]";

/**
 * `unhandledrejection`을 콘솔 스트림에 표식과 함께 흘린다.
 *
 * Playwright의 `pageerror`는 uncaught exception과 promise rejection을 구별해 주지 않아서,
 * 페이지 쪽에서 직접 표시해 주지 않으면 둘을 나눌 방법이 없다.
 * (같은 오류가 pageerror로도 한 번 오므로 collector가 중복을 합친다)
 */
function installRejectionReporter(): void {
  const MARKER = "[qa:unhandled-rejection]";
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as { message?: string } | undefined;
    const message = reason?.message ?? String(event.reason);
    console.error(`${MARKER} ${message}`);
  });
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

  await context.addInitScript(installEsbuildNameShim);
  await context.addInitScript(installRejectionReporter);

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
