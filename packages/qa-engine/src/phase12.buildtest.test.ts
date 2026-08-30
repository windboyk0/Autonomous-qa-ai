import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunConfig } from "@qa/shared";
import { scanProject, type ProjectScan } from "./source/scan.js";
import { plannedCommands, runCommand, runBuildAndTest } from "./source/build-test.js";

/**
 * Phase 12 DoD.
 *
 *   **동의 없이는 아무 명령도 실행되지 않는다.**
 *   실행할 명령 전문이 그대로 보인다.
 *
 * 이 모듈이 이 도구에서 가장 위험하다. 남의 프로젝트 명령을 돌린다는 것은
 * 그 프로젝트의 임의 코드를 사용자 권한으로 돌린다는 뜻이다.
 * 그래서 테스트도 **무해한 명령만** 쓴다 — 파일을 하나 남기고 끝나는 스크립트다.
 */

let root: string;
let scan: ProjectScan;
const BUDGET = { maxFiles: 5000, maxFileBytes: 512 * 1024, maxTotalBytes: 64 * 1024 * 1024 };

const config = (over: Record<string, unknown> = {}): RunConfig =>
  RunConfig.parse({
    projectName: "t",
    mode: "source",
    source: { rootDir: root, ...over },
    outDir: "runs",
  });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "qa-phase12-"));
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(
    join(root, "app", "package.json"),
    JSON.stringify(
      {
        name: "harmless",
        private: true,
        scripts: {
          // 무해한 명령만 쓴다. 파일 하나 쓰고 끝난다.
          test: 'node -e "require(\'fs\').writeFileSync(\'ran-test.txt\',\'1\')"',
          build: 'node -e "process.exit(3)"',
          // 실행되면 안 되는 것. 허용 목록에 없는 이름이다.
          deploy: 'node -e "require(\'fs\').writeFileSync(\'DEPLOYED.txt\',\'1\')"',
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  scan = scanProject(root, BUDGET);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Phase 12 — 동의가 없으면 아무것도 돌지 않는다", () => {
  it("기본값에서는 실행 계획이 비어 있다", () => {
    expect(plannedCommands(scan, config())).toEqual([]);
  });

  it("실행하지 않은 명령을 리포트에 남긴다", () => {
    const outcome = runBuildAndTest(config(), scan, "ev-0001");
    expect(outcome.results).toEqual([]);
    expect(outcome.candidates).toEqual([]);
    expect(outcome.notRun.join("\n")).toContain("npm run test");
    expect(outcome.notRun.join("\n")).toContain("동의하지 않아");
  });

  it("빌드 동의는 테스트를 실행시키지 않는다", () => {
    const planned = plannedCommands(scan, config({ allowBuild: true }));
    expect(planned.map((p) => p.command)).toEqual(["npm run build"]);
  });
});

describe("Phase 12 — 허용된 모양만 실행한다", () => {
  it("허용 목록에 없는 script 는 발견해도 계획에 넣지 않는다", () => {
    const planned = plannedCommands(scan, config({ allowBuild: true, allowTest: true }));
    expect(planned.map((p) => p.command)).not.toContain("npm run deploy");
  });

  /** 임의 문자열을 셸에 넘기면 그 순간 임의 실행이 된다. */
  it("임의 명령 문자열은 실행을 거부한다", () => {
    const r = runCommand(root, {
      command: "npm run test && echo pwned",
      purpose: "test",
      from: "app/package.json",
      cwd: "app",
    });
    expect(r.exitCode).toBeNull();
    expect(r.error).toContain("허용되지 않은");
  });

  it("의존성 설치는 계획에 아예 없다", () => {
    const commands = scan.runnableCommands.map((c) => c.command).join(" ");
    expect(commands).not.toContain("install");
    const planned = plannedCommands(scan, config({ allowBuild: true, allowTest: true }));
    expect(planned.map((p) => p.command).join(" ")).not.toContain("install");
  });
});

describe("Phase 12 — 동의하면 실행하고 결과를 결함으로 만든다", () => {
  it("실패한 빌드가 결함이 되고 종료 코드가 남는다", () => {
    const outcome = runBuildAndTest(config({ allowBuild: true }), scan, "ev-0001");
    expect(outcome.results.length).toBe(1);
    expect(outcome.results[0]!.exitCode).toBe(3);

    const issue = outcome.candidates[0];
    expect(issue).toBeDefined();
    expect(issue!.ruleId).toBe("BUILD-FAILED");
    expect(issue!.title).toContain("npm run build");
    expect(issue!.description).toContain("종료 코드 3");
    // 어느 파일에 정의된 명령인지 가리킨다.
    expect(issue!.codeRefs[0]!.file).toContain("package.json");
  }, 60_000);

  it("성공한 명령은 결함을 만들지 않는다", () => {
    const outcome = runBuildAndTest(config({ allowTest: true }), scan, "ev-0001");
    expect(outcome.results[0]!.exitCode).toBe(0);
    expect(outcome.candidates).toEqual([]);
  }, 60_000);
});
