import type { SafetyPolicy } from "@qa/shared";
import { classify, type Classification } from "../classify.js";
import type { AppElement } from "./observe.js";

/**
 * 앱 요소 위험도 판정.
 *
 * 웹 분류기를 그대로 쓰되 **한 가지를 다르게 본다: 분류 불가한 라벨.**
 *
 * 웹에서는 라벨을 모르면 CAUTION(신뢰도 0.4)으로 두고 실행하지 않는다.
 * 링크의 `href` 라는 다른 신호가 있어서, 정말 안전한 이동은 규칙 5가 따로 건져낸다.
 *
 * 앱에는 그런 신호가 없다. `content-desc` 말고는 아무것도 없어서
 * **모르는 것을 전부 건너뛰면 화면을 거의 못 본다** — 실측에서 4개 화면 중
 * "근태 조회" 하나만 눌리고 나머지는 이름이 낯설다는 이유로 통째로 막혔다.
 * 그 상태의 리포트는 "이상 없음"이라고 말하지만 사실은 아무것도 안 본 것이다.
 *
 * 그래서 앱에서는 **모르는 라벨을 이동으로 본다.** 대신 두 겹으로 막는다.
 *   - denylist(로그아웃·삭제·발송·승인…)는 그대로 절대적이다
 *   - 쓰기를 뜻하는 말(저장·등록·제출·신청·결제…)은 여전히 CAUTION 이라 미뤄진다
 *
 * 남는 위험은 "이름만으로는 쓰기인지 알 수 없는 버튼"인데, 그것까지 막으면
 * 앱 QA 자체가 성립하지 않는다. 대신 무엇을 눌렀는지 전부 기록해 리포트에 남긴다.
 */

/**
 * 앱에서 추가로 쓰기로 보는 말.
 *
 * 웹 `CAUTION_WORDS` 에 없지만 앱에서 흔히 되돌릴 수 없는 것들이다.
 * 결제·해지처럼 사고가 나면 복구가 어려운 것을 우선 넣었다.
 */
const APP_WRITE_WORDS =
  /(제출|신청|완료|확정|결제|구매|주문|해지|취소하기|보내기|올리기|찍기|촬영|서명|동의|가입)/;

export function classifyAppElement(
  element: AppElement,
  policy: SafetyPolicy,
  riskyLabels: readonly string[] = [],
): Classification {
  const base = classify(
    {
      label: element.label,
      href: null,
      // 앱의 클릭 요소에는 "읽기 전용 이동"을 뜻하는 표시가 없다. 전부 버튼으로 본다.
      tagName: "button",
      role: null,
      type: null,
      className: element.className,
      testId: element.resourceId,
      inForm: false,
      inTableHeader: false,
    },
    policy,
  );

  // denylist 는 절대적이다. 사용자가 정한 것보다 먼저 본다.
  if (base.risk === "DANGEROUS" && base.confidence >= 0.99) return base;

  /*
   * 사용자가 "이 앱에서 이건 되돌릴 수 없다"고 알려준 것들.
   * 도구는 남의 앱의 도메인을 모른다 — "출근하기"는 라벨만 보면 평범하다.
   */
  const risky = riskyLabels.find((word) => word !== "" && element.label.includes(word));
  if (risky) {
    return {
      risk: "CAUTION",
      reason: `되돌릴 수 없는 동작으로 지정됨: "${risky}"`,
      confidence: 0.9,
    };
  }

  /*
   * 웹의 "폼을 여는 버튼" 규칙은 앱에 그대로 옮겨오면 안 된다.
   * 앱에는 폼 밖·안이라는 구분이 없어서, "위치 새로고침" 같은 것이
   * 폼 여는 버튼으로 판정된다(실측). 결론(SAFE)은 같지만 사유가 틀리면
   * 리포트를 읽는 사람이 도구를 못 믿게 된다.
   */
  if (base.reason.startsWith("폼을 여는 버튼")) {
    return { ...base, reason: `이동으로 봄: "${element.label}"` };
  }

  // 나머지는 웹 판정을 그대로 따른다.
  if (base.risk !== "CAUTION" || !base.reason.startsWith("분류 불가")) return base;

  if (APP_WRITE_WORDS.test(element.label)) {
    return {
      risk: "CAUTION",
      reason: `쓰기로 보이는 동작: "${element.label}"`,
      confidence: 0.8,
    };
  }

  return {
    risk: "SAFE",
    reason: `이동으로 봄: "${element.label}" (앱에는 라벨 말고 판단할 신호가 없다)`,
    confidence: 0.65,
  };
}
