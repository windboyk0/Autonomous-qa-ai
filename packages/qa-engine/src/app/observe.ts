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

/**
 * XML 엔티티를 되돌린다.
 *
 * uiautomator 는 줄바꿈을 `&#10;` 으로 적어 보낸다. 그대로 두면 라벨이
 * `홈&#10;탭 4개 중 1번째` 처럼 나와 리포트에도 그 모양으로 실린다(실측).
 * 사람이 읽을 것이므로 사람이 읽는 모양으로 되돌린다.
 */
function unescapeXml(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // amp 는 마지막에 푼다. 먼저 풀면 &amp;lt; 가 < 로 잘못 바뀐다.
    .replace(/&amp;/g, "&");
}

/** XML 속성을 뽑는다. 파서를 들이지 않고 정규식으로 읽는다 — 구조가 단순하고 고정적이다. */
function attr(node: string, name: string): string {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(node);
  return m ? unescapeXml(m[1]!) : "";
}

/** 이름으로 쓰면 안 되는 것들. 화면이 아니라 화면을 덮는 장치다. */
const CHROME_LABEL =
  /^(스크림|scrim|overlay|backdrop|dim|뒤로|back|navigate up|위로 이동|탐색 열기|open navigation)$/i;

/** 이름 후보 하나. 어디에 얼마만 하게 있는지까지 들고 다닌다. */
interface LabelBox {
  text: string;
  /** 왼쪽 위 y. 앱바 제목을 고르는 기준이다. */
  y: number;
  width: number;
  height: number;
  clickable: boolean;
}

/**
 * 화면 이름.
 *
 * 사람은 앱바 제목으로 화면을 부른다. 그것을 고른다.
 *
 * 두 번 틀렸고 두 번 다 실기기에서만 드러났다.
 *
 *   1. 처음에는 덤프에 먼저 나오는 라벨을 썼다. 서랍 메뉴가 트리 앞쪽이라
 *      화면 8개가 전부 "메뉴" 였다.
 *   2. 다음에는 `text` 속성 중 가장 위엣것을 썼다. **Flutter 앱은 text 를
 *      거의 쓰지 않는다** — 라벨이 전부 content-desc 로 온다. 그래서 후보가
 *      0개가 되어 다시 문서 순서로 떨어졌고, 여전히 "메뉴" 였다.
 *
 * 그래서 이번에는 text·content-desc 를 **함께** 보고, 생김새로 거른다.
 *   - 화면을 통째로 덮는 것은 컨테이너나 스크림이지 제목이 아니다.
 *   - 작고 네모난 것은 아이콘 버튼(햄버거·알림·로그아웃)이지 제목이 아니다.
 *   - 제목은 보통 **누를 수 없다.** 그래서 못 누르는 것을 먼저 본다.
 */
function nameOf(labels: LabelBox[], screen: { width: number; height: number }, stateKey: string): string {
  const isFullScreen = (l: LabelBox) =>
    screen.width > 0 && l.width >= screen.width * 0.9 && l.height >= screen.height * 0.7;

  // 아이콘 버튼: 화면 폭의 15% 미만이면서 대체로 정사각형.
  const isIcon = (l: LabelBox) =>
    screen.width > 0 &&
    l.width < screen.width * 0.15 &&
    l.height > 0 &&
    l.width / l.height > 0.5 &&
    l.width / l.height < 2;

  const candidates = labels.filter((l) => {
    const t = l.text.trim();
    if (t.length < 2 || t.length > 30) return false;
    if (CHROME_LABEL.test(t)) return false;
    if (isFullScreen(l)) return false;
    if (isIcon(l)) return false;
    return true;
  });

  candidates.sort((a, b) => {
    // 제목은 누를 수 없는 쪽이다.
    if (a.clickable !== b.clickable) return a.clickable ? 1 : -1;
    if (a.y !== b.y) return a.y - b.y;
    // 같은 높이면 넓은 쪽이 제목이다. 아이콘보다 글자가 넓다.
    return b.width - a.width;
  });

  if (candidates.length > 0) return candidates[0]!.text.trim();
  return `화면-${stateKey.slice(0, 8)}`;
}

/** 목록으로 볼 최소 형제 수. 이만큼 반복되면 데이터로 본다. */
const LIST_GROUP_MIN = 3;

/** 숫자는 데이터다. `2026-08-31` 과 `2026-09-01` 은 같은 화면이어야 한다. */
function maskDigits(text: string): string {
  return text.replace(/\d+/g, "#");
}

