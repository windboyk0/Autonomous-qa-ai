import { describe, expect, it } from "vitest";
import { RunConfig, SafetyPolicy, redactRunConfig } from "./run-config.js";

const base = {
  projectName: "t",
  targetUrl: "http://localhost:3100",
};

describe("denyLabelPatterns", () => {
  const patterns = SafetyPolicy.parse({}).denyLabelPatterns;

  it("전부 유효한 정규식으로 컴파일된다", () => {
    for (const p of patterns) {
      expect(() => new RegExp(p, "i")).not.toThrow();
    }
  });

  /**
   * `"sign\s*out"` 처럼 백슬래시를 한 번만 쓰면 JS 문자열 리터럴이 `\s`를 `s`로 삼켜
   * 패턴이 `signs*out`이 된다. 컴파일은 되지만 아무것도 매치하지 않는다.
   * 위험 액션 차단이 조용히 무력화되는 경로라 여기서 막는다.
   */
  it("이스케이프가 삼켜지지 않았다", () => {
    for (const p of patterns) {
      expect(p, `패턴 "${p}" 에 남은 s* 는 \\s* 가 삼켜진 흔적이다`).not.toMatch(/[^\\]s\*/);
    }
  });

  it.each([
    ["로그아웃", true],
    ["Logout", true],
    ["Sign Out", true],
    ["sign out", true],
    ["전체 삭제", true],
    ["일괄 발송", true],
    ["설정 초기화", true],
    ["권한 승인", true],
    // 아래는 걸리면 안 된다 (정상적인 SAFE 액션)
    ["목록", false],
    ["상세보기", false],
    ["검색", false],
    ["다음 페이지", false],
  ])("%s -> 차단 %s", (label, shouldMatch) => {
    const hit = patterns.some((p) => new RegExp(p, "i").test(label));
    expect(hit).toBe(shouldMatch);
  });
});

describe("redactRunConfig", () => {
  it("비밀번호를 마스킹한다", () => {
    const cfg = RunConfig.parse({ ...base, login: { username: "admin", password: "admin123!" } });
    const out = redactRunConfig(cfg);
    expect(out.login.password).toBe("***REDACTED***");
    expect(JSON.stringify(out)).not.toContain("admin123!");
  });

  it("비밀번호가 비어 있으면 빈 문자열을 유지한다", () => {
    const cfg = RunConfig.parse({ ...base, login: { username: "admin", password: "" } });
    expect(redactRunConfig(cfg).login.password).toBe("");
  });

  it("원본을 변경하지 않는다", () => {
    const cfg = RunConfig.parse({ ...base, login: { password: "secret-pw" } });
    redactRunConfig(cfg);
    expect(cfg.login.password).toBe("secret-pw");
  });

  it("apiVerify.bearerToken도 마스킹한다", () => {
    const cfg = RunConfig.parse({ ...base, apiVerify: { bearerToken: "secret-token-abc" } });
    const out = redactRunConfig(cfg);
    expect(out.apiVerify.bearerToken).toBe("***REDACTED***");
    expect(JSON.stringify(out)).not.toContain("secret-token-abc");
  });

  it("bearerToken이 비어 있으면 빈 문자열을 유지한다", () => {
    const cfg = RunConfig.parse(base);
    expect(redactRunConfig(cfg).apiVerify.bearerToken).toBe("");
  });
});

/**
 * 4부(API 검증 + 프로그램 범위) — 두 기능 모두 기본이 꺼짐이고,
 * 꺼진 상태에서는 기존 파이프라인과 동작이 완전히 같아야 한다(§30 회귀 원칙).
 */
describe("apiVerify 기본값", () => {
  it("기본은 꺼짐이고, manualCases는 비어 있다", () => {
    const cfg = RunConfig.parse(base).apiVerify;
    expect(cfg.enabled).toBe(false);
    expect(cfg.manualCases).toEqual([]);
    expect(cfg.specSource).toBe("openapi");
  });

  it("쓰기 메서드 자동 실행은 기본이 꺼짐이다", () => {
    expect(RunConfig.parse(base).apiVerify.allowWriteMethods).toBe(false);
  });

  it("인증 모드 기본은 세션 재사용이다", () => {
    expect(RunConfig.parse(base).apiVerify.authMode).toBe("reuse-session");
  });

  it("manualCases의 method/path가 없으면 거부한다", () => {
    expect(
      RunConfig.safeParse({
        ...base,
        apiVerify: { enabled: true, manualCases: [{ method: "GET" }] },
      }).success,
    ).toBe(false);
  });

  it("manualCases 하나만 있어도 파싱된다", () => {
    const cfg = RunConfig.parse({
      ...base,
      apiVerify: { enabled: true, manualCases: [{ method: "GET", path: "/api/users" }] },
    }).apiVerify;
    expect(cfg.manualCases[0]).toMatchObject({
      method: "GET",
      path: "/api/users",
      expectedStatus: [],
      requiresAuth: false,
    });
  });
});

