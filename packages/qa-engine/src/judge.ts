import {
  SEVERITY_WEIGHT,
  toPriority,
  type Issue,
  type IssueCandidate,
  type Priority,
  type PriorityFactors,
  type Severity,
  type StateGraph,
} from "@qa/shared";

/**
 * Issue Judge Agent (룰 단계).
 *
 * 후보 → 최종 Issue. **같은 Root Cause는 Issue 1개 + Evidence N개.**
 * AI 보조 그룹핑은 Phase 4에서 이 위에 얹는다. AI는 병합만 제안할 수 있고 해체할 수 없다.
 */

const SEVERITY_ORDER: Severity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const PRIORITY_SORT: Priority[] = ["P0", "P1", "P2", "P3"];

function higher(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b;
}

/**
 * 발생 빈도 → 1~5.
 *
 * **원시 후보 수가 아니라 서로 다른 화면 수로 센다.**
 * 탐색기는 액션마다 원래 화면으로 되돌아가느라 같은 페이지를 수십 번 다시 연다.
 * 그때마다 같은 API 404가 다시 잡히므로 원시 후보 수는 실사용 빈도가 아니라
 * 크롤러의 이동 횟수를 반영한다(실측에서 404 하나가 후보 332건으로 잡혔다).
 * 사용자가 실제로 겪는 횟수는 "그 오류가 나는 화면이 몇 개인가"에 가깝다.
 */
function frequencyScore(count: number): number {
  if (count >= 21) return 5;
  if (count >= 9) return 4;
  if (count >= 4) return 3;
  if (count >= 2) return 2;
  return 1;
}

/** 영향받는 화면 수 → 1~5 */
function exposureScore(screens: number): number {
  if (screens >= 10) return 5;
  if (screens >= 5) return 4;
  if (screens >= 3) return 3;
  if (screens >= 2) return 2;
  return 1;
}

/**
 * 룰 id별 기본 수정 난이도(1~5). 낮을수록 고치기 쉽다.
 * AI가 붙으면(Phase 4) 이 값을 조정할 수 있다.
 */
const FIX_EFFORT: Record<string, number> = {
  "VIS-TRUNCATE": 1,
  "VIS-OVERLAP": 1,
  "VIS-OVERFLOW": 2,
  "VIS-HIDDEN-CTA": 2,
  "CON-ERROR": 2,
  "CON-REJECTION": 2,
  "CON-FRAMEWORK": 2,
  "CON-UNCAUGHT": 3,
  "NET-4XX": 3,
  "NET-SLOW": 3,
  "NET-AUTH": 3,
  "NET-5XX": 4,
  "NET-CORS": 3,
  "NET-TIMEOUT": 4,
  "FUNC-INFINITE-LOADING": 4,
};

/** 룰 id별 업무 영향도(1~5). */
const BUSINESS_IMPACT: Record<string, number> = {
  "VIS-TRUNCATE": 1,
  "VIS-OVERLAP": 1,
  "VIS-OVERFLOW": 2,
  "VIS-HIDDEN-CTA": 4,
  "CON-ERROR": 1,
  "CON-FRAMEWORK": 2,
  "CON-REJECTION": 2,
  "CON-UNCAUGHT": 4,
  "NET-4XX": 3,
  "NET-SLOW": 2,
  "NET-AUTH": 4,
  "NET-5XX": 5,
  "NET-CORS": 4,
  "NET-TIMEOUT": 4,
  "FUNC-INFINITE-LOADING": 5,
};

/**
 * 재현 절차를 그래프에서 자동 생성한다.
 * 시작 상태에서 목표 상태까지의 최단 경로를 BFS로 찾아 액션 라벨을 나열한다.
 */
