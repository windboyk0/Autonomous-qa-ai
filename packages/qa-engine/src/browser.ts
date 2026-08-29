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

/**
 * 브라우저 실행 옵션.
 *
 * **`channel: "chromium"` 을 명시한다.** 기본값(`headless: true`)은 별도 바이너리인
 * `chromium_headless_shell` 을 찾는데, 설치본에는 풀 크로미움 하나만 동봉한다.
 * 셸까지 넣으면 700MB가 되고, 셸만 넣으면 헤드풀이 아예 안 된다 —
 * SSO·2FA처럼 사람이 직접 로그인해야 하는 대상은 헤드풀 없이는 검사할 수 없다.
 *
 * 실측: 풀 크로미움의 헤드리스/헤드풀과 헤드리스 셸은 레이아웃 계측값이 동일하다.
 * 셸이 주는 것은 용량과 기동 속도뿐이라 버려도 검출 결과가 달라지지 않는다.
 */
export function launchOptions(config: RunConfig): { headless: boolean; channel: string } {
  return { headless: config.headless, channel: "chromium" };
}

export async function launch(config: RunConfig): Promise<BrowserSession> {
  const browser = await chromium.launch(launchOptions(config));

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
    const b = await chromium.launch({ headless: true, channel: "chromium" });
    await b.close();
    return { ok: true, remediation: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|playwright install/i.test(msg)) {
      const where = process.env.PLAYWRIGHT_BROWSERS_PATH;
      return {
        ok: false,
        remediation: where
          ? `동봉된 Chromium을 찾지 못했습니다 (${where}). 설치가 손상되었을 수 있으니 다시 설치해 주세요.`
          : "Chromium이 설치되지 않았습니다. `pnpm exec playwright install chromium` 을 실행하세요.",
      };
    }
    return { ok: false, remediation: `브라우저 기동 실패: ${msg}` };
  }
}
