import { describe, expect, it } from "vitest";
import { SafetyPolicy } from "@qa/shared";
import { MIN_CONFIDENCE, classify, hitsDenylist, normalizeLabel, riskAtMost } from "./classify.js";
import type { ClassifyInput } from "./classify.js";

const policy = SafetyPolicy.parse({});

function input(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    label: "",
    href: null,
    tagName: "button",
    role: null,
    type: null,
    className: "",
    testId: null,
    inForm: false,
    inTableHeader: false,
    ...over,
  };
}

const link = (label: string, href = "http://x/page") =>
  input({ label, href, tagName: "a" });

describe("denylist", () => {
  it.each(["로그아웃", "Logout", "Sign Out", "설정 초기화", "선택 일괄 잠금", "응답자 알림 발송"])(
    "%s 는 무조건 차단된다",
    (label) => {
      expect(hitsDenylist(label, null, policy)).not.toBeNull();
      expect(classify(input({ label }), policy).risk).toBe("DANGEROUS");
    },
  );

  it("href 에만 걸려도 차단된다", () => {
    expect(hitsDenylist("계속", "http://x/auth/logout", policy)).not.toBeNull();
  });

  it("잘못된 정규식이 섞여 있어도 나머지 패턴은 계속 동작한다", () => {
    const broken = SafetyPolicy.parse({ denyLabelPatterns: ["(((", "로그아웃"] });
    expect(hitsDenylist("로그아웃", null, broken)).toBe("로그아웃");
  });
});

describe("위험 라벨", () => {
  it.each(["삭제", "권한 변경", "게시", "승인", "반려", "차단", "비활성화"])(
    "%s 버튼은 DANGEROUS",
    (label) => {
      expect(classify(input({ label }), policy).risk).toBe("DANGEROUS");
    },
  );

  it("GET 링크여도 삭제 라벨이면 DANGEROUS", () => {
    // `<a href="/x?del=1">삭제</a>` 로 지우는 관리자웹이 실제로 있다.
    expect(classify(link("삭제", "http://x/users?del=1"), policy).risk).toBe("DANGEROUS");
  });

  it("class 에 danger 가 있으면 라벨이 무해해도 DANGEROUS", () => {
    expect(classify(input({ label: "확인", className: "btn danger" }), policy).risk).toBe("DANGEROUS");
  });
});

describe("링크는 하는 일로 판정한다", () => {
  /** 이 규칙이 없으면 fixture의 /users/new 와 /surveys/new 를 영영 못 본다. */
  it("'신규 등록' 링크는 SAFE — 빈 폼을 여는 GET 이동일 뿐이다", () => {
    const v = classify(link("신규 등록", "http://x/users/new"), policy);
    expect(v.risk).toBe("SAFE");
    expect(v.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });

  it("같은 '등록' 라벨이라도 버튼이면 CAUTION", () => {
    expect(classify(input({ label: "등록" }), policy).risk).toBe("CAUTION");
  });

  it("경로가 변경을 암시하면 링크여도 CAUTION", () => {
    expect(classify(link("확인", "http://x/users/1/delete"), policy).risk).toBe("DANGEROUS");
    expect(classify(link("확인", "http://x/orders/save"), policy).risk).toBe("CAUTION");
  });
});

describe("테이블 헤더 링크", () => {
  /** 관리자 테이블에는 권한·삭제여부 같은 컬럼이 흔하다. 정렬은 아무것도 바꾸지 않는다. */
  it.each(["권한", "삭제여부", "차단상태", "이름"])("%s 컬럼 정렬 링크는 SAFE", (label) => {
    const v = classify(
      input({ label, href: "http://x/users?sort=x", tagName: "a", inTableHeader: true }),
      policy,
    );
    expect(v.risk).toBe("SAFE");
  });

  /**
   * denylist는 헤더 규칙보다 위에 있다 — 의도된 동작이다.
   * `승인` `발송상태` 컬럼으로 정렬하는 것을 놓치는 대신, denylist가 어떤 경로로도
   * 뚫리지 않는다는 보장을 얻는다. 커버리지보다 안전을 택한다.
   */
  it.each(["로그아웃", "승인", "발송상태"])("헤더 안이라도 denylist 라벨(%s)은 차단된다", (label) => {
    const v = classify(
      input({ label, href: "http://x/users?sort=x", tagName: "a", inTableHeader: true }),
      policy,
    );
    expect(v.risk).toBe("DANGEROUS");
  });
});

describe("애매하면 위험한 쪽", () => {
  it("분류 불가한 버튼은 CAUTION 이고 신뢰도가 실행 하한 미만이다", () => {
    const v = classify(input({ label: "처리" }), policy);
    expect(v.risk).toBe("CAUTION");
    expect(v.confidence).toBeLessThan(MIN_CONFIDENCE);
  });

  it("폼 제출 버튼은 라벨이 무해해도 CAUTION", () => {
    expect(classify(input({ label: "확인", type: "submit", inForm: true }), policy).risk).toBe("CAUTION");
  });

  it("조회 폼 제출은 SAFE", () => {
    expect(classify(input({ label: "검색", type: "submit", inForm: true }), policy).risk).toBe("SAFE");
  });
});

describe("실행 게이트", () => {
  it("SAFE 정책에서는 SAFE만 통과한다", () => {
    expect(riskAtMost("SAFE", "SAFE")).toBe(true);
    expect(riskAtMost("CAUTION", "SAFE")).toBe(false);
    expect(riskAtMost("DANGEROUS", "SAFE")).toBe(false);
  });

  it("CAUTION 정책에서도 DANGEROUS는 막힌다", () => {
    expect(riskAtMost("CAUTION", "CAUTION")).toBe(true);
    expect(riskAtMost("DANGEROUS", "CAUTION")).toBe(false);
  });
});

describe("라벨 정규화", () => {
  it("정렬 표시와 공백 차이로 판정이 흔들리지 않는다", () => {
    expect(normalizeLabel("권한  ▲")).toBe("권한");
    expect(normalizeLabel("  이름 ▼ ")).toBe("이름");
  });
});
