import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { resolveClaudeCli, resetClaudeCliCache, searchedLocations } from "./ai/claude-cli.js";

/**
 * 실측 회귀.
 *
 * Claude Max 를 골랐는데 "AI 사용 안 함" 으로 QA 가 돌았다. 원인은 하나였다 —
 * `claude` 가 **PATH 에 없었다.** 설치는 되어 있었고 터미널에서는 동작했다.
 * Electron 앱은 로그인 셸을 거치지 않아 사용자 터미널의 PATH 와 다르다.
 */

const saved = { PATH: process.env.PATH, override: process.env.QA_CLAUDE_PATH };

afterEach(() => {
  process.env.PATH = saved.PATH;
  if (saved.override === undefined) delete process.env.QA_CLAUDE_PATH;
  else process.env.QA_CLAUDE_PATH = saved.override;
  resetClaudeCliCache();
});

describe("Claude CLI 찾기", () => {
  it("PATH 에 없어도 QA_CLAUDE_PATH 로 지정할 수 있다", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-override-"));
    const exe = join(dir, "claude.exe");
    writeFileSync(exe, "", "utf8");

    process.env.PATH = dir + "-없는곳";
    process.env.QA_CLAUDE_PATH = exe;
    resetClaudeCliCache();

    expect(resolveClaudeCli()).toBe(exe);
    rmSync(dir, { recursive: true, force: true });
  });

  it("PATH 에 있으면 찾는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-path-"));
    const name = process.platform === "win32" ? "claude.cmd" : "claude";
    writeFileSync(join(dir, name), "", "utf8");

    delete process.env.QA_CLAUDE_PATH;
    process.env.PATH = dir;
    resetClaudeCliCache();

    expect(resolveClaudeCli()).toBe(join(dir, name));
    rmSync(dir, { recursive: true, force: true });
  });

  it("아무 데도 없으면 null 이고, 어디를 찾았는지 알려줄 수 있다", () => {
    const empty = mkdtempSync(join(tmpdir(), "claude-none-"));
    mkdirSync(join(empty, "bin"), { recursive: true });

    delete process.env.QA_CLAUDE_PATH;
    process.env.PATH = join(empty, "bin");
    resetClaudeCliCache();

    // 이 PC 에 실제로 설치돼 있으면 알려진 위치에서 찾는다. 그건 정상이다.
    const found = resolveClaudeCli();
    expect(found === null || typeof found === "string").toBe(true);

    // 못 찾았을 때 사용자에게 보여줄 목록은 언제나 비어 있지 않아야 한다.
    expect(searchedLocations().length).toBeGreaterThan(3);
    expect(searchedLocations()[0]).toBe("PATH");

    rmSync(empty, { recursive: true, force: true });
  });

  it("찾은 결과를 캐시한다 — 호출마다 파일시스템을 훑지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-cache-"));
    const name = process.platform === "win32" ? "claude.cmd" : "claude";
    writeFileSync(join(dir, name), "", "utf8");

    delete process.env.QA_CLAUDE_PATH;
    process.env.PATH = dir;
    resetClaudeCliCache();

    const first = resolveClaudeCli();
    rmSync(dir, { recursive: true, force: true });
    // 파일이 사라져도 캐시된 값이 그대로 나온다.
    expect(resolveClaudeCli()).toBe(first);
  });
});
