import type { Locator, Page } from "playwright";
import type { LoginConfig } from "@qa/shared";
import { log } from "./emitter.js";

/**
 * Login Agent.
 *
 * 로그인 1회 성공과 세션 유지가 Run 전체의 신뢰도를 결정한다.
 * 세션이 끊기면 이후 모든 탐색이 로그인 화면으로 빨려 들어간다.
 */

export interface LoginResult {
  success: boolean;
  landedUrl: string;
  /** 판정 근거. 실패 시 사용자에게 그대로 보여준다. */
  reason: string;
  /** 어떤 신호가 켜졌는지. 디버깅과 리포트에 쓴다. */
  signals: { urlChanged: boolean; formGone: boolean; newCookie: boolean };
  usedSelectors: { username: string | null; password: string | null; submit: string | null };
}

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
      signals: { urlChanged: false, formGone: true, newCookie: false },
      usedSelectors: noSelectors,
    };
  }

  const urlBefore = page.url();
  const cookiesBefore = new Set(
    (await page.context().cookies()).map((c) => `${c.name}@${c.domain}`),
  );

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
      signals: { urlChanged: false, formGone: false, newCookie: false },
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

  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => undefined),
    submit ? submit.loc.click() : pwField.loc.press("Enter"),
  ]);

  // SPA는 로드 이벤트 없이 화면만 바뀐다. 짧게 안정화를 기다린다.
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);

  // ── 성공 판정: 3개 신호 중 2개 이상 ──────────────────────────────────
  const urlChanged = page.url() !== urlBefore;
  const formGone = !(await hasLoginForm(page));
  const newCookie = (await page.context().cookies()).some(
    (c) => !cookiesBefore.has(`${c.name}@${c.domain}`),
  );

  const signals = { urlChanged, formGone, newCookie };
  const score = Number(urlChanged) + Number(formGone) + Number(newCookie);

  if (score >= 2) {
    return {
      success: true,
      landedUrl: page.url(),
      reason: `로그인 성공 (신호 ${score}/3: URL변경=${urlChanged} 폼사라짐=${formGone} 새쿠키=${newCookie})`,
      signals,
      usedSelectors,
    };
  }

  // 실패다. 화면에 보이는 오류 메시지를 근거로 덧붙인다.
  let visibleError = "";
  try {
    const alert = page.locator("[role=alert], .error, .err").first();
    if ((await alert.count()) > 0) visibleError = (await alert.innerText()).trim().slice(0, 200);
  } catch {
    /* 없으면 그만 */
  }

  return {
    success: false,
    landedUrl: page.url(),
    reason:
      `로그인 실패 (신호 ${score}/3: URL변경=${urlChanged} 폼사라짐=${formGone} 새쿠키=${newCookie})` +
      (visibleError ? ` · 화면 메시지: ${visibleError}` : ""),
    signals,
    usedSelectors,
  };
}
