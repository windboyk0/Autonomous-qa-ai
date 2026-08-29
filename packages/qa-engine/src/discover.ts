import type { Page } from "playwright";
import type { ActionType, DiscoveredAction, SafetyPolicy } from "@qa/shared";
import { classify, type ClassifyInput } from "./classify.js";
import { sha1 } from "./normalize.js";

/**
 * Action Discovery.
 *
 * 한 화면에서 실행 가능한 후보를 전부 찾는다. 판정은 하지 않고 사실만 모은다.
 * 위험도는 classify.ts가 매긴다.
 */

/** 브라우저에서 긁어오는 날것의 후보. */
interface RawCandidate extends ClassifyInput {
  selector: string;
  selectorStrategy: "testid" | "role" | "text" | "css";
  domIndex: number;
}

const DISCOVERY_LIMIT = 200;

async function readCandidates(page: Page): Promise<RawCandidate[]> {
  return page.evaluate((limit: number) => {
    const text = (el: Element): string =>
      (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ");

    const visible = (el: Element): boolean => {
      if (typeof (el as HTMLElement).checkVisibility === "function") {
        return (el as HTMLElement).checkVisibility();
      }
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    };

    /** CSS 경로. testid가 없을 때의 최후 수단. */
    const cssPath = (el: Element): string => {
      const parts: string[] = [];
      let node: Element | null = el;
      while (node && node.nodeType === 1 && parts.length < 8) {
        const tag = node.tagName.toLowerCase();
        if (node.id) {
          parts.unshift(`#${CSS.escape(node.id)}`);
          break;
        }
        const parent: Element | null = node.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
        parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag);
        node = parent;
      }
      return parts.join(" > ");
    };

    const selectors = "a[href], button, [role=button], [role=tab], summary";

    /**
     * 모달이 열려 있으면 그 안만 훑는다.
     *
     * `<dialog>`는 열려 있는 동안 바깥 요소를 inert로 만든다. 그걸 모르고 뒤에 있는
     * 메뉴를 클릭하면 전부 타임아웃으로 실패하고, 리포트가 가짜 FAILED로 뒤덮인다.
     * 실제 사용자도 모달이 열려 있으면 모달 안에서만 조작한다.
     */
    const openDialog =
      document.querySelector("dialog[open]") ??
      Array.from(document.querySelectorAll("[role=dialog]")).find((d) => visible(d)) ??
      null;
    const root: ParentNode = openDialog ?? document;

    const out: RawCandidate[] = [];
    let domIndex = 0;

    for (const el of Array.from(root.querySelectorAll(selectors))) {
      if (out.length >= limit) break;
      domIndex += 1;
      if (!visible(el)) continue;
      if ((el as HTMLButtonElement).disabled) continue;

      const tagName = el.tagName.toLowerCase();
      const rawHref = el.getAttribute("href");
      // 앵커 링크와 javascript: 는 이동이 아니다
      if (rawHref !== null && (rawHref.startsWith("#") || rawHref.startsWith("javascript:"))) continue;

      const label = text(el).slice(0, 120);
      if (!label) continue;

      const testId = el.getAttribute("data-testid");
      let selector: string;
      let selectorStrategy: RawCandidate["selectorStrategy"];
      if (testId) {
        selector = `[data-testid="${testId}"]`;
        selectorStrategy = "testid";
      } else if (rawHref) {
        selector = `a[href="${rawHref}"]`;
        selectorStrategy = "css";
      } else {
        selector = cssPath(el);
        selectorStrategy = "css";
      }

      out.push({
        label,
        href: rawHref ? new URL(rawHref, document.baseURI).toString() : null,
        tagName,
        role: el.getAttribute("role"),
        type: el.getAttribute("type"),
        className: el.getAttribute("class") ?? "",
        testId,
        inForm: el.closest("form") !== null,
        inTableHeader: el.closest("thead") !== null,
        selector,
        selectorStrategy,
        domIndex,
      });
    }

    return out;
  }, DISCOVERY_LIMIT);
}

function actionTypeOf(c: RawCandidate): ActionType {
  if (c.role === "tab") return "NAVIGATE";
  if (c.tagName === "a") return "NAVIGATE";
  if (c.inForm && c.type === "submit") return "SUBMIT";
  return "CLICK";
}

/**
 * 액션 id는 내용으로 정한다(난수 금지).
 * 같은 화면을 두 번 탐색해도 같은 id가 나와야 결정성 검증이 가능하다.
 */
function actionIdOf(stateKey: string, c: RawCandidate): string {
  return `act-${sha1(`${stateKey}|${c.selector}|${c.label}|${c.domIndex}`).slice(0, 12)}`;
}

export async function discoverActions(
  page: Page,
  state: { stateKey: string; screenName: string },
  policy: SafetyPolicy,
): Promise<DiscoveredAction[]> {
  const raw = await readCandidates(page);

  // 같은 셀렉터+라벨이 여러 번 잡히면 첫 번째만 쓴다 (목록의 반복 링크 등).
  const seen = new Set<string>();
  const actions: DiscoveredAction[] = [];

  for (const c of raw) {
    const dedupe = `${c.selector}|${c.label}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    const verdict = classify(c, policy);
    actions.push({
      id: actionIdOf(state.stateKey, c),
      type: actionTypeOf(c),
      label: c.label,
      selector: c.selector,
      selectorStrategy: c.selectorStrategy,
      risk: verdict.risk,
      riskReason: verdict.reason,
      confidence: verdict.confidence,
      stateKey: state.stateKey,
      screenName: state.screenName,
    });
  }

  return actions;
}
