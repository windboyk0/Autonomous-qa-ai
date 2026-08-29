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
