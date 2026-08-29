import type { Page } from "playwright";
import type { PageState, StateSignals } from "@qa/shared";
import { pathTemplate, queryKeys, sha1 } from "./normalize.js";

/**
 * 상태 지문.
 *
 * "이 화면을 이미 봤는가"를 판정한다. 자율 탐색의 성패가 전부 여기 달려 있다.
 * 너무 예민하면 탐색이 끝나지 않고, 너무 둔하면 화면을 통째로 건너뛴다.
 *
 * 원칙: **구조는 넣고 데이터는 뺀다.**
 */

/** 브라우저 안에서 재는 값들. 여기 함수는 페이지 컨텍스트에서 실행되므로 self-contained여야 한다. */
interface RawSignals {
  title: string;
  heading: string;
  activeTab: string | null;
  dialogTitle: string | null;
  navLabels: string[];
  structure: string;
}

const STRUCTURE_MAX_DEPTH = 6;

async function readRawSignals(page: Page): Promise<RawSignals> {
  return page.evaluate((maxDepth: number) => {
    const text = (el: Element | null): string => (el?.textContent ?? "").trim().replace(/\s+/g, " ");

    const visible = (el: Element): boolean => {
      if (typeof (el as HTMLElement).checkVisibility === "function") {
        return (el as HTMLElement).checkVisibility();
      }
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    };

    // ── heading ───────────────────────────────────────────────────────
    const heading = text(document.querySelector("h1") ?? document.querySelector("h2")).slice(0, 120);

    // ── 활성 탭 ────────────────────────────────────────────────────────
    const tabEl = document.querySelector("[role=tab][aria-selected=true]");
    const activeTab = tabEl ? text(tabEl).slice(0, 60) : null;

    // ── 열린 다이얼로그 ────────────────────────────────────────────────
    let dialogTitle: string | null = null;
    const openDialog =
      document.querySelector("dialog[open]") ??
      Array.from(document.querySelectorAll("[role=dialog]")).find((d) => visible(d)) ??
      null;
    if (openDialog) {
      const label =
        openDialog.getAttribute("aria-label") ??
        text(openDialog.querySelector("h1, h2, h3, [role=heading]"));
      dialogTitle = (label || "dialog").slice(0, 80);
    }

    // ── 내비게이션 라벨 ────────────────────────────────────────────────
    const navRoot = document.querySelector("nav, [role=navigation]");
    const navLabels = navRoot
      ? Array.from(navRoot.querySelectorAll("a"))
          .filter((a) => visible(a))
          .map((a) => text(a).slice(0, 40))
          .filter(Boolean)
          .sort()
      : [];

    /**
     * 주요 콘텐츠 영역의 구조 직렬화.
     *
     * 1. 보이지 않는 요소는 건너뛴다 — 스피너만 보이는 로딩 화면을 정상 화면과 구별하려면 필요하다.
     * 2. 형제 중 **직렬화 결과가 같은 것은 하나로 접는다.** 목록 10행과 3행이 다른 화면으로
     *    보이면 데이터가 바뀔 때마다 새 상태가 생긴다.
     * 3. 접은 뒤 정렬한다. 페이저의 현재 페이지 표시(span)가 앞뒤로 움직여도 같은 화면이다.
     * 4. 텍스트는 넣지 않는다.
     */
    const serialize = (el: Element, depth: number): string => {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role");
      const testid = el.getAttribute("data-testid");
      const head = tag + (role ? `[${role}]` : "") + (testid ? `#${testid}` : "");
      if (depth >= maxDepth) return head;

      const children = Array.from(el.children)
        .filter((c) => visible(c))
        .map((c) => serialize(c, depth + 1));

      const collapsed = Array.from(new Set(children)).sort();
      return collapsed.length > 0 ? `${head}(${collapsed.join(",")})` : head;
    };

    const main =
      document.querySelector("main") ??
      document.querySelector("[role=main]") ??
      document.querySelector("#content") ??
      document.body;

    return {
      title: document.title.slice(0, 160),
      heading,
      activeTab,
      dialogTitle,
      navLabels,
      structure: serialize(main, 0),
    };
  }, STRUCTURE_MAX_DEPTH);
}

/**
 * 화면 이름. 리포트와 파일명에 그대로 쓰인다.
 *
 * 서로 다른 상태가 같은 이름을 갖지 않도록 탭과 다이얼로그를 덧붙인다.
 * (설정의 일반/알림/보안 탭은 heading이 전부 "설정"이라 그냥 두면 셋 다 같은 이름이 된다)
 */
function makeScreenName(signals: StateSignals): string {
  let name =
    signals.heading || signals.activeTab || signals.title.split("|")[0]?.trim() || signals.pathTemplate;
  if (signals.activeTab && signals.activeTab !== name) name = `${name} > ${signals.activeTab}`;
  if (signals.dialogTitle) name = `${name} > ${signals.dialogTitle}`;
  return name;
}

export async function computeSignals(page: Page): Promise<StateSignals> {
  const raw = await readRawSignals(page);
  const url = new URL(page.url());

  return {
    pathTemplate: pathTemplate(url.pathname),
    // 쿼리 키는 사람이 읽으라고 남기는 값이다. stateKey 계산에는 넣지 않는다 (아래 주석 참고).
    queryKeys: queryKeys(url.search),
    title: raw.title,
    heading: raw.heading,
    activeTab: raw.activeTab,
    dialogTitle: raw.dialogTitle,
    navLabels: raw.navLabels,
    structureHash: sha1(raw.structure),
  };
}

/**
 * 지문 계산.
 *
 * **queryKeys는 stateKey에 넣지 않는다.**
 *
 * 처음에는 넣으려 했지만 fixture에서 바로 깨졌다. `/users` 목록에서
 *   - 검색 버튼    → `?keyword=`                     (키 1개)
 *   - 정렬 헤더    → `?keyword=&sort=&dir=&page=`     (키 4개)
 *   - 페이저       → `?keyword=&sort=&dir=&page=`     (키 4개)
 * 처럼 같은 화면인데 키 집합이 달라져 상태가 갈라진다.
 *
 * 정렬·페이징·필터가 **동작했는지**는 상태 수가 아니라 `ActionResult`와 그 구간의
 * 네트워크 기록으로 검증한다. 겉모습이 실제로 달라지는 필터(예: 로딩만 보이는 화면)는
 * structureHash가 알아서 구별한다.
 */
export function stateKeyOf(signals: StateSignals): string {
  return sha1(
    JSON.stringify([
      signals.pathTemplate,
      signals.heading,
      signals.activeTab,
      signals.dialogTitle,
      signals.navLabels,
      signals.structureHash,
    ]),
  );
}

export async function readState(
  page: Page,
  depth: number,
  arrivedByActionId: string | null,
): Promise<PageState> {
  const signals = await computeSignals(page);
  return {
    stateKey: stateKeyOf(signals),
    signals,
    url: page.url(),
    depth,
    arrivedByActionId,
    visitedAt: new Date().toISOString(),
    screenName: makeScreenName(signals),
  };
}
