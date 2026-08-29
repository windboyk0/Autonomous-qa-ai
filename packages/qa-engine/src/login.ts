import type { Locator, Page } from "playwright";
import type { LoginConfig } from "@qa/shared";
import { log } from "./emitter.js";

/**
 * Login Agent.
 *
 * 로그인 1회 성공과 세션 유지가 Run 전체의 신뢰도를 결정한다.
 * 세션이 끊기면 이후 모든 탐색이 로그인 화면으로 빨려 들어간다.
 */

export interface LoginSignals {
  /** 인증 API가 2xx로 응답했는가. **가장 강한 신호다.** */
  authOk: boolean;
  /** 인증 API가 4xx/5xx로 거절했는가. 이게 참이면 다른 신호를 볼 것도 없다. */
  authRejected: boolean;
  /** 거절 응답의 상태 코드. */
  authStatus: number | null;
  urlChanged: boolean;
  formGone: boolean;
  newCookie: boolean;
  /** localStorage/sessionStorage에 새 값이 생겼는가. 토큰 기반 인증의 흔적. */
  newStorage: boolean;
}

export interface LoginResult {
  success: boolean;
  landedUrl: string;
  /** 판정 근거. 실패 시 사용자에게 그대로 보여준다. */
  reason: string;
  /** 어떤 신호가 켜졌는지. 디버깅과 리포트에 쓴다. */
  signals: LoginSignals;
  usedSelectors: { username: string | null; password: string | null; submit: string | null };
  /** 인증은 됐는데 화면이 안 넘어간 경우처럼, 성공이어도 남길 말이 있으면 여기 담는다. */
  warning: string | null;
}

/** 인증 요청으로 볼 URL. 관리자웹이 쓰는 흔한 경로들. */
const AUTH_URL = /\/(login|signin|sign-in|auth|token|session|oauth)\b/i;

/** 토큰이 담길 만한 저장소 키. */
const TOKEN_KEY = /(token|jwt|auth|session|access|refresh|user)/i;

/** 판정을 내리기 전에 화면이 반응할 시간을 준다. */
const SETTLE_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;

/** 로그인 폼이 화면에 있는가. 세션 만료 감지에도 쓴다. */
export async function hasLoginForm(page: Page): Promise<boolean> {
  return (await page.locator("input[type=password]").count()) > 0;
}

/** 첫 번째로 보이는 요소를 고른다. 없으면 null. */
async function firstVisible(page: Page, selectors: string[]): Promise<{ loc: Locator; selector: string } | null> {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    try {
      if ((await loc.count()) > 0 && (await loc.isVisible())) return { loc, selector };
    } catch {
      /* 셀렉터가 유효하지 않으면 다음으로 */
    }
  }
  return null;
}

const USERNAME_SELECTORS = [
  "input[autocomplete=username]",
  "input[type=email]",
  "input[name*=user i]",
  "input[name*=login i]",
  "input[name*=email i]",
  "input[id*=user i]",
  "input[id*=login i]",
  "input[id*=email i]",
  "input[name*=id i]",
  "input[type=text]",
];

const SUBMIT_SELECTORS = [
  "button[type=submit]",
  "input[type=submit]",
  "button:has-text('로그인')",
  "button:has-text('Login')",
  "button:has-text('Sign in')",
  "button:has-text('Log in')",
  "form button",
];

