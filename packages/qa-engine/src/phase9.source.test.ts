import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunConfig, type IssueCandidate } from "@qa/shared";
import {
  FIXTURE_SRC_ROOT,
  KNOWN_SOURCE_BUGS,
  KNOWN_ENDPOINTS,
  lineOfAnchor,
  type KnownSourceBug,
} from "@qa/fixture-src";
import { RunContext, makeRunId } from "./run-context.js";
import { runSourceQa, type SourceQaOutcome } from "./source/run-source.js";
import { extractSpringEndpoints } from "./source/endpoints.js";
import { readYamlKeyPaths } from "./source/secrets.js";

/**
 * Phase 9 DoD.
 *
 *   fixture-src 정답지 **80% 이상 탐지, 오탐 3건 이하.**
 *
 * 그리고 그보다 앞서는 원칙 둘:
 *   - 시크릿 파일의 **값을 읽지 않는다** (CLAUDE.md §16-1)
 *   - **주석을 근거로 정답을 맞히지 않는다** (fixture 에 SRC-xx 주석이 있다)
 */

let outDir: string;
let ctx: RunContext;
let outcome: SourceQaOutcome;

/** 후보 하나가 정답지의 어느 결함을 가리키는가. 파일과 줄이 모두 맞아야 인정한다. */
function matchesBug(c: IssueCandidate, bug: KnownSourceBug): boolean {
  const line = lineOfAnchor(bug.file, bug.anchor);
  return c.codeRefs.some((r) => r.file === bug.file && r.line === line);
}