describe("programScope 기본값", () => {
  it("기본은 꺼짐이고, 소스 파일 목록은 비어 있다", () => {
    const cfg = RunConfig.parse(base).programScope;
    expect(cfg.enabled).toBe(false);
    expect(cfg.sourceFiles).toEqual([]);
    expect(cfg.sourceFilesListPath).toBe("");
  });

  it("최소 신뢰도 기본값은 0.5다", () => {
    expect(RunConfig.parse(base).programScope.minConfidence).toBe(0.5);
  });

  it("신뢰도는 0~1 범위를 벗어나면 거부한다", () => {
    expect(
      RunConfig.safeParse({ ...base, programScope: { minConfidence: 1.5 } }).success,
    ).toBe(false);
    expect(
      RunConfig.safeParse({ ...base, programScope: { minConfidence: -0.1 } }).success,
    ).toBe(false);
  });
});

describe("RunConfig 기본값", () => {
  it("Read만 켜져 있고 쓰기는 전부 꺼져 있다", () => {
    const cfg = RunConfig.parse(base);
    expect(cfg.crud).toMatchObject({
      create: false,
      read: true,
      update: false,
      delete: false,
      deleteConsent: false,
    });
  });

  it("자동 실행 허용 위험도는 SAFE 다", () => {
    expect(RunConfig.parse(base).safety.maxAutoRisk).toBe("SAFE");
  });

  it("탐색 예산이 전부 채워진다", () => {
    const b = RunConfig.parse(base).budget;
    for (const [k, v] of Object.entries(b)) {
      expect(v, `${k} 예산이 비어 있으면 탐색이 끝나지 않는다`).toBeGreaterThan(0);
    }
  });

  it.each([
    ["http://localhost:3100", true],
    ["https://qa.example.com/admin", true],
    // zod .url() 은 아래를 스킴 `localhost:` 인 URL로 보고 통과시킨다. Playwright는 못 연다.
    ["localhost:3100", false],
    ["127.0.0.1:8080", false],
    ["file:///c:/tmp", false],
    ["그냥문자열", false],
  ])("targetUrl %s -> 허용 %s", (url, ok) => {
    expect(RunConfig.safeParse({ ...base, targetUrl: url }).success).toBe(ok);
  });
});

/**
 * 모드마다 필요한 입력이 다르다. 여기서 막지 않으면 소스 경로 없이 소스 QA가
 * 시작되어 "결함 0건"이라는 거짓 안심을 준다.
 */
describe("QA 모드", () => {
  it("기본은 실행 QA다", () => {
    expect(RunConfig.parse(base).mode).toBe("runtime");
  });

  it("소스 모드에는 URL이 없어도 되고, 대신 폴더가 필요하다", () => {
    const noUrl = { projectName: "p", mode: "source" as const };
    expect(RunConfig.safeParse(noUrl).success).toBe(false);
    expect(
      RunConfig.safeParse({ ...noUrl, source: { rootDir: "C:/project/groupware" } }).success,
    ).toBe(true);
  });

  it("실행 모드에서 URL이 비면 거부한다", () => {
    expect(RunConfig.safeParse({ projectName: "p", targetUrl: "" }).success).toBe(false);
  });

  it("통합 모드는 URL과 폴더를 둘 다 요구한다", () => {
    expect(RunConfig.safeParse({ ...base, mode: "integrated" }).success).toBe(false);
    expect(
      RunConfig.safeParse({
        ...base,
        mode: "integrated",
        source: { rootDir: "C:/project/groupware" },
      }).success,
    ).toBe(true);
  });

  it("소스가 AI로 나가는 범위는 기본이 스니펫이고, 저장소 전체 선택지는 없다", () => {
    const parsed = RunConfig.parse(base);
    expect(parsed.source.aiUpload).toBe("snippets");
    expect(
      RunConfig.safeParse({ ...base, source: { rootDir: "x", aiUpload: "repo" } }).success,
    ).toBe(false);
  });

  it("빌드·테스트 실행은 기본으로 꺼져 있다", () => {
    const parsed = RunConfig.parse(base);
    expect(parsed.source.allowBuild).toBe(false);
    expect(parsed.source.allowTest).toBe(false);
  });

  it("스캔 예산이 비어 있지 않다", () => {
    const s = RunConfig.parse(base).source;
    expect(s.maxFiles).toBeGreaterThan(0);
    expect(s.maxFileBytes).toBeGreaterThan(0);
    expect(s.maxTotalBytes).toBeGreaterThan(0);
  });
});