export async function login(
  page: Page,
  config: LoginConfig,
  targetUrl: string,
): Promise<LoginResult> {
  const noSelectors = { username: null, password: null, submit: null };

  // 로그인 경로가 지정되어 있으면 먼저 그리로 간다.
  if (config.loginPath) {
    await page.goto(new URL(config.loginPath, targetUrl).toString(), { waitUntil: "domcontentloaded" });
  }

  // 로그인 폼이 안 보이면 이미 로그인되어 있거나 로그인이 필요 없는 화면이다.
  if (!(await hasLoginForm(page))) {
    return {
      success: true,
      landedUrl: page.url(),
      reason: "로그인 폼이 없습니다. 이미 인증되어 있거나 로그인이 필요 없는 대상입니다.",
      signals: { authOk: false, authRejected: false, authStatus: null, urlChanged: false, formGone: true, newCookie: false, newStorage: false },
      warning: null,
      usedSelectors: noSelectors,
    };
  }

  const urlBefore = page.url();
  const cookiesBefore = new Set(
    (await page.context().cookies()).map((c) => `${c.name}@${c.domain}`),
  );
  const storageBefore = await readStorageKeys(page);

  /**
   * 인증 요청 감시.
   *
   * **이게 가장 믿을 만한 신호다.** 화면이 어떻게 생겼든 서버가 뭐라고 답했는지는
   * 분명하다. 토큰 기반 인증(JWT를 localStorage에)을 쓰는 SPA는 쿠키가 생기지 않고,
   * React 라우팅은 우리가 판정하는 시점보다 늦게 끝날 수 있다.
   * 실측: `POST /api/v1/auth/login → 200` 으로 로그인이 성공했는데
   * 쿠키·URL·폼 세 신호가 모두 거짓이라 실패로 오판했다.
   */
  let authOk = false;
  let authRejected = false;
  let authStatus: number | null = null;

  const watchAuth = (response: { url(): string; status(): number; request(): { method(): string } }) => {
    if (response.request().method().toUpperCase() !== "POST") return;
    if (!AUTH_URL.test(response.url())) return;
    const status = response.status();
    authStatus = status;
    // 3xx도 성공이다. 전통적인 폼 인증은 302로 대시보드에 보내는 것이 정상이다.
    // (Phase 1에서 정한 `status < 400` 기준과 같다)
    if (status < 400) authOk = true;
    else authRejected = true;
  };
  page.on("response", watchAuth);

  // ── 셀렉터 결정 ─────────────────────────────────────────────────────
  const userField = config.usernameSelector
    ? { loc: page.locator(config.usernameSelector).first(), selector: config.usernameSelector }
    : await firstVisible(page, USERNAME_SELECTORS);

  const pwField = config.passwordSelector
    ? { loc: page.locator(config.passwordSelector).first(), selector: config.passwordSelector }
    : await firstVisible(page, ["input[type=password]"]);

  if (!userField || !pwField) {
    return {
      success: false,
      landedUrl: page.url(),
      reason: `로그인 폼 필드를 찾지 못했습니다 (아이디 ${userField ? "찾음" : "못찾음"} / 비밀번호 ${pwField ? "찾음" : "못찾음"})`,
      signals: { authOk: false, authRejected: false, authStatus: null, urlChanged: false, formGone: false, newCookie: false, newStorage: false },
      warning: null,
      usedSelectors: {
        username: userField?.selector ?? null,
        password: pwField?.selector ?? null,
        submit: null,
      },
    };
  }

  const submit = config.submitSelector
    ? { loc: page.locator(config.submitSelector).first(), selector: config.submitSelector }
    : await firstVisible(page, SUBMIT_SELECTORS);

  const usedSelectors = {
    username: userField.selector,
    password: pwField.selector,
    submit: submit?.selector ?? null,
  };

  log("info", `로그인 폼 탐지: 아이디=${usedSelectors.username} 제출=${usedSelectors.submit ?? "Enter키"}`);

  // ── 입력 및 제출 ────────────────────────────────────────────────────
  await userField.loc.fill(config.username);
  await pwField.loc.fill(config.password);

  try {
    await (submit ? submit.loc.click() : pwField.loc.press("Enter"));

    /**
     * 화면이 반응할 시간을 준다.
     *
     * SPA는 `domcontentloaded` 도 `load` 도 다시 발생시키지 않고, `networkidle` 은
     * 요청이 시작되기 전에 통과해 버린다. 그래서 **결과가 나타날 때까지 폴링**한다.
     * 고정 대기로는 느린 서버에서 놓치고 빠른 서버에서 시간을 버린다.
     */
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let signals = await readSignals(page, urlBefore, cookiesBefore, storageBefore);

    while (Date.now() < deadline) {
      signals = await readSignals(page, urlBefore, cookiesBefore, storageBefore);
      if (authRejected) break; // 서버가 거절했다. 더 기다릴 이유가 없다.
      // 인증이 성공했고 화면까지 넘어갔으면 끝이다.
      if (authOk && (signals.formGone || signals.urlChanged)) break;
      // 인증 감시가 못 잡는 방식(폼 POST 후 리다이렉트)도 있다.
      if (signals.formGone && signals.urlChanged) break;
      await page.waitForTimeout(POLL_INTERVAL_MS);
    }

    const final: LoginSignals = { ...signals, authOk, authRejected, authStatus };
    const visibleError = await readVisibleError(page);

    // ── 1. 서버가 거절했다 — 가장 명확한 실패 ─────────────────────────
    if (final.authRejected) {
      return {
        success: false,
        landedUrl: page.url(),
        reason:
          `로그인이 거절되었습니다 (인증 API가 HTTP ${final.authStatus} 를 반환).` +
          (visibleError ? ` 화면 메시지: ${visibleError}` : " 아이디와 비밀번호를 확인하세요."),
        signals: final,
        usedSelectors,
        warning: null,
      };
    }

    // ── 2. 인증 API가 성공했다 — 쿠키가 없어도 성공이다 ────────────────
    if (final.authOk) {
      const moved = final.formGone || final.urlChanged;
      return {
        success: true,
        landedUrl: page.url(),
        reason: `로그인 성공 (인증 API 2xx${moved ? ", 화면 전환 확인" : ""})`,
        signals: final,
        usedSelectors,
        // 인증은 됐는데 화면이 안 넘어갔다면 그 자체가 결함 후보다.
        warning: moved
          ? null
          : "인증은 성공했지만 로그인 화면이 그대로 남아 있습니다. 화면 전환이 동작하지 않을 수 있습니다.",
      };
    }

    // ── 3. 인증 요청을 못 봤다 — 화면 변화로 판단한다 ──────────────────
    const score = Number(final.urlChanged) + Number(final.formGone) + Number(final.newCookie) + Number(final.newStorage);
    const detail = `URL변경=${final.urlChanged} 폼사라짐=${final.formGone} 새쿠키=${final.newCookie} 새저장소=${final.newStorage}`;

    if (score >= 2) {
      return {
        success: true,
        landedUrl: page.url(),
        reason: `로그인 성공 (신호 ${score}/4: ${detail})`,
        signals: final,
        usedSelectors,
        warning: null,
      };
    }

    return {
      success: false,
      landedUrl: page.url(),
      reason:
        `로그인 실패 — 인증 요청이 관측되지 않았고 화면도 바뀌지 않았습니다 (신호 ${score}/4: ${detail}).` +
        (visibleError ? ` 화면 메시지: ${visibleError}` : "") +
        " 제출 버튼이 동작하지 않거나, 로그인 방식이 다를 수 있습니다.",
      signals: final,
      usedSelectors,
      warning: null,
    };
  } finally {
    page.off("response", watchAuth);
  }
}