function detected(bug: KnownSourceBug): IssueCandidate | undefined {
  return outcome.candidates.find((c) => matchesBug(c, bug));
}

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), "qa-phase9-"));
  const config = RunConfig.parse({
    projectName: "fixture-src",
    mode: "source",
    source: { rootDir: FIXTURE_SRC_ROOT },
    outDir: "runs",
  });
  ctx = new RunContext(makeRunId(), config.outDir, outDir);
  outcome = runSourceQa(config, ctx);
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("Phase 9 — 프로젝트 스캔", () => {
  it("기술 스택을 판별한다", () => {
    expect(outcome.scan.stack).toEqual(
      expect.arrayContaining(["Spring Boot", "JPA", "React", "Java"]),
    );
  });

  it("빌드 산출물이나 의존성 폴더를 읽지 않는다", () => {
    for (const f of outcome.scan.files) {
      expect(f.path).not.toMatch(/node_modules|(^|\/)(dist|build|target)\//);
    }
  });

  it("실행 가능한 명령을 찾되 실행하지는 않는다", () => {
    const commands = outcome.scan.runnableCommands.map((c) => c.command);
    expect(commands).toEqual(expect.arrayContaining(["npm run test", "./gradlew test"]));
    // 실행하지 않았다는 사실이 미검증 목록에 남아야 한다.
    expect(outcome.unverified.join("\n")).toContain("동의하지 않아 실행하지 않았습니다");
  });
});

describe("Phase 9 — 시크릿 취급 (§16-1)", () => {
  it("키·인증서 파일은 열지 않고, 설정 파일은 키 이름까지만 본다", () => {
    const props = outcome.scan.files.find((f) => f.path.endsWith("secrets.properties"));
    expect(props?.access).toBe("keys-only");
  });

  it("값의 모양만 읽고 값 자체는 반환하지 않는다", () => {
    const text = readFileSync(
      join(FIXTURE_SRC_ROOT, "backend/src/main/resources/application-prod.yml"),
      "utf8",
    );
    const keys = readYamlKeyPaths(text);
    const pw = keys.find((k) => k.key === "spring.datasource.password");
    expect(pw?.valueShape).toBe("literal");
    // 반환값 어디에도 값 문자열이 없어야 한다.
    expect(JSON.stringify(keys)).not.toContain("CHANGE_ME_fixture_only");
  });

  it("환경변수 참조는 결함이 아니다", () => {
    const text = readFileSync(
      join(FIXTURE_SRC_ROOT, "backend/src/main/resources/application.yml"),
      "utf8",
    );
    const pw = readYamlKeyPaths(text).find((k) => k.key === "spring.datasource.password");
    expect(pw?.valueShape).toBe("env-ref");
  });

  /** 리포트가 새로운 유출 경로가 되면 안 된다. */
  it("증적과 후보 어디에도 시크릿 값이 남지 않는다", () => {
    const dump = JSON.stringify(outcome.candidates);
    expect(dump).not.toContain("CHANGE_ME_fixture_only");
    expect(dump).not.toContain("sk-fixture-DO-NOT-USE-0000");

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    for (const file of walk(ctx.runDir)) {
      const text = readFileSync(file, "utf8");
      expect(text, `${file} 에 시크릿 값이 남았다`).not.toContain("CHANGE_ME_fixture_only");
      expect(text, `${file} 에 토큰 값이 남았다`).not.toContain("sk-fixture-DO-NOT-USE-0000");
    }
  });
});

describe("Phase 9 — 엔드포인트와 권한", () => {
  it("클래스 레벨 경로와 메서드 매핑을 이어 붙인다", () => {
    const paths = outcome.endpoints.map((e) => `${e.method} ${e.path}`);
    for (const known of KNOWN_ENDPOINTS) {
      expect(paths, `${known.method} ${known.path} 를 못 찾았다`).toContain(
        `${known.method} ${known.path}`,
      );
    }
  });

  it("권한 애너테이션 유무를 정답지와 같게 판정한다", () => {
    for (const known of KNOWN_ENDPOINTS) {
      const found = outcome.endpoints.find(
        (e) => e.method === known.method && e.path === known.path,
      );
      expect(found?.authorized, `${known.method} ${known.path}`).toBe(known.authorized);
    }
  });

  /**
   * 정밀도의 핵심. 아무도 애너테이션을 쓰지 않는 컨트롤러에서 전부를 결함으로 올리면
   * 오탐이 쏟아진다. 형제 중 일부만 빠진 것만 결함이다.
   */
  it("보호된 형제가 없는 파일에서는 아무것도 보고하지 않는다", () => {
    const text = `
      @RestController
      @RequestMapping("/api/things")
      public class ThingController {
        @GetMapping
        public List<String> list() { return null; }
        @PostMapping
        public String create() { return null; }
      }`;
    const eps = extractSpringEndpoints("ThingController.java", text);
    expect(eps.length).toBe(2);
    expect(eps.every((e) => !e.authorized)).toBe(true);
    // unauthorizedEndpoints 는 이 파일을 통째로 건너뛴다 → 후보 0
    expect(outcome.candidates.filter((c) => c.codeRefs[0]?.file.includes("ThingController"))).toEqual(
      [],
    );
  });
});

describe("Phase 9 — DoD: 탐지율과 오탐", () => {
  /** 의존성 취약점은 외부 도구 없이 판정하지 않는다. 못 찾는 것을 명시한다. */
  const OUT_OF_SCOPE = new Set(["SRC-12"]);
  const scorable = KNOWN_SOURCE_BUGS.filter((b) => !OUT_OF_SCOPE.has(b.id));

  it.each(scorable.map((b) => [b.id, b] as const))("%s 를 탐지한다", (_id, bug) => {
    expect(detected(bug), `${bug.id} ${bug.title}`).toBeDefined();
  });

  it("탐지율이 80% 이상이다", () => {
    const hit = scorable.filter((b) => detected(b) !== undefined).length;
    const rate = hit / KNOWN_SOURCE_BUGS.length;
    expect(rate, `탐지 ${hit}/${KNOWN_SOURCE_BUGS.length}`).toBeGreaterThanOrEqual(0.8);
  });

  it("오탐이 3건 이하다", () => {
    const falsePositives = outcome.candidates.filter(
      (c) => !KNOWN_SOURCE_BUGS.some((b) => matchesBug(c, b)),
    );
    const detail = falsePositives
      .map((c) => `${c.ruleId} ${c.codeRefs[0]?.file}:${c.codeRefs[0]?.line} ${c.title}`)
      .join("\n");
    expect(falsePositives.length, `오탐:\n${detail}`).toBeLessThanOrEqual(3);
  });

  it("찾지 못한 것을 미검증으로 남긴다", () => {
    expect(outcome.unverified.join("\n")).toContain("의존성 취약점");
  });

  it("실행 QA 가 못 찾는 결함을 실제로 찾아낸다", () => {
    const sourceOnly = scorable.filter((b) => !b.runtimeCanFind);
    const hit = sourceOnly.filter((b) => detected(b) !== undefined).length;
    expect(hit, "소스 QA 를 따로 만든 이유가 여기에 있다").toBe(sourceOnly.length);
  });
});

/**
 * fixture 소스에는 `SRC-xx` 주석이 달려 있다. 검출기가 그것을 근거로 삼으면
 * 채점이 통째로 거짓말이 된다. 주석을 모두 지운 사본에서 같은 결과가 나와야 한다.
 */
describe("Phase 9 — 주석을 근거로 삼지 않는다", () => {
  it("SRC-xx 주석을 지워도 탐지 결과가 같다", () => {
    const copyRoot = mkdtempSync(join(tmpdir(), "qa-phase9-nocomment-"));
    const projectCopy = join(copyRoot, "project");
    cpSync(FIXTURE_SRC_ROOT, projectCopy, { recursive: true });

    const strip = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          strip(p);
          continue;
        }
        const text = readFileSync(p, "utf8");
        if (!/SRC-\d{2}/.test(text)) continue;
        writeFileSync(
          p,
          text
            .split(/\r?\n/)
            .filter((l) => !/SRC-\d{2}/.test(l))
            .join("\n"),
          "utf8",
        );
      }
    };
    strip(projectCopy);

    const config = RunConfig.parse({
      projectName: "fixture-src-nocomment",
      mode: "source",
      source: { rootDir: projectCopy },
      outDir: "runs",
    });
    const ctx2 = new RunContext(makeRunId(), config.outDir, copyRoot);
    const second = runSourceQa(config, ctx2);

    const idsOf = (o: SourceQaOutcome) =>
      o.candidates.map((c) => c.ruleId).sort().join(",");
    expect(idsOf(second)).toBe(idsOf(outcome));

    rmSync(copyRoot, { recursive: true, force: true });
  });
});

