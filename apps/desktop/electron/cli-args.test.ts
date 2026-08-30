import { describe, expect, it } from "vitest";
import { RunConfig } from "@qa/shared";
import { toCliArgs } from "./engine.js";

/**
 * 실측 회귀.
 *
 * 소스 QA 를 고르고 시작하면 **엔진이 종료 코드 2 로 죽었다.** 화면에는
 * "엔진이 비정상 종료했습니다" 만 보였고, 로그에는 USAGE 가 통째로 찍혔다.
 *
 * 원인은 하나였다 — \`toCliArgs\` 가 \`--url\` 을 무조건 넘기고 \`--source\` 는
 * 한 번도 넘기지 않았다. 소스 모드에는 URL 이 없어 빈 문자열이 갔고,
 * 엔진은 "대상이 없다"고 판단했다.
 *
 * 이 함수는 화면과 엔진을 잇는 **유일한 통로**인데 테스트가 없었다.
 * 여기가 어긋나면 UI 가 아무리 맞아도 실행이 안 된다.
 */

const has = (args: string[], flag: string): boolean => args.includes(flag);
const valueOf = (args: string[], flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
};

describe("실행 QA 인자", () => {
  const args = toCliArgs(
    RunConfig.parse({
      projectName: "p",
      targetUrl: "http://localhost:3100",
      startPath: "/admin",
      headless: true,
      login: { enabled: true, username: "admin" },
      crud: { create: true, update: true, delete: true, deleteConsent: true },
      budget: { maxScreens: 42 },
    }),
  );

  it("URL 과 탐색 설정을 넘긴다", () => {
    expect(valueOf(args, "--url")).toBe("http://localhost:3100");
    expect(valueOf(args, "--start-path")).toBe("/admin");
    expect(valueOf(args, "--max-screens")).toBe("42");
    expect(has(args, "--headless")).toBe(true);
    expect(valueOf(args, "--user")).toBe("admin");
  });

  it("CRUD 동의를 그대로 넘긴다", () => {
    expect(has(args, "--create")).toBe(true);
    expect(has(args, "--update")).toBe(true);
    expect(has(args, "--delete")).toBe(true);
    expect(has(args, "--delete-consent")).toBe(true);
  });

  it("소스 관련 인자는 넘기지 않는다", () => {
    expect(has(args, "--source")).toBe(false);
    expect(has(args, "--ai-upload")).toBe(false);
    expect(has(args, "--change-impact")).toBe(false);
  });
});

describe("소스 QA 인자", () => {
  const args = toCliArgs(
    RunConfig.parse({
      projectName: "p",
      mode: "source",
      source: { rootDir: "C:/project/groupware", changeImpact: true, changeBase: "main" },
    }),
  );

  /** 이 하나가 빠져서 엔진이 죽었다. */
  it("프로젝트 폴더를 넘긴다", () => {
    expect(valueOf(args, "--source")).toBe("C:/project/groupware");
  });

  it("빈 URL 을 넘기지 않는다 — 엔진이 대상 없음으로 보고 죽는다", () => {
    expect(has(args, "--url")).toBe(false);
    expect(args).not.toContain("");
  });

  it("브라우저·로그인·CRUD 인자를 넘기지 않는다", () => {
    for (const flag of ["--headless", "--start-path", "--max-screens", "--user", "--create"]) {
      expect(has(args, flag), `${flag} 가 소스 모드에 들어갔다`).toBe(false);
    }
  });

  it("변경 영향과 AI 전송 범위를 넘긴다", () => {
    expect(has(args, "--change-impact")).toBe(true);
    expect(valueOf(args, "--change-base")).toBe("main");
    expect(valueOf(args, "--ai-upload")).toBe("snippets");
  });

  /** 동의하지 않은 실행 권한이 새어 나가면 안 된다. */
  it("동의하지 않은 빌드·테스트 실행은 넘기지 않는다", () => {
    expect(has(args, "--allow-test")).toBe(false);
    expect(has(args, "--allow-build")).toBe(false);
  });

  it("동의한 것만 넘어간다", () => {
    const consented = toCliArgs(
      RunConfig.parse({
        projectName: "p",
        mode: "source",
        source: { rootDir: "C:/p", allowTest: true },
      }),
    );
    expect(has(consented, "--allow-test")).toBe(true);
    expect(has(consented, "--allow-build")).toBe(false);
  });
});

describe("통합 QA 인자", () => {
  const args = toCliArgs(
    RunConfig.parse({
      projectName: "p",
      mode: "integrated",
      targetUrl: "http://localhost:3100",
      login: { enabled: true, username: "admin" },
      source: { rootDir: "C:/project/groupware" },
    }),
  );

  it("URL 과 폴더를 둘 다 넘긴다", () => {
    expect(valueOf(args, "--url")).toBe("http://localhost:3100");
    expect(valueOf(args, "--source")).toBe("C:/project/groupware");
  });

  it("탐색 설정도 함께 넘긴다", () => {
    expect(valueOf(args, "--user")).toBe("admin");
    expect(has(args, "--max-screens")).toBe(true);
  });
});

describe("비밀번호", () => {
  it("어떤 모드에서도 인자에 담기지 않는다", () => {
    for (const config of [
      RunConfig.parse({
        projectName: "p",
        targetUrl: "http://x.test",
        login: { enabled: true, username: "admin", password: "s3cret-pw" },
      }),
      RunConfig.parse({
        projectName: "p",
        mode: "integrated",
        targetUrl: "http://x.test",
        login: { enabled: true, username: "admin", password: "s3cret-pw" },
        source: { rootDir: "C:/p" },
      }),
    ]) {
      expect(toCliArgs(config).join(" ")).not.toContain("s3cret-pw");
    }
  });
});