/**
 * 화면 지문.
 *
 * **구조는 넣고 데이터는 뺀다** (CLAUDE.md §27-2). 그런데 앱에서는 그 경계가
 * 웹과 다르다.
 *
 * 처음에는 클래스·resource-id 만 넣고 라벨을 전부 뺐다. 그랬더니 **모든 화면이
 * 같은 지문**이 됐다 — Flutter 덤프는 대부분 `android.view.View` 에
 * resource-id 도 없어서, 남는 것이 없었다(실측: 4개 화면이 1개로 보였다).
 *
 * 그래서 웹이 `heading` 과 `navLabels` 를 지문에 넣는 것과 같은 이유로
 * **제목과 클릭 요소의 라벨을 넣는다.** 다만 목록처럼 반복되는 형제는 접는다 —
 * 사용자 47명이 47개 화면이 되면 탐색이 끝나지 않는다.
 */
function fingerprint(title: string, elements: AppElement[], allNodes: string[]): string {
  // 1. 화면 뼈대. 반복되는 것은 한 번만 센다.
  const skeleton = [
    ...new Set(
      allNodes
        .map((n) => {
          const cls = attr(n, "class").split(".").pop() ?? "";
          const id = attr(n, "resource-id").split("/").pop() ?? "";
          return `${cls}#${id}`;
        })
        .filter((x) => x !== "#"),
    ),
  ].sort();

  /*
   * 2. 클릭 요소. 같은 모양이 여러 번 나오면 **목록**으로 보고 라벨을 버린다.
   *    폭까지 같아야 같은 모양으로 본다 — 나란한 버튼과 목록 행을 구별하기 위해서다.
   */
  const groupKey = (e: AppElement) =>
    `${e.className.split(".").pop() ?? ""}#${e.resourceId?.split("/").pop() ?? ""}@${e.bounds[2] - e.bounds[0]}`;

  const counts = new Map<string, number>();
  for (const e of elements) counts.set(groupKey(e), (counts.get(groupKey(e)) ?? 0) + 1);

  const clickShape = [
    ...new Set(
      elements.map((e) => {
        const key = groupKey(e);
        return (counts.get(key) ?? 0) >= LIST_GROUP_MIN
          ? `${key}×목록`
          : `${key}:${maskDigits(e.label)}`;
      }),
    ),
  ].sort();

  return sha1([maskDigits(title), skeleton.join("|"), clickShape.join("|")].join("||"));
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
  const labels: LabelBox[] = [];
  const screenErrors: string[] = [];
  let scrollable = false;
  /*
   * 화면 크기는 **덤프에서 읽는다.** 가장 큰 노드가 루트다.
   * 기기에 다시 물으면 왕복이 한 번 더 늘고, 회전 상태가 다를 수도 있다.
   */
  const screen = { width: 0, height: 0 };
  /** 화면을 통째로 덮는 누를 수 있는 것 = 팝업을 닫는 스크림. */
  let modalOpen = false;

  for (const node of nodes) {
    const desc = attr(node, "content-desc");
    const text = attr(node, "text");
    const label = desc || text;
    const box = parseBounds(attr(node, "bounds"));
    if (box) {
      const [bx1, by1, bx2, by2] = box;
      if ((bx2 - bx1) * (by2 - by1) > screen.width * screen.height) {
        screen.width = bx2 - bx1;
        screen.height = by2 - by1;
      }
      if (label.trim() !== "") {
        labels.push({
          text: label.replace(/\s+/g, " ").trim(),
          y: by1,
          width: bx2 - bx1,
          height: by2 - by1,
          clickable: attr(node, "clickable") === "true",
        });
      }
    }

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
      // 줄바꿈이 든 라벨(탭 설명 등)은 한 줄로 모은다. 표와 로그가 깨진다.
      label: label.replace(/\s+/g, " ").trim(),
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

  /*
   * 팝업이 떠 있으면 이름에 밝힌다.
   *
   * 바텀시트가 열린 화면과 안 열린 화면은 제목이 같다. 리포트에 같은 이름이
   * 두 번 나오면 사용자는 도구가 같은 화면을 두 번 셌다고 생각한다(실측:
   * 시트가 열린 화면이 "스크림"으로 나왔다 — 이름은 틀렸지만 다른 화면인 것은
   * 맞았다). 다른 화면이면 다르게 부른다.
   */
  for (const l of labels) {
    if (l.clickable && screen.width > 0 && l.width >= screen.width * 0.9 && l.height >= screen.height * 0.7) {
      modalOpen = true;
      break;
    }
    if (CHROME_LABEL.test(l.text.trim())) modalOpen = true;
  }

  const base = nameOf(labels, screen, "");
  const title = modalOpen ? `${base} (팝업)` : base;
  const stateKey = fingerprint(title, elements, nodes);
  return {
    stateKey,
    screenName: title,
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
