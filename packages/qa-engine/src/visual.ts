import type { Page } from "playwright";
import type { VisualMetrics } from "@qa/shared";

/**
 * Visual Reviewer Agent (계측부).
 *
 * AI 없이 브라우저에서 직접 재는 값들. Phase 3의 화면 검출은 전부 여기에 의존한다.
 *
 * **오탐 억제가 이 모듈의 절반이다.** 관리자 화면에는 겹치는 것처럼 보이는 요소가
 * 원래 많다. 조상-자손, 컨테이너, 화면 밖 요소를 걸러내지 않으면 리포트가
 * "겹침" 수백 건으로 뒤덮여 아무도 읽지 않게 된다.
 */

/** 로딩 인디케이터로 볼 신호. */
const LOADING_PATTERN = /(로딩|불러오는|처리\s*중|loading|spinner|잠시만)/i;

/** 한 번 재기. 대기·재확인은 measureVisual이 한다. */
async function measureOnce(page: Page): Promise<VisualMetrics & { loadingVisible: boolean }> {
  return page.evaluate(() => {
    const visible = (el: Element): boolean => {
      if (typeof (el as HTMLElement).checkVisibility === "function") {
        return (el as HTMLElement).checkVisibility();
      }
      const s = window.getComputedStyle(el);
      return s.display !== "none" && s.visibility !== "hidden";
    };

    const describe = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      const testid = el.getAttribute("data-testid");
      if (testid) return `${tag}[data-testid="${testid}"]`;
      if (el.id) return `${tag}#${el.id}`;
      const cls = (el.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean)[0];
      return cls ? `${tag}.${cls}` : tag;
    };

    const text = (el: Element): string => (el.textContent ?? "").trim().replace(/\s+/g, " ");

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scrollWidth = document.documentElement.scrollWidth;
    const scrollHeight = document.documentElement.scrollHeight;

    const all = Array.from(document.body.querySelectorAll<HTMLElement>("*")).filter(visible);

    // ── viewport 밖으로 삐져나간 요소 ────────────────────────────────
    const overflowingElements: Array<{ selector: string; overflowPx: number }> = [];
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const over = Math.round(r.right - vw);
      // 부모가 이미 넘쳤으면 자식도 전부 넘친다. 가장 바깥 것만 보고한다.
      if (over > 8 && !overflowingElements.some((o) => el.closest(o.selector) !== null)) {
        overflowingElements.push({ selector: describe(el), overflowPx: over });
      }
      if (overflowingElements.length >= 10) break;
    }

    // ── 겹침 (형제끼리만) ─────────────────────────────────────────────
    const overlappingPairs: Array<{ a: string; b: string; areaPx: number }> = [];
    const inFlow = (el: Element): boolean => {
      const p = window.getComputedStyle(el).position;
      return p !== "fixed" && p !== "sticky";
    };
    const candidates = all.filter(
      (el) => text(el).length > 0 && el.children.length === 0 && inFlow(el),
    );
    for (let i = 0; i < candidates.length && overlappingPairs.length < 10; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i]!;
        const b = candidates[j]!;
        // 조상-자손은 원래 겹친다. 형제 관계만 본다.
        if (a.contains(b) || b.contains(a)) continue;
        if (a.parentElement !== b.parentElement) continue;

        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (w <= 1 || h <= 1) continue;

        const area = w * h;
        const smaller = Math.min(ra.width * ra.height, rb.width * rb.height);
        if (smaller === 0) continue;
        if (area / smaller < 0.3) continue;

        overlappingPairs.push({ a: describe(a), b: describe(b), areaPx: Math.round(area) });
        break;
      }
    }

    // ── 텍스트 잘림 ───────────────────────────────────────────────────
    const truncatedTexts: Array<{ selector: string; text: string }> = [];
    for (const el of all) {
      if (truncatedTexts.length >= 10) break;
      const s = window.getComputedStyle(el);
      if (s.overflowX !== "hidden" && s.overflow !== "hidden" && s.textOverflow !== "ellipsis") continue;
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      const t = text(el);
      if (!t || el.children.length > 0) continue;
      truncatedTexts.push({ selector: describe(el), text: t.slice(0, 60) });
    }

    /**
     * ── 가려진 CTA ──────────────────────────────────────────────────
     *
     * 모달이 열려 있으면 뒤쪽 버튼이 가려지는 것은 **정상 동작**이다.
     * 그걸 결함으로 올리면 모달이 있는 화면마다 오탐이 쏟아진다
     * (fixture에서 실제로 3건이 올라왔다). 모달이 열려 있으면 그 안만 본다.
     */
    const openDialog =
      document.querySelector("dialog[open]") ??
      Array.from(document.querySelectorAll("[role=dialog]")).find((d) => visible(d)) ??
      null;
    const ctaScope = openDialog
      ? Array.from(openDialog.querySelectorAll<HTMLElement>("*")).filter(visible)
      : all;

    const obscuredCtas: Array<{ selector: string; label: string }> = [];
    for (const el of ctaScope) {
      if (obscuredCtas.length >= 10) break;
      const tag = el.tagName.toLowerCase();
      if (tag !== "button" && el.getAttribute("role") !== "button") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.top < 0 || r.left < 0 || r.bottom > vh || r.right > vw) continue; // 화면 밖은 별개 문제
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit && hit !== el && !el.contains(hit)) {
        obscuredCtas.push({ selector: describe(el), label: text(el).slice(0, 40) });
      }
    }

    // ── 빈 영역 비율 + 로딩 인디케이터 ────────────────────────────────
    const main =
      document.querySelector("main") ??
      document.querySelector("[role=main]") ??
      document.body;
    const mainRect = main.getBoundingClientRect();
    const mainArea = Math.max(1, mainRect.width * mainRect.height);
    let filled = 0;
    for (const el of Array.from(main.querySelectorAll<HTMLElement>("*")).filter(visible)) {
      if (el.children.length > 0) continue; // 잎 노드만 세면 중복 합산을 피한다
      const r = el.getBoundingClientRect();
      filled += Math.max(0, r.width) * Math.max(0, r.height);
    }
    const emptyAreaRatio = Math.max(0, Math.min(1, 1 - filled / mainArea));

    const loadingPattern = /(로딩|불러오는|처리\s*중|loading|spinner|잠시만)/i;
    const loadingVisible = Array.from(main.querySelectorAll<HTMLElement>("*"))
      .filter(visible)
      .some((el) => {
        const cls = el.getAttribute("class") ?? "";
        const t = el.children.length === 0 ? text(el) : "";
        return loadingPattern.test(cls) || loadingPattern.test(t);
      });

    return {
      viewportWidth: vw,
      viewportHeight: vh,
      scrollWidth,
      scrollHeight,
      hasHorizontalOverflow: scrollWidth > vw + 8,
      overflowingElements,
      overlappingPairs,
      truncatedTexts,
      obscuredCtas,
      emptyAreaRatio,
      loadingVisible,
    };
  });
}

export interface VisualReading {
  metrics: VisualMetrics;
  /**
   * 로딩 인디케이터가 재확인 후에도 남아 있는가.
   *
   * 잠깐 보이는 스피너를 무한 로딩으로 오해하지 않기 위해, 처음 관측되면
   * 한 번 더 기다렸다 다시 본다. 그래도 남아 있으면 진짜로 멈춘 것이다.
   */
  loadingStuck: boolean;
}

const LOADING_RECHECK_MS = 2000;

export async function measureVisual(page: Page): Promise<VisualReading> {
  const first = await measureOnce(page);
  if (!first.loadingVisible) {
    const { loadingVisible: _ignored, ...metrics } = first;
    return { metrics, loadingStuck: false };
  }

  await page.waitForTimeout(LOADING_RECHECK_MS);
  const second = await measureOnce(page);
  const { loadingVisible, ...metrics } = second;
  return { metrics, loadingStuck: loadingVisible };
}

export { LOADING_PATTERN };
