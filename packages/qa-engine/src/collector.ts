import type { Page, Request, Response } from "playwright";
import {
  REDACTED,
  SENSITIVE_HEADERS,
  type ConsoleEntry,
  type NetworkEntry,
} from "@qa/shared";
import { consoleSignature, endpointTemplate } from "./normalize.js";
import { REJECTION_MARKER } from "./browser.js";

/**
 * Evidence Agent (수집부).
 *
 * Page에 리스너를 붙여 콘솔과 네트워크를 실시간으로 모은다.
 * **마스킹은 수집 시점에 한다.** 원본을 잠깐 들고 있다가 나중에 지우는 방식은 금지 —
 * 그 사이에 파일로 새어나갈 경로가 생긴다.
 */

const SENSITIVE_SET = new Set<string>(SENSITIVE_HEADERS);

export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_SET.has(k.toLowerCase()) ? REDACTED : v;
  }
  return out;
}

/**
 * 브라우저가 스스로 만들어내는 잡음. 네트워크 항목과 중복되므로 콘솔에서는 버린다.
 *
 * 예: `/api/notice/badge` 404 하나가 network 1건 + console 1건으로 잡히면
 * Phase 3에서 같은 결함이 Issue 2건으로 세어진다.
 */
function isBrowserNoise(text: string, url: string | null): boolean {
  if (/^Failed to load resource:/i.test(text)) return true;
  if (url && /\/favicon\.ico(\?|$)/i.test(url)) return true;
  if (url?.startsWith("chrome-extension://")) return true;
  return false;
}

/** stateKey는 drain 시점에 찍는다(아래 drain 주석 참고). 그전까지는 비워둔다. */
type PendingConsole = Omit<ConsoleEntry, "stateKey">;
type PendingNetwork = Omit<NetworkEntry, "stateKey">;

export interface CurrentScreen {
  stateKey: string;
  screenName: string;
}

export class Collector {
  private readonly console: PendingConsole[] = [];
  private readonly network: PendingNetwork[] = [];
  private readonly startedAt = new Map<Request, number>();
  /**
   * rejection으로 확인된 메시지들.
   *
   * 같은 오류가 표식 붙은 console 이벤트와 표식 없는 pageerror 이벤트로 **두 번** 온다.
   * 어느 쪽이 먼저 올지는 보장되지 않으므로 양방향으로 합친다.
   */
  private readonly rejectionMessages = new Set<string>();

  attach(page: Page): void {
    page.on("console", (msg) => {
      const level = msg.type();
      if (level !== "error" && level !== "warning") return; // log/info/debug는 잡음이다
      const loc = msg.location();
      const url = loc.url || null;
      const raw = msg.text();
      if (isBrowserNoise(raw, url)) return;

      const isRejection = raw.startsWith(REJECTION_MARKER);
      // 표식은 지문에 섞이면 안 된다. 같은 오류의 pageerror 판본과 지문이 달라진다.
      const text = isRejection ? raw.slice(REJECTION_MARKER.length).trim() : raw;

      if (isRejection) {
        this.rejectionMessages.add(text);
        // pageerror가 먼저 도착해 이미 담겼다면 그쪽을 rejection으로 승격시키고 끝낸다.
        const existing = this.console.find((c) => c.text === text && !c.isRejection);
        if (existing) {
          existing.isRejection = true;
          return;
        }
      }

      this.console.push({
        level: level === "warning" ? "warning" : "error",
        text,
        signature: consoleSignature(text),
        isRejection,
        url,
        lineNumber: Number.isFinite(loc.lineNumber) ? loc.lineNumber : null,
        stack: null,
        at: new Date().toISOString(),
      });
    });

    // uncaught exception. console 이벤트로는 스택이 안 오므로 따로 받는다.
    page.on("pageerror", (err) => {
      const text = err.message;
      // 표식 붙은 console 이벤트로 이미 담긴 rejection이면 중복이다.
      if (this.rejectionMessages.has(text) && this.console.some((c) => c.text === text)) return;

      this.console.push({
        level: "error",
        text,
        signature: consoleSignature(text),
        isRejection: this.rejectionMessages.has(text),
        url: null,
        lineNumber: null,
        stack: err.stack ?? null,
        at: new Date().toISOString(),
      });
    });

    page.on("request", (req) => {
      this.startedAt.set(req, Date.now());
    });

    page.on("response", (res) => {
      void this.recordResponse(res);
    });

    page.on("requestfailed", (req) => {
      const started = this.startedAt.get(req) ?? Date.now();
      this.startedAt.delete(req);
      this.network.push({
        method: req.method(),
        url: req.url(),
        endpointTemplate: endpointTemplate(req.url()),
        status: null,
        statusText: null,
        ok: false,
        failureText: req.failure()?.errorText ?? "request failed",
        durationMs: Date.now() - started,
        resourceType: req.resourceType(),
        requestHeaders: {},
        responseHeaders: {},
        responseBodySnippet: null,
        at: new Date().toISOString(),
      });
    });
  }

  private async recordResponse(res: Response): Promise<void> {
    const req = res.request();
    const started = this.startedAt.get(req) ?? Date.now();
    this.startedAt.delete(req);

    // 헤더 조회는 비동기라 실패할 수 있다. 실패해도 나머지는 기록한다.
    let requestHeaders: Record<string, string> = {};
    let responseHeaders: Record<string, string> = {};
    try {
      requestHeaders = maskHeaders(await req.allHeaders());
      responseHeaders = maskHeaders(await res.allHeaders());
    } catch {
      /* 페이지가 이미 이동했을 수 있다 */
    }

    const status = res.status();

    this.network.push({
      method: req.method(),
      url: res.url(),
      endpointTemplate: endpointTemplate(res.url()),
      status,
      statusText: res.statusText(),
      // Playwright의 res.ok()는 3xx를 false로 본다. 리다이렉트는 정상 동작이므로
      // 여기서는 "실패한 요청"의 의미로 4xx 이상만 실패로 센다.
      ok: status < 400,
      failureText: null,
      durationMs: Date.now() - started,
      resourceType: req.resourceType(),
      requestHeaders,
      responseHeaders,
      responseBodySnippet: null, // 본문은 기본 미저장 (CLAUDE.md §16)
      at: new Date().toISOString(),
    });
  }

  /**
   * 지금까지 모인 것을 꺼내고 버퍼를 비운다.
   *
   * **stateKey는 fire 시점이 아니라 여기서 찍는다.** 이벤트가 발생한 순간에는
   * 아직 어느 화면에 도착했는지 알 수 없다(탐색은 클릭 → 이동 → 화면 확정 순서다).
   * drain은 항상 화면 증적을 남기는 시점에 호출되므로, 직전 drain 이후 쌓인 것은
   * 모두 그 화면에 도달하는 과정에서 생긴 것이다.
   */
  drain(screen: CurrentScreen): { console: ConsoleEntry[]; network: NetworkEntry[] } {
    const out = {
      console: this.console.map((c) => ({ ...c, stateKey: screen.stateKey })),
      network: this.network.map((n) => ({ ...n, stateKey: screen.stateKey })),
    };
    this.console.length = 0;
    this.network.length = 0;
    return out;
  }

  /** 버퍼를 비우지 않고 크기만 본다. */
  pendingCount(): { console: number; network: number } {
    return { console: this.console.length, network: this.network.length };
  }
}
