import type { RiskLevel, SafetyPolicy } from "@qa/shared";

/**
 * Action Classifier Agent.
 *
 * 이 판정이 틀리면 대상 시스템의 실데이터가 날아간다.
 * 가장 보수적으로 동작해야 하는 모듈이며, **애매하면 항상 더 위험한 쪽**을 택한다.
 */

export interface ClassifyInput {
  label: string;
  /** a 태그면 href, 아니면 null */
  href: string | null;
  tagName: string;
  role: string | null;
  type: string | null;
  className: string;
  testId: string | null;
  /** 폼 안의 제출 버튼인가 */
  inForm: boolean;
  /** 테이블 헤더 안인가. 그렇다면 정렬 컨트롤일 가능성이 매우 높다. */
  inTableHeader: boolean;
}

export interface Classification {
  risk: RiskLevel;
  reason: string;
  confidence: number;
}

const SAFE_WORDS =
  /(조회|검색|상세|목록|보기|열기|닫기|취소|이전|다음|처음|마지막|정렬|페이지|탭|더보기|필터|전체)/;

const CAUTION_WORDS = /(등록|저장|수정|추가|첨부|업로드|복사|입력|작성|변경사항)/;

const DANGEROUS_WORDS =
  /(삭제|제거|차단|잠금|해제|권한|승인|반려|게시|배포|발송|전송|초기화|일괄|전체\s*삭제|탈퇴|비활성|폐기|이관|동기화|실행)/;

const DANGEROUS_CLASS = /(danger|destructive|delete|remove|warn)/i;

/**
 * "폼을 여는" 표식과 "쓰기를 끝내는" 라벨.
 *
 * 여는 표식은 **명시적인 것만** 인정한다. 맨 "등록"·"추가"는 폼을 여는 버튼일 수도,
 * form 태그 없이 만든 화면의 저장 버튼일 수도 있어 판정이 갈린다.
 * 애매하면 위험한 쪽이므로 그런 라벨은 낮추지 않는다.
 */
const OPEN_FORM_MARK = /(^\+|신규|새로|^새 | 새 |만들기|생성\s|\bnew\b|\bcreate\b|\badd\b)/i;
const WRITE_FINISH_LABEL =
  /(저장|save|제출|submit|확인|완료|적용|반영|등록하기|추가하기|수정하기|보내기)/i;

/** 폼 열기 버튼으로 판정했을 때의 사유 접두사. CRUD 단계가 이 문자열로 되짚는다. */
export const OPEN_FORM_REASON = "폼을 여는 버튼";

/**
 * GET 링크인데도 상태를 바꿀 것 같은 경로. 링크를 SAFE로 낮출 때의 안전망이다.
 * 정상적인 앱이라면 GET은 아무것도 쓰지 않지만, 그렇지 않은 관리자웹이 흔하다.
 */
const DESTRUCTIVE_HREF =
  /\/(delete|remove|destroy|disable|reject|approve|publish|send|reset)\b/i;
const MUTATING_HREF = /\/(save|update|insert|create|enable)\b/i;

/** 라벨을 정규화한다. 정렬 표시(▲▼)나 공백 차이로 판정이 흔들리면 안 된다. */
export function normalizeLabel(label: string): string {
  return label.replace(/[▲▼↑↓]/g, "").replace(/\s+/g, " ").trim();
}

/** denylist 정규식에 걸리는가. 위험도와 무관하게 무조건 차단된다. */
export function hitsDenylist(label: string, href: string | null, policy: SafetyPolicy): string | null {
  const haystacks = [normalizeLabel(label), href ?? ""].filter(Boolean);
  for (const pattern of policy.denyLabelPatterns) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      continue; // 잘못된 패턴 하나가 전체 차단을 무너뜨리면 안 된다
    }
    for (const h of haystacks) {
      if (re.test(h)) return pattern;
    }
  }
  return null;
}

/**
 * 위험도 판정. 위에서부터 내려가며 먼저 걸리는 규칙이 확정한다.
 */