/** 저장소 키 목록. 값은 읽지 않는다 — 토큰이 로그로 새어나가면 안 된다. */
async function readStorageKeys(page: Page): Promise<Set<string>> {
  try {
    const keys = await page.evaluate(() => {
      const out: string[] = [];
      for (const store of [window.localStorage, window.sessionStorage]) {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (key) out.push(key);
        }
      }
      return out;
    });
    return new Set(keys);
  } catch {
    return new Set();
  }
}

async function readSignals(
  page: Page,
  urlBefore: string,
  cookiesBefore: Set<string>,
  storageBefore: Set<string>,
): Promise<Omit<LoginSignals, "authOk" | "authRejected" | "authStatus">> {
  const urlChanged = page.url() !== urlBefore;
  const formGone = !(await hasLoginForm(page).catch(() => false));
  const newCookie = await page
    .context()
    .cookies()
    .then((cs) => cs.some((c) => !cookiesBefore.has(`${c.name}@${c.domain}`)))
    .catch(() => false);
  const after = await readStorageKeys(page);
  const newStorage = [...after].some((k) => !storageBefore.has(k) && TOKEN_KEY.test(k));

  return { urlChanged, formGone, newCookie, newStorage };
}

/**
 * 화면에 뜬 오류 메시지.
 *
 * `.error` 같은 클래스명만 찾으면 Tailwind로 만든 화면에서는 하나도 못 잡는다
 * (실측: 클래스가 `text-red-500` 이었다). 색상 유틸리티 클래스와 역할 속성을 함께 본다.
 */
async function readVisibleError(page: Page): Promise<string> {
  try {
    const text = await page.evaluate(() => {
      const selectors = [
        "[role=alert]",
        "[aria-live]",
        ".error",
        ".err",
        '[class*="error" i]',
        '[class*="danger" i]',
        '[class*="text-red" i]',
        '[class*="invalid" i]',
      ];
      for (const selector of selectors) {
        for (const el of Array.from(document.querySelectorAll(selector))) {
          const t = (el.textContent ?? "").trim();
          if (t && t.length <= 200) return t;
        }
      }
      return "";
    });
    return text;
  } catch {
    return "";
  }
}
