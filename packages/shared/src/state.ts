import { z } from "zod";

/**
 * 화면 상태(State) 계약.
 *
 * 자율탐색의 성패는 "두 화면이 같은 화면인가"를 판정하는 이 지문(fingerprint)에 달려 있다.
 * 원칙: **구조는 넣고 데이터는 뺀다.**
 *   - 목록의 행 개수나 셀 텍스트를 지문에 넣으면, 데이터가 바뀔 때마다 새 화면으로 오인해
 *     탐색이 끝나지 않는다.
 *   - 반대로 URL만 쓰면 SPA의 탭/모달 전환을 전부 놓친다.
 */

export const StateSignals = z.object({
  /** origin 제외한 pathname. 숫자/UUID 경로 세그먼트는 :id 로 정규화한다. */
  pathTemplate: z.string(),
  /** 정규화된 쿼리 키 목록(값 제외). 예: ["page","keyword"] */
  queryKeys: z.array(z.string()),
  /** 문서 제목 */
  title: z.string(),
  /** 주 제목 (h1 우선, 없으면 첫 h2) */
  heading: z.string(),
  /** 활성 탭 라벨 (role=tab[aria-selected=true]) */
  activeTab: z.string().nullable(),
  /** 열려 있는 다이얼로그 제목. 없으면 null */
  dialogTitle: z.string().nullable(),
  /** 좌측/상단 내비게이션 라벨 목록 (정렬 후 사용) */
  navLabels: z.array(z.string()),
  /**
   * 주요 콘텐츠 영역의 태그 구조 해시.
   * main/[role=main]/#content 중 첫 매치를 대상으로, 텍스트 노드를 제거하고
   * tagName + role + data-testid 만 남긴 트리를 직렬화해 sha1.
   */
  structureHash: z.string(),
});
export type StateSignals = z.infer<typeof StateSignals>;

export const PageState = z.object({
  /** StateSignals 전체를 sha1한 값. 탐색 큐의 중복 판정 키. */
  stateKey: z.string(),
  signals: StateSignals,
  url: z.string(),
  depth: z.number().int().nonnegative(),
  /** 이 상태에 처음 도달하게 만든 액션 id. 시작 화면은 null */
  arrivedByActionId: z.string().nullable(),
  visitedAt: z.string().datetime(),
  /** 사람이 읽을 화면 이름. heading > activeTab > title > pathTemplate 순으로 채운다. */
  screenName: z.string(),
});
export type PageState = z.infer<typeof PageState>;

/** 탐색 그래프. runs/<runId>/graph.json 으로 저장된다. */
export const StateGraph = z.object({
  nodes: z.array(PageState),
  edges: z.array(
    z.object({
      fromStateKey: z.string(),
      toStateKey: z.string(),
      actionId: z.string(),
      actionLabel: z.string(),
    }),
  ),
});
export type StateGraph = z.infer<typeof StateGraph>;