export function classify(input: ClassifyInput, policy: SafetyPolicy): Classification {
  const label = normalizeLabel(input.label);

  // 1. denylist — 최우선, 신뢰도 1.0
  const denied = hitsDenylist(label, input.href, policy);
  if (denied) {
    return { risk: "DANGEROUS", reason: `차단 패턴 매치: /${denied}/`, confidence: 1 };
  }

  // 2. class/testid의 파괴적 신호
  if (DANGEROUS_CLASS.test(input.className) || DANGEROUS_CLASS.test(input.testId ?? "")) {
    return {
      risk: "DANGEROUS",
      reason: `파괴적 동작을 암시하는 class/testid: ${input.className || input.testId}`,
      confidence: 0.9,
    };
  }

  /**
   * 3. 테이블 헤더 안의 링크는 정렬 컨트롤이다.
   *
   * 관리자 테이블에는 `승인` `삭제여부` `발송상태` 같은 컬럼이 흔하다.
   * 라벨만 보면 전부 DANGEROUS로 막히지만, `<thead>` 안의 GET 링크는
   * 그 컬럼으로 정렬할 뿐 아무것도 바꾸지 않는다.
   * (fixture의 `권한` 컬럼 헤더가 실제로 DANGEROUS로 막혔다)
   *
   * denylist는 이 규칙보다 위에 있으므로 여전히 절대적이다.
   */
  if (input.inTableHeader && input.tagName === "a" && input.href) {
    return { risk: "SAFE", reason: `테이블 정렬 링크: "${label}"`, confidence: 0.9 };
  }

  // 4. 위험 라벨 — 링크든 버튼이든 무조건 막는다.
  //    `<a href="/x?del=1">삭제</a>` 처럼 GET으로 지우는 관리자웹이 실제로 있다.
  if (DANGEROUS_WORDS.test(label)) {
    return { risk: "DANGEROUS", reason: `위험 동작 라벨: "${label}"`, confidence: 0.9 };
  }

  /**
   * 5. 링크는 라벨이 아니라 **하는 일**로 판정한다.
   *
   * "신규 등록" 링크는 라벨에 `등록`이 있지만 하는 일은 빈 폼을 여는 GET 이동이고,
   * 아무것도 쓰지 않는다. 라벨만 보고 CAUTION으로 막으면 등록 화면 자체를
   * 영영 탐색하지 못한다(fixture에서 실제로 `/users/new`와 `/surveys/new`를 놓쳤다).
   *
   * 실제로 데이터를 만드는 것은 그 폼 안의 저장 버튼이고, 그건 아래 규칙에서 걸린다.
   */
  if (input.tagName === "a" && input.href) {
    if (DESTRUCTIVE_HREF.test(input.href)) {
      return { risk: "DANGEROUS", reason: `파괴적 동작이 의심되는 링크 경로: ${input.href}`, confidence: 0.8 };
    }
    if (MUTATING_HREF.test(input.href)) {
      return { risk: "CAUTION", reason: `상태 변경이 의심되는 링크 경로: ${input.href}`, confidence: 0.7 };
    }
    if (SAFE_WORDS.test(label)) {
      return { risk: "SAFE", reason: `조회 링크: "${label}"`, confidence: 0.95 };
    }
    return { risk: "SAFE", reason: `GET 이동 링크: "${label}"`, confidence: 0.85 };
  }

  /**
   * 5-2. 폼을 여는 버튼.
   *
   * 규칙 5는 `<a href>` 에만 적용된다. 그런데 SPA 관리자웹에서 등록 화면은
   * 링크가 아니라 **버튼** 뒤에 있다(모달이거나 라우터 이동이다).
   * 실측에서 "+ 직원 등록" 이 CAUTION 으로 막혀 등록 화면에 영영 도달하지 못했고,
   * 그 결과 Create·Update·Delete 가 **전부** 미실행으로 끝났다.
   *
   * 저장 버튼과 구분하는 근거는 두 가지다.
   *   - **폼 밖에 있다.** 저장 버튼은 자기가 저장할 폼 안에 있다.
   *   - 라벨에 **명시적인 여는 표식**이 있다("+", 신규, 새, new/create/add).
   *     맨 "등록"·"추가"는 저장 버튼일 수도 있어 낮추지 않는다.
   *
   * 그래도 틀릴 수 있으므로 실행 후 쓰기 요청이 관측되면 탐색기가 경고를 남긴다.
   */
  if (
    input.tagName !== "a" &&
    !input.inForm &&
    OPEN_FORM_MARK.test(label) &&
    !WRITE_FINISH_LABEL.test(label)
  ) {
    return { risk: "SAFE", reason: `${OPEN_FORM_REASON}: "${label}"`, confidence: 0.75 };
  }

  // 6. 쓰기 라벨 (버튼)
  if (CAUTION_WORDS.test(label)) {
    return { risk: "CAUTION", reason: `쓰기 동작 라벨: "${label}"`, confidence: 0.85 };
  }

  if (input.role === "tab") {
    return { risk: "SAFE", reason: "탭 전환", confidence: 0.95 };
  }

  //    폼 안의 제출 버튼은 라벨이 무해해 보여도 쓰기일 수 있다.
  if (input.inForm && input.type === "submit") {
    if (SAFE_WORDS.test(label)) {
      return { risk: "SAFE", reason: `조회 폼 제출: "${label}"`, confidence: 0.85 };
    }
    return { risk: "CAUTION", reason: "폼 제출 버튼 (동작 불명)", confidence: 0.6 };
  }

  if (SAFE_WORDS.test(label)) {
    return { risk: "SAFE", reason: `조회 동작 라벨: "${label}"`, confidence: 0.85 };
  }

  // 7. 미상 — 안전하다고 가정하지 않는다
  return { risk: "CAUTION", reason: `분류 불가한 동작: "${label}"`, confidence: 0.4 };
}

/** 실행 게이트. 분류를 신뢰하지 않고 실행 직전에 한 번 더 확인한다. */
export function riskAtMost(risk: RiskLevel, max: RiskLevel): boolean {
  const order: Record<RiskLevel, number> = { SAFE: 0, CAUTION: 1, DANGEROUS: 2 };
  return order[risk] <= order[max];
}

export const MIN_CONFIDENCE = 0.6;
