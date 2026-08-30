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
  apiRef?: IssueCandidate["apiRef"];
}): IssueCandidate | null {
  // 증적 없는 후보는 만들지 않는다. 리포트에서 근거를 댈 수 없다.
  if (!input.evidenceId) return null;
  candidateSeq += 1;
  return {
    id: `cand-${String(candidateSeq).padStart(4, "0")}`,
    source: input.source,
    // 실행 증적에서 나온 결함이라 소스 위치를 모른다. 통합 QA 가 매핑해 채운다.
    codeRefs: [],
    apiRef: input.apiRef ?? null,
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

/**
 * 응답 없이 실패한 요청의 사유를 가른다.
 *
 * **브라우저가 알려주는 사유를 그대로 살려야 한다.** 전부 "요청이 전송되지 못했습니다"로
 * 뭉뚱그리면 사용자가 무엇을 고쳐야 할지 알 수 없다.
 * 실측: `ERR_BLOCKED_BY_ORB` 로 로고 이미지가 차단된 건이 "네트워크·차단·잘못된 URL을
 * 확인하세요"라는 안내를 받았다. 원인이 명확한데 안내는 모호했다.
 */
function classifyFailure(
  failureText: string,
  resourceType: string,
): { ruleId: string; severity: Severity; note: string } {
  // 브라우저가 크로스 오리진 응답을 차단한 경우 (ORB / CORB).
  if (/ERR_BLOCKED_BY_ORB|ERR_BLOCKED_BY_RESPONSE/i.test(failureText)) {
    return {
      ruleId: "NET-BLOCKED-ORB",
      severity: "MEDIUM",
      note:
        `브라우저가 다른 출처의 응답을 차단했습니다. ` +
        `${resourceType === "image" ? "이미지" : "리소스"}로 요청했는데 응답의 Content-Type이 ` +
        `그에 맞지 않을 때 생깁니다(예: 이미지 요청에 application/json 응답). ` +
        `해당 화면 요소가 비어 보입니다.`,
    };
  }

  // 광고 차단기·확장 프로그램·보안 정책이 막은 경우. 대상 시스템의 결함이 아닐 수 있다.
  if (/ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_ADMINISTRATOR/i.test(failureText)) {
    return {
      ruleId: "NET-BLOCKED-CLIENT",
      severity: "LOW",
      note: "브라우저 확장이나 정책이 차단했을 수 있습니다. 대상 시스템의 결함이 아닐 수 있습니다.",
    };
  }

  /**
   * 앱이 스스로 취소한 요청.
   * SPA에서 컴포넌트가 언마운트되거나 화면이 넘어갈 때 흔히 생기며 대부분 정상이다.
   * 숨기지는 않되 심각도를 낮춘다 — 이걸 MEDIUM으로 올리면 리포트가 잡음으로 덮인다.
   */
  if (/ERR_ABORTED|net::ERR_CONNECTION_ABORTED/i.test(failureText)) {
    return {
      ruleId: "NET-ABORTED",
      severity: "LOW",
      note: "화면 전환 등으로 앱이 스스로 취소한 요청일 수 있습니다. 의도한 것인지 확인하세요.",
    };
  }

  if (/cors|cross-origin/i.test(failureText)) {
    return {
      ruleId: "NET-CORS",
      severity: "HIGH",
      note: "서버의 CORS 허용 origin 설정을 확인하세요.",
    };
  }

  if (/timed?\s*out|timeout/i.test(failureText)) {
    return { ruleId: "NET-TIMEOUT", severity: "HIGH", note: "응답이 제한 시간 안에 오지 않았습니다." };
  }

  if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET/i.test(failureText)) {
    return {
      ruleId: "NET-UNREACHABLE",
      severity: "HIGH",
      note: "주소를 찾지 못했거나 서버가 연결을 거부했습니다. 호스트와 포트를 확인하세요.",
    };
  }

  if (/ERR_CERT|ERR_SSL/i.test(failureText)) {
    return {
      ruleId: "NET-TLS",
      severity: "HIGH",
      note: "인증서 문제로 연결이 거부되었습니다.",
    };
  }

  return {
    ruleId: "NET-FAILED",
    severity: "MEDIUM",
    note: "요청이 서버에 닿지 못했습니다. 주소와 네트워크 경로를 확인하세요.",
  };
}

export function detectNetwork(entries: NetworkEntry[], screen: ScreenContext): IssueCandidate[] {
  const out: Array<IssueCandidate | null> = [];
  const evidenceId = screen.evidenceIdByKind.network;

  for (const e of entries) {
    const where = `${e.method} ${e.endpointTemplate}`;

    if (e.failureText !== null) {
      const { ruleId, severity, note } = classifyFailure(e.failureText, e.resourceType);
      out.push(
        candidate({
          source: "network",
          ruleId,
          title: `요청 실패: ${where}`,
          description:
            `${where} (${e.resourceType}) 요청이 응답 없이 실패했습니다.\n` +
            `브라우저 사유: ${e.failureText}\n${note}`,
          severity,
          dedupKey: sha1(`network|${ruleId}|${e.endpointTemplate}|none`),
          apiRef: { method: e.method, endpointTemplate: e.endpointTemplate, status: e.status ?? null },
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
            apiRef: { method: e.method, endpointTemplate: e.endpointTemplate, status: e.status ?? null },
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
        apiRef: { method: e.method, endpointTemplate: e.endpointTemplate, status: e.status ?? null },
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
