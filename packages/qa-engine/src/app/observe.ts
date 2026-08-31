import { sha1 } from "../normalize.js";

/**
 * 화면 관찰 — UI 트리 덤프에서 요소와 지문을 뽑는다.
 *
 * 웹의 `discover.ts` + `fingerprint.ts` 에 해당한다. 원리는 같지만 신호가 다르다.
 *
 * **앱에는 URL 이 없다.** 웹 지문의 절반(pathTemplate·queryKeys)이 통째로 없으므로
 * 남은 것으로 화면을 구별해야 한다. `mobile/explore.py` 는 눌러 본 **라벨 문자열**로만
 * 중복을 막았는데, 그러면 같은 라벨("확인", "저장")이 여러 화면에 있을 때
 * 그중 하나를 통째로 건너뛴다.
 */

/** UI 트리에서 뽑아낸 요소 하나. */
export interface AppElement {
  /** content-desc 우선, 없으면 text */
  label: string;
  /** 안드로이드 위젯 클래스. 구조 지문에 쓴다. */
  className: string;
  resourceId: string | null;
  /** 탭할 좌표(요소 중앙) */
  x: number;
  y: number;
  bounds: [number, number, number, number];
  clickable: boolean;
  enabled: boolean;
  scrollable: boolean;
}

export interface AppScreen {
  /** 같은 화면을 두 번 탐색하지 않기 위한 키 */
  stateKey: string;
  /** 사람이 읽을 이름 */
  screenName: string;
  elements: AppElement[];
  /** 화면에 그대로 노출된 예외 문자열 등 */
  screenErrors: string[];
  /** 스크롤 가능한 화면인가. 숨은 요소를 찾을지 판단한다. */
  scrollable: boolean;
}

/**
 * 화면에 이런 문자열이 보이면 그 자체가 결함이다.
 * 사용자에게 raw 예외를 보여주는 것은 어떤 경우에도 정상이 아니다.
 */
export const SCREEN_ERROR_PATTERNS = [
  "FATAL EXCEPTION",
  "Unhandled Exception",
  "TimeoutException",
  "StateError",
  "RangeError",
  "NoSuchMethodError",
  "Null check operator",
  "SocketException",
  "FormatException",
  "HandshakeException",
  "java.lang.",
  "at dart:",
];

/** `[0,84][1080,210]` → 좌표 */
function parseBounds(raw: string | undefined): AppElement["bounds"] | null {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(raw ?? "");
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

/** XML 속성을 뽑는다. 파서를 들이지 않고 정규식으로 읽는다 — 구조가 단순하고 고정적이다. */
function attr(node: string, name: string): string {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(node);
  return m ? m[1]! : "";
}

/**
 * 화면 이름.
 *
 * 앱바 제목이 가장 좋은 후보다. 없으면 화면 위쪽의 첫 텍스트를 쓴다.
 * 그것도 없으면 지문 앞자리를 쓴다 — 이름이 없다고 화면을 못 세면 안 된다.
 */
function nameOf(elements: AppElement[], texts: string[], stateKey: string): string {
  const top = texts.find((t) => t.trim().length >= 2 && t.trim().length <= 30);
  if (top) return top.trim();
  const firstLabel = elements.find((e) => e.label.trim() !== "")?.label;
  return firstLabel?.trim() || `화면-${stateKey.slice(0, 8)}`;
}

/**
 * 구조 지문.
 *
 * **구조는 넣고 데이터는 뺀다** (CLAUDE.md §27-2). 목록에 항목이 몇 개든,
 * 오늘 날짜가 무엇이든 같은 화면이어야 한다. 그래서 텍스트 값은 넣지 않고
 * 클래스·resource-id·클릭 가능 여부만 넣는다.
 *
 * 형제 중 결과가 같은 것은 접는다 — 목록 10행과 3행이 다른 화면이 되면
 * 데이터가 바뀔 때마다 탐색이 끝나지 않는다.
 */
function structureHash(elements: AppElement[], allNodes: string[]): string {
  const shape = allNodes
    .map((n) => {
      const cls = attr(n, "class").split(".").pop() ?? "";
      const id = attr(n, "resource-id").split("/").pop() ?? "";
      const click = attr(n, "clickable") === "true" ? "c" : "";
      return `${cls}#${id}${click}`;
    })
    .filter((s) => s !== "#");

  return sha1([...new Set(shape)].sort().join("|") + `|n=${elements.length > 0 ? "y" : "n"}`);
}

/**
 * UI 덤프를 읽는다.
 *
 * 덤프가 비어 있으면 **빈 화면이 아니라 "읽지 못했다"** 이다. 그 둘을 구분해
 * 호출자가 기록할 수 있게 `null` 을 돌려준다.
 */
export function readScreen(xml: string): AppScreen | null {
  if (!xml.includes("<hierarchy")) return null;

  const nodes = xml.match(/<node\b[^>]*>/g) ?? [];
  const elements: AppElement[] = [];
  const texts: string[] = [];
  const screenErrors: string[] = [];
  let scrollable = false;

  for (const node of nodes) {
    const desc = attr(node, "content-desc");
    const text = attr(node, "text");
    const label = desc || text;
    if (text.trim() !== "") texts.push(text);

    const combined = `${desc} ${text}`;
    for (const pattern of SCREEN_ERROR_PATTERNS) {
      if (combined.toLowerCase().includes(pattern.toLowerCase())) {
        screenErrors.push(combined.trim().slice(0, 300));
        break;
      }
    }

    if (attr(node, "scrollable") === "true") scrollable = true;

    const bounds = parseBounds(attr(node, "bounds"));
    if (!bounds) continue;
    const [x1, y1, x2, y2] = bounds;
    // 넓이가 0인 요소는 화면에 없다. 탭해도 아무 일도 일어나지 않는다.
    if (x2 <= x1 || y2 <= y1) continue;

    const clickable = attr(node, "clickable") === "true";
    if (!clickable || label.trim() === "") continue;

    elements.push({
      label: label.trim(),
      className: attr(node, "class"),
      resourceId: attr(node, "resource-id") || null,
      x: Math.floor((x1 + x2) / 2),
      y: Math.floor((y1 + y2) / 2),
      bounds,
      clickable,
      enabled: attr(node, "enabled") !== "false",
      scrollable: attr(node, "scrollable") === "true",
    });
  }

  const stateKey = structureHash(elements, nodes);
  return {
    stateKey,
    screenName: nameOf(elements, texts, stateKey),
    elements,
    screenErrors: [...new Set(screenErrors)],
    scrollable,
  };
}

/** logcat 줄에서 이상만 추린다. */
export const LOGCAT_PATTERNS = [
  "FATAL EXCEPTION",
  "E/AndroidRuntime",
  "ANR in",
  "Unhandled Exception",
  "TimeoutException",
  "StateError",
  "RangeError",
  "NoSuchMethodError",
  "Null check operator used on a null value",
];

export function pickLogcatErrors(lines: readonly string[]): string[] {
  const hits: string[] = [];
  for (const line of lines) {
    if (LOGCAT_PATTERNS.some((p) => line.includes(p))) hits.push(line.trim().slice(0, 300));
  }
  return [...new Set(hits)];
}