function reproductionSteps(graph: StateGraph, targetStateKey: string): string[] {
  const start = graph.nodes[0];
  if (!start) return [];
  if (start.stateKey === targetStateKey) return ["1. 로그인", "2. 로그인 직후 화면"];

  const adjacency = new Map<string, Array<{ to: string; label: string }>>();
  for (const e of graph.edges) {
    const list = adjacency.get(e.fromStateKey) ?? [];
    list.push({ to: e.toStateKey, label: e.actionLabel });
    adjacency.set(e.fromStateKey, list);
  }

  const prev = new Map<string, { from: string; label: string }>();
  const queue = [start.stateKey];
  const seen = new Set([start.stateKey]);

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === targetStateKey) break;
    for (const next of adjacency.get(cur) ?? []) {
      if (seen.has(next.to)) continue;
      seen.add(next.to);
      prev.set(next.to, { from: cur, label: next.label });
      queue.push(next.to);
    }
  }

  if (!prev.has(targetStateKey)) {
    const node = graph.nodes.find((n) => n.stateKey === targetStateKey);
    return node ? ["1. 로그인", `2. ${node.url} 로 이동`] : ["1. 로그인"];
  }

  const labels: string[] = [];
  let cur = targetStateKey;
  while (cur !== start.stateKey) {
    const step = prev.get(cur);
    if (!step) break;
    labels.unshift(step.label);
    cur = step.from;
  }

  return ["1. 로그인", ...labels.map((l, i) => `${i + 2}. "${l}" 클릭`)];
}

const RECOMMENDATION: Record<string, string> = {
  "NET-5XX": "서버 예외 원인을 확인하고, 실패 시 사용자에게 오류를 안내하도록 처리하세요.",
  "NET-4XX": "요청 경로와 파라미터가 올바른지 확인하고, 없는 엔드포인트라면 호출을 제거하세요.",
  "NET-AUTH": "권한 검사 로직과 세션 유지 방식을 확인하세요.",
  "NET-TIMEOUT": "응답 지연 원인을 확인하고 타임아웃·재시도 정책을 정하세요.",
  "NET-CORS": "서버의 CORS 허용 origin 설정을 확인하세요.",
  "NET-FAILED": "요청이 왜 전송되지 못했는지(네트워크·차단·잘못된 URL) 확인하세요.",
  "NET-SLOW": "쿼리·인덱스·페이로드 크기를 점검하세요.",
  "CON-UNCAUGHT": "예외가 나는 지점을 방어 코드로 감싸고, 초기화 순서를 확인하세요.",
  "CON-REJECTION": "Promise에 catch를 붙이고 실패 시 사용자에게 안내하세요.",
  "CON-FRAMEWORK": "프레임워크 경고 내용을 확인하고 해당 컴포넌트를 수정하세요.",
  "CON-ERROR": "불필요한 오류 로그라면 제거하고, 실제 문제라면 원인을 처리하세요.",
  "VIS-OVERFLOW": "표나 컨테이너에 `overflow-x: auto`를 주어 본문이 가로로 밀리지 않게 하세요.",
  "VIS-OVERLAP": "절대 배치 대신 정상 흐름 배치를 쓰거나 여백을 확보하세요.",
  "VIS-TRUNCATE": "폭을 넓히거나 말줄임과 함께 전체 텍스트를 툴팁으로 제공하세요.",
  "VIS-HIDDEN-CTA": "버튼을 가리는 요소의 z-index와 배치를 조정하세요.",
  "FUNC-INFINITE-LOADING": "로딩 해제 조건과 실패 처리 경로를 확인하세요. 응답이 없어도 로딩은 끝나야 합니다.",
};

const IMPACT: Record<string, string> = {
  "NET-5XX": "해당 기능을 사용할 수 없습니다.",
  "NET-4XX": "해당 요청의 결과가 화면에 반영되지 않습니다.",
  "NET-AUTH": "권한이 있어야 할 사용자도 기능을 쓰지 못하거나, 반대로 노출될 수 있습니다.",
  "NET-TIMEOUT": "업무가 중단됩니다.",
  "NET-CORS": "해당 연동 기능이 동작하지 않습니다.",
  "NET-FAILED": "해당 요청에 의존하는 화면 요소가 비어 보입니다.",
  "NET-SLOW": "체감 속도가 떨어집니다.",
  "CON-UNCAUGHT": "예외 이후의 초기화가 중단되어 화면 일부가 동작하지 않을 수 있습니다.",
  "CON-REJECTION": "실패가 조용히 묻혀 사용자가 문제를 인지하지 못합니다.",
  "CON-FRAMEWORK": "렌더링이 의도와 다르게 동작할 수 있습니다.",
  "CON-ERROR": "직접적인 기능 영향은 확인되지 않았습니다.",
  "VIS-OVERFLOW": "가로 스크롤 때문에 내용을 한눈에 볼 수 없습니다.",
  "VIS-OVERLAP": "겹친 텍스트를 읽기 어렵습니다.",
  "VIS-TRUNCATE": "메뉴나 항목의 이름을 끝까지 읽을 수 없습니다.",
  "VIS-HIDDEN-CTA": "해당 동작을 실행할 수 없습니다.",
  "FUNC-INFINITE-LOADING": "화면 내용을 아예 볼 수 없어 업무가 진행되지 않습니다.",
};

