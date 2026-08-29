import type {
  ConsoleEntry,
  IssueCandidate,
  NetworkEntry,
  Severity,
  VisualMetrics,
} from "@qa/shared";
import { sha1 } from "./normalize.js";

/**
 * 룰 기반 검출기.
 *
 * Console / Network / Visual Reviewer Agent의 1차 판정부.
 * **AI를 쓰지 않는다.** 여기서 나온 결과만으로 리포트가 완성되어야 하고,
 * AI는 나중에 문장을 다듬을 뿐이다.
 */

export interface ScreenContext {
  stateKey: string;
  screenName: string;
  url: string;
  evidenceIdByKind: Partial<Record<string, string>>;
}

let candidateSeq = 0;
export function resetCandidateSeq(): void {
  candidateSeq = 0;
}

function candidate(input: {
  source: IssueCandidate["source"];
  ruleId: string;
  title: string;
  description: string;
  severity: Severity;
  dedupKey: string;
  evidenceId: string | undefined;
  screen: ScreenContext;
}): IssueCandidate | null {
  // 증적 없는 후보는 만들지 않는다. 리포트에서 근거를 댈 수 없다.
  if (!input.evidenceId) return null;
  candidateSeq += 1;
  return {
    id: `cand-${String(candidateSeq).padStart(4, "0")}`,
    source: input.source,
    ruleId: input.ruleId,
    title: input.title,
    description: input.description,
    stateKey: input.screen.stateKey,
    screenName: input.screen.screenName,
    suggestedSeverity: input.severity,
    dedupKey: input.dedupKey,
    evidenceIds: [input.evidenceId],
    aiRationale: null,
    detectedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────── Network

const STATIC_RESOURCE = new Set(["image", "font", "stylesheet", "media", "manifest"]);
const SLOW_MS = 3000;

export function detectNetwork(entries: NetworkEntry[], screen: ScreenContext): IssueCandidate[] {
  const out: Array<IssueCandidate | null> = [];
  const evidenceId = screen.evidenceIdByKind.network;

  for (const e of entries) {
    const where = `${e.method} ${e.endpointTemplate}`;

    if (e.failureText !== null) {
      const cors = /cors|cross-origin/i.test(e.failureText);
      const timeout = /timed?\s*out|timeout/i.test(e.failureText);
      const ruleId = cors ? "NET-CORS" : timeout ? "NET-TIMEOUT" : "NET-FAILED";
      out.push(
        candidate({
          source: "network",
          ruleId,
          title: `요청 실패: ${where}`,
          description: `${where} 요청이 응답 없이 실패했습니다. (${e.failureText})`,
          severity: ruleId === "NET-FAILED" ? "MEDIUM" : "HIGH",
          dedupKey: sha1(`network|${ruleId}|${e.endpointTemplate}|none`),
          evidenceId,
          screen,
        }),
      );
      continue;
    }

    const status = e.status;
    if (status === null || status < 400) {
      if (e.durationMs > SLOW_MS && (e.resourceType === "xhr" || e.resourceType === "fetch")) {
        out.push(
          candidate({
            source: "network",
            ruleId: "NET-SLOW",
            title: `느린 응답: ${where}`,
            description: `${where} 응답에 ${e.durationMs}ms가 걸렸습니다 (기준 ${SLOW_MS}ms).`,
            severity: "LOW",
            dedupKey: sha1(`network|NET-SLOW|${e.endpointTemplate}|${status}`),
            evidenceId,
            screen,
          }),
        );
      }
      continue;
    }

    let ruleId: string;
    let severity: Severity;
    if (status >= 500) {
      ruleId = "NET-5XX";
      severity = "HIGH";
    } else if (status === 401 || status === 403) {
      ruleId = "NET-AUTH";
      severity = "HIGH";
    } else {
      ruleId = "NET-4XX";
      severity = "MEDIUM";
    }

    // 정적 리소스의 404는 기능 장애가 아니다.
    if (STATIC_RESOURCE.has(e.resourceType) && status < 500) severity = "LOW";

    out.push(
      candidate({
        source: "network",
        ruleId,
        title: `HTTP ${status}: ${where}`,
        description: `${where} 요청이 HTTP ${status}${e.statusText ? ` ${e.statusText}` : ""}를 반환했습니다.`,
        severity,
        dedupKey: sha1(`network|${ruleId}|${e.endpointTemplate}|${status}`),
        evidenceId,
        screen,
      }),
    );
  }

  return out.filter((c): c is IssueCandidate => c !== null);
}

// ─────────────────────────────────────────────────────────── Console

const FRAMEWORK_ERROR = /(react|vue|angular|svelte)\b.*(error|warning)/i;

export function detectConsole(entries: ConsoleEntry[], screen: ScreenContext): IssueCandidate[] {
  const out: Array<IssueCandidate | null> = [];
  const evidenceId = screen.evidenceIdByKind.console;

  for (const e of entries) {
    if (e.level !== "error") continue;

    let ruleId: string;
    let severity: Severity;
    if (e.isRejection) {
      ruleId = "CON-REJECTION";
      severity = "MEDIUM";
    } else if (e.stack !== null || /TypeError|ReferenceError|SyntaxError|RangeError/.test(e.text)) {
      // 스택이 있다는 것은 pageerror, 즉 잡히지 않은 예외라는 뜻이다.
      ruleId = "CON-UNCAUGHT";
      severity = "HIGH";
    } else if (FRAMEWORK_ERROR.test(e.text)) {
      ruleId = "CON-FRAMEWORK";
      severity = "MEDIUM";
    } else {
      ruleId = "CON-ERROR";
      severity = "LOW";
    }

    out.push(
      candidate({
        source: "console",
        ruleId,
        title: `콘솔 오류: ${e.text.slice(0, 70)}`,
        description: e.text.slice(0, 500) + (e.stack ? `\n\n${e.stack.slice(0, 400)}` : ""),
        severity,
        dedupKey: sha1(`console|${ruleId}|${e.signature}`),
        evidenceId,
        screen,
      }),
    );
  }

  return out.filter((c): c is IssueCandidate => c !== null);
}

// ─────────────────────────────────────────────────────────── Visual

export function detectVisual(
  metrics: VisualMetrics | null,
  loadingStuck: boolean,
  screen: ScreenContext,
): IssueCandidate[] {
  const out: Array<IssueCandidate | null> = [];
  const evidenceId = screen.evidenceIdByKind.visual ?? screen.evidenceIdByKind.screenshot;

  /**
   * 로딩이 끝나지 않는 화면. 룰만으로 잡을 수 있는 가장 심각한 기능 장애다.
   * 재확인까지 거친 값이므로 잠깐 뜬 스피너는 여기 오지 않는다.
   */
  if (loadingStuck) {
    out.push(
      candidate({
        source: "functional",
        ruleId: "FUNC-INFINITE-LOADING",
        title: `로딩이 끝나지 않음: ${screen.screenName}`,
        description:
          `${screen.screenName} 화면에서 로딩 인디케이터가 계속 표시되어 내용이 나타나지 않습니다. ` +
          `대기 후 재확인해도 동일합니다.`,
        severity: "HIGH",
        dedupKey: sha1(`functional|FUNC-INFINITE-LOADING|${screen.stateKey}`),
        evidenceId,
        screen,
      }),
    );
  }

  if (!metrics) return out.filter((c): c is IssueCandidate => c !== null);

  if (metrics.hasHorizontalOverflow) {
    const worst = metrics.overflowingElements[0];
    out.push(
      candidate({
        source: "visual",
        ruleId: "VIS-OVERFLOW",
        title: `가로 스크롤 발생: ${screen.screenName}`,
        description:
          `콘텐츠 폭 ${metrics.scrollWidth}px가 뷰포트 ${metrics.viewportWidth}px를 넘어 ` +
          `가로 스크롤이 생깁니다.` +
          (worst ? ` 가장 크게 넘친 요소: ${worst.selector} (+${worst.overflowPx}px)` : ""),
        severity: "MEDIUM",
        dedupKey: sha1(`visual|VIS-OVERFLOW|${screen.stateKey}`),
        evidenceId,
        screen,
      }),
    );
  }

  for (const pair of metrics.overlappingPairs) {
    out.push(
      candidate({
        source: "visual",
        ruleId: "VIS-OVERLAP",
        title: `요소 겹침: ${pair.a} ↔ ${pair.b}`,
        description: `${screen.screenName} 화면에서 ${pair.a} 와 ${pair.b} 가 ${pair.areaPx}px² 겹칩니다.`,
        severity: "LOW",
        dedupKey: sha1(`visual|VIS-OVERLAP|${pair.a}|${pair.b}`),
        evidenceId,
        screen,
      }),
    );
  }

  for (const t of metrics.truncatedTexts) {
    out.push(
      candidate({
        source: "visual",
        ruleId: "VIS-TRUNCATE",
        title: `텍스트 잘림: ${t.text}`,
        description: `${t.selector} 의 텍스트 "${t.text}" 가 폭에 맞지 않아 잘려 보입니다.`,
        severity: "LOW",
        // 같은 요소의 잘림이 여러 화면에서 반복되면(공통 메뉴 등) 하나로 묶인다.
        dedupKey: sha1(`visual|VIS-TRUNCATE|${t.selector}|${t.text}`),
        evidenceId,
        screen,
      }),
    );
  }

  for (const cta of metrics.obscuredCtas) {
    out.push(
      candidate({
        source: "visual",
        ruleId: "VIS-HIDDEN-CTA",
        title: `버튼이 가려짐: ${cta.label || cta.selector}`,
        description: `${cta.selector} 버튼이 화면 안에 있지만 다른 요소에 가려 클릭할 수 없습니다.`,
        severity: "MEDIUM",
        dedupKey: sha1(`visual|VIS-HIDDEN-CTA|${cta.selector}`),
        evidenceId,
        screen,
      }),
    );
  }

  return out.filter((c): c is IssueCandidate => c !== null);
}