/**
 * 소스 모드가 리포트까지 도달하는가.
 *
 * 후보만 만들고 끝나면 사용자에게는 아무것도 전달되지 않는다.
 * 1부의 judge·리포트를 그대로 재사용한다는 설계가 실제로 성립하는지 여기서 본다.
 */
describe("Phase 9 — 소스 모드 end-to-end", () => {
  it("브라우저 없이 report.md 와 issues.json 이 나온다", async () => {
    const { runQa } = await import("./run.js");
    const dir = mkdtempSync(join(tmpdir(), "qa-phase9-e2e-"));
    const config = RunConfig.parse({
      projectName: "fixture-src",
      mode: "source",
      source: { rootDir: FIXTURE_SRC_ROOT },
      outDir: "runs",
    });
    const c = new RunContext(makeRunId(), config.outDir, dir);
    const outcome2 = await runQa(config, c);

    expect(outcome2.status).toBe("COMPLETED");

    const report = readFileSync(join(c.runDir, "report.md"), "utf8");
    expect(report).toContain("소스 QA (프로젝트 폴더)");
    expect(report).toContain("**관련 소스**");
    expect(report).toContain("UserController.java");
    // 권한 누락이 최상위 우선순위로 올라와야 한다.
    expect(report).toMatch(/QA-0001[^\n]*권한 검사가 없는 엔드포인트/);
    // 소스가 밖으로 나가는 범위를 리포트가 밝힌다.
    expect(report).toContain("소스 AI 전송 범위");
    // 시크릿 값은 어디에도 없다.
    expect(report).not.toContain("CHANGE_ME_fixture_only");
    expect(report).not.toContain("sk-fixture-DO-NOT-USE-0000");

    const issues = JSON.parse(readFileSync(join(c.runDir, "issues.json"), "utf8")) as {
      issues: Array<{ codeRefs: Array<{ file: string; line: number | null }> }>;
    };
    expect(issues.issues.every((i) => i.codeRefs.length > 0)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