export interface JudgeResult {
  issues: Issue[];
  /** 후보 몇 건이 몇 건으로 합쳐졌는지. 리포트에 그대로 쓴다. */
  mergedFrom: number;
}

export function judge(candidates: IssueCandidate[], graph: StateGraph): JudgeResult {
  // ── 1단계: dedupKey로 묶는다 ────────────────────────────────────────
  const groups = new Map<string, IssueCandidate[]>();
  for (const c of candidates) {
    const list = groups.get(c.dedupKey) ?? [];
    list.push(c);
    groups.set(c.dedupKey, list);
  }

  /** ID와 우선순위는 정렬이 끝난 뒤에 붙는다. 그전까지의 중간 형태. */
  type Merged = Omit<Issue, "id" | "priority"> & { priorityFactors: PriorityFactors };
  const merged: Merged[] = [];

  for (const [dedupKey, list] of groups) {
    const first = list[0]!;
    const severity = list.reduce<Severity>((acc, c) => higher(acc, c.suggestedSeverity), "LOW");
    // 하나도 버리지 않고 전부 합친다.
    const evidenceIds = [...new Set(list.flatMap((c) => c.evidenceIds))];
    const screens = [...new Set(list.map((c) => c.screenName))];
    const distinctStates = new Set(list.map((c) => c.stateKey)).size;

    const factors: PriorityFactors = {
      severityWeight: SEVERITY_WEIGHT[severity],
      businessImpact: BUSINESS_IMPACT[first.ruleId] ?? 3,
      frequency: frequencyScore(distinctStates),
      userExposure: exposureScore(screens.length),
      fixEffort: FIX_EFFORT[first.ruleId] ?? 3,
      score: 0,
    };
    factors.score =
      Math.round(
        ((factors.severityWeight * factors.businessImpact * factors.frequency * factors.userExposure) /
          factors.fixEffort) *
          10,
      ) / 10;

    merged.push({
      title: first.title,
      source: first.source,
      ruleId: first.ruleId,
      severity,
      screens,
      description: first.description,
      impact: IMPACT[first.ruleId] ?? "영향 범위는 확인이 필요합니다.",
      reproduction: reproductionSteps(graph, first.stateKey),
      recommendation: RECOMMENDATION[first.ruleId] ?? "원인을 확인하고 수정하세요.",
      evidenceIds,
      occurrenceCount: list.length,
      dedupKey,
      priorityFactors: factors,
    });
  }

  // ── 2단계: 우선순위 → 점수 → 심각도 순으로 정렬한 뒤 ID 부여 ─────────
  //
  // **우선순위가 첫 번째 기준이다.** 점수만으로 정렬하면 P0이 P1보다 뒤에 오는
  // 리포트가 나온다(점수는 대역 안에서만 의미가 있다).
  // 마지막에 룰 id·dedupKey로 안정 정렬하는 이유는, 정렬이 흔들리면 Run마다
  // QA-0001이 다른 이슈를 가리켜 회귀 비교가 불가능해지기 때문이다.
  const withPriority = merged.map((m) => ({
    ...m,
    priority: toPriority(m.priorityFactors.score, m.severity),
  }));

  withPriority.sort((a, b) => {
    const byPriority = PRIORITY_SORT.indexOf(a.priority) - PRIORITY_SORT.indexOf(b.priority);
    if (byPriority !== 0) return byPriority;
    if (b.priorityFactors.score !== a.priorityFactors.score) {
      return b.priorityFactors.score - a.priorityFactors.score;
    }
    const bySeverity = SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity);
    if (bySeverity !== 0) return bySeverity;
    return a.ruleId.localeCompare(b.ruleId) || a.dedupKey.localeCompare(b.dedupKey);
  });

  const issues: Issue[] = withPriority.map((m, i) => ({
    ...m,
    id: `QA-${String(i + 1).padStart(4, "0")}`,
  }));

  return { issues, mergedFrom: candidates.length };
}
