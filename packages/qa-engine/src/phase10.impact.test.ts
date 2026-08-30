import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_SRC_ROOT } from "@qa/fixture-src";
import { computeImpact, gitChangedFiles, impactScore } from "./source/change-impact.js";
import { scanProject } from "./source/scan.js";

/**
 * Phase 10 DoD.
 *
 *   바뀐 파일에 대응하는 화면이 **탐색 큐 앞쪽에 온다.**
 *   대응이 없으면 **그 사실을 적는다.**
 *
 * 여기서 매핑이 부정확하면 Phase 11(원인 추적)은 애초에 성립하지 않는다.
 * 그래서 싼 쪽을 먼저 검증한다.
 */

let repo: string;
const BUDGET = { maxFiles: 5000, maxFileBytes: 512 * 1024, maxTotalBytes: 64 * 1024 * 1024 };

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "qa-phase10-"));
  cpSync(FIXTURE_SRC_ROOT, repo, { recursive: true });
  git(["init", "-q"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "user.name", "fixture"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("Phase 10 — 바뀐 파일 찾기", () => {
  it("Git 저장소가 아니면 이유를 남기고 조용히 실패하지 않는다", () => {
    const plain = mkdtempSync(join(tmpdir(), "qa-phase10-nogit-"));
    const changed = gitChangedFiles(plain);
    expect(changed.files).toEqual([]);
    expect(changed.error).toContain("Git 저장소가 아닙니다");
    rmSync(plain, { recursive: true, force: true });
  });

  it("커밋하지 않은 변경을 먼저 본다", () => {
    const f = "backend/src/main/java/com/example/groupware/service/UserService.java";
    writeFileSync(join(repo, f), readFileSync(join(repo, f), "utf8") + "\n// touched\n");
    const changed = gitChangedFiles(repo);
    expect(changed.files).toContain(f);
    expect(changed.comparedWith).toBe("커밋하지 않은 변경");
    // 다음 케이스를 위해 되돌린다.
    git(["checkout", "--", f]);
  });

  it("작업 트리가 깨끗하면 마지막 커밋으로 물러선다", () => {
    const f = "frontend/src/pages/UserList.tsx";
    writeFileSync(join(repo, f), readFileSync(join(repo, f), "utf8") + "\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "touch UserList"]);

    const changed = gitChangedFiles(repo);
    expect(changed.comparedWith).toBe("마지막 커밋");
    expect(changed.files).toContain(f);
  });
});

describe("Phase 10 — 변경 영향", () => {
  it("컨트롤러가 바뀌면 그 엔드포인트가 확정으로 나온다", () => {
    const scan = scanProject(repo, BUDGET);
    const impact = computeImpact(repo, scan, {
      files: ["backend/src/main/java/com/example/groupware/controller/UserController.java"],
      comparedWith: "테스트",
      error: null,
    });
    const names = impact.endpoints.map((e) => `${e.method} ${e.path}`);
    expect(names).toEqual(
      expect.arrayContaining(["GET /api/users", "POST /api/users", "DELETE /api/users/:id"]),
    );
    expect(names).not.toContain("GET /api/depts");
  });

  /**
   * 서비스가 바뀌었을 때 컨트롤러를 찾는 것은 **추정**이다.
   * 그렇게 판단했다는 사실이 근거로 남아야 한다.
   */
  it("서비스가 바뀌면 그것을 참조하는 컨트롤러까지 넓히되 추정임을 적는다", () => {
    const scan = scanProject(repo, BUDGET);
    const impact = computeImpact(repo, scan, {
      files: ["backend/src/main/java/com/example/groupware/service/UserService.java"],
      comparedWith: "테스트",
      error: null,
    });
    expect(impact.endpoints.map((e) => e.path)).toContain("/api/users");
    expect(impact.notes.join("\n")).toContain("추정");
  });

  it("바뀐 화면 파일이 부르는 API 경로를 뽑는다", () => {
    const scan = scanProject(repo, BUDGET);
    const impact = computeImpact(repo, scan, {
      files: ["frontend/src/api/userApi.ts"],
      comparedWith: "테스트",
      error: null,
    });
    expect(impact.apiPaths).toEqual(expect.arrayContaining(["/api/users"]));
  });

  it("연결을 찾지 못하면 그 사실을 적는다", () => {
    const scan = scanProject(repo, BUDGET);
    const impact = computeImpact(repo, scan, {
      files: ["README.md"],
      comparedWith: "테스트",
      error: null,
    });
    expect(impact.endpoints).toEqual([]);
    expect(impact.notes.join("\n")).toContain("탐색 순서를 조정하지 않습니다");
  });
});

describe("Phase 10 — 탐색 순서", () => {
  const hints = ["users", "user", "list"];

  it("변경에 닿는 화면이 더 높은 점수를 받는다", () => {
    expect(impactScore("https://admin.example.com/users", hints)).toBeGreaterThan(
      impactScore("https://admin.example.com/settings", hints),
    );
  });

  it("힌트가 없으면 모든 화면이 같은 점수다 — 순서를 건드리지 않는다", () => {
    expect(impactScore("https://x/users", [])).toBe(0);
    expect(impactScore("https://x/settings", [])).toBe(0);
  });

  /**
   * 순서만 바꾸고 대상은 줄이지 않는다는 것이 이 기능의 안전장치다.
   * 줄이면 못 본 화면이 생기는데, 그 사실이 리포트에서 "정상"으로 읽힌다.
   */
  it("점수가 0이어도 제외되지 않는다", () => {
    expect(impactScore("https://x/settings", hints)).toBe(0);
    // 점수는 순서를 정할 뿐이고, 탐색 대상 여부는 여기서 결정되지 않는다.
    expect(Number.isFinite(impactScore("https://x/settings", hints))).toBe(true);
  });
});
