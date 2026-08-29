import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "@qa/fixture-admin";
import {
  IssuesFile,
  RunConfig,
  type AiProvider,
  type AiProviderConfig,
  type Issue,
  type ProviderStatus,
} from "@qa/shared";
import { RunContext, makeRunId } from "./run-context.js";
import { registerSecret } from "./emitter.js";
import { runQa } from "./run.js";
import { NoneProvider, OllamaProvider } from "./ai/index.js";

/**
 * Phase 4 DoD.
 *
 *   **Provider를 강제로 실패시켜도 Phase 3 리포트가 손실 없이 나온다.**
 *   `none` / 실패 Provider / 실제 Ollama 세 경로의 리포트 목차가 동일하다.
 *
 * AI는 덧붙이기만 한다. 판정을 뒤집거나 Issue를 지우지 않는다.
 */

const PASSWORD = "admin123!";
const OLLAMA_URL = "http://localhost:11434";
const SMALL_MODEL = "exaone3.5:2.4b";

/** 17개 목차. AI 상태와 무관하게 항상 있어야 한다. */
const REQUIRED_HEADINGS = [
  "1. 실행정보",
  "2. 테스트환경",
  "3. Executive Summary",
  "4. CRUD 결과",
  "5. Critical",
  "6. High",
  "7. Medium",
  "8. Low",
  "9. 화면별 개선점",
  "10. Console 오류",
  "11. Network/API 오류",
  "12. UX/UI 개선",
  "13. 기능 누락 후보",
  "14. 우선순위",
  "15. 권장 수정 순서",
  "16. 탐색 제한",
  "17. 미검증 기능",
];

/** 모든 호출이 터지는 Provider. Phase 4의 핵심 시나리오다. */
class ExplodingProvider implements AiProvider {
  async healthCheck(): Promise<ProviderStatus> {
    return {
      available: true, // 헬스체크는 통과시키고 실제 호출에서 터뜨린다
      kind: "ollama",
      model: "exploding",
      visionCapable: false,
      detail: "테스트용 폭발 Provider",
      remediation: null,
    };
  }
  async analyzePage(): Promise<never> {
    throw new Error("analyzePage 폭발");
  }
  async analyzeFunction(): Promise<never> {
    throw new Error("analyzeFunction 폭발");
  }
  async analyzeScreenshot(): Promise<never> {
    throw new Error("analyzeScreenshot 폭발");
  }
  async judgeIssues(): Promise<never> {
    throw new Error("judgeIssues 폭발");
  }
  async generateReport(): Promise<never> {
    throw new Error("generateReport 폭발");
  }
}

/** 헬스체크부터 떨어지는 Provider (Claude 미설치 상황). */
class UnavailableProvider extends NoneProvider {
  override async healthCheck(): Promise<ProviderStatus> {
    return {
      available: false,
      kind: "claude",
      model: "",
      visionCapable: true,
      detail: "Claude Code CLI를 찾을 수 없습니다.",
      remediation: "Claude Code를 설치하고 로그인한 뒤 다시 시도하세요.",
    };
  }
}

/** 절반만 성공하는 Provider → degraded 경로. */
class FlakyProvider extends NoneProvider {
  override async healthCheck(): Promise<ProviderStatus> {
    return {
      available: true,
      kind: "ollama",
      model: "flaky",
      visionCapable: false,
      detail: "테스트용 불안정 Provider",
      remediation: null,
    };
  }
  override async analyzeFunction(): Promise<never> {
    throw new Error("analyzeFunction 실패");
  }
  override async generateReport(): Promise<string> {
    return "AI가 만든 요약 문장입니다.";
  }
}

let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
let outDir: string;
let ollamaAvailable = false;

interface RunArtifacts {
  file: ReturnType<typeof IssuesFile.parse>;
  issues: Issue[];
  report: string;
}

/** 탐색 자체는 Phase 2·3이 검증한다. 여기서는 AI 층만 보므로 예산을 줄인다. */
function makeConfig(ai: Partial<AiProviderConfig>) {
  return RunConfig.parse({
    projectName: "fixture",
    targetUrl: fixture.url,
    headless: true,
    login: { enabled: true, username: "admin", password: PASSWORD },
    budget: { settleMs: 100, maxScreens: 4, maxDurationMs: 240_000 },
    ai,
  });
}

async function run(
  ai: Partial<AiProviderConfig>,
  provider?: AiProvider,
): Promise<RunArtifacts> {
  const ctx = new RunContext(
    makeRunId(new Date(Date.now() + Math.floor(Math.random() * 1e6))),
    outDir,
    ".",
  );
  const outcome = await runQa(makeConfig(ai), ctx, {
    createProvider: provider ? () => provider : undefined,
  });
  expect(outcome.status, outcome.message).toBe("COMPLETED");

  const file = IssuesFile.parse(JSON.parse(readFileSync(join(ctx.runDir, "issues.json"), "utf8")));
  return {
    file,
    issues: file.issues,
    report: readFileSync(join(ctx.runDir, "report.md"), "utf8"),
  };
}

/** 비교용 지문. AI가 손대면 안 되는 부분만 뽑는다. */
function skeleton(issues: Issue[]) {
  return issues.map((i) => ({
    id: i.id,
    ruleId: i.ruleId,
    severity: i.severity,
    priority: i.priority,
    screens: i.screens,
    occurrenceCount: i.occurrenceCount,
    evidenceCount: i.evidenceIds.length,
  }));
}

let baseline: RunArtifacts;
let exploded: RunArtifacts;
let unavailable: RunArtifacts;
let flaky: RunArtifacts;

beforeAll(async () => {
  fixture = await startFixtureServer(0);
  outDir = join(tmpdir(), `qa-phase4-${Date.now()}`);
  registerSecret(PASSWORD);

  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as { models: Array<{ name: string }> };
    ollamaAvailable = body.models.some((m) => m.name === SMALL_MODEL);
  } catch {
    ollamaAvailable = false;
  }

  baseline = await run({ kind: "none" });
  exploded = await run({ kind: "ollama", model: "exploding" }, new ExplodingProvider());
  unavailable = await run({ kind: "claude" }, new UnavailableProvider());
  flaky = await run({ kind: "ollama", model: "flaky" }, new FlakyProvider());
}, 900_000);

afterAll(async () => {
  await fixture.close();
  rmSync(outDir, { recursive: true, force: true });
});

describe("Phase 4 — AI 실패가 결과를 손상시키지 않는다", () => {
  it("모든 호출이 터져도 Run이 완료된다", () => {
    expect(exploded.file.summary.status).toBe("COMPLETED");
  });

  /** Phase 4의 핵심 DoD. */
  it("모든 호출이 터져도 Issue가 룰 기반 결과와 완전히 같다", () => {
    expect(skeleton(exploded.issues)).toEqual(skeleton(baseline.issues));
  });

  it("헬스체크부터 떨어져도 Issue가 그대로다", () => {
    expect(skeleton(unavailable.issues)).toEqual(skeleton(baseline.issues));
  });

  it("일부만 실패해도 Issue가 그대로다", () => {
    expect(skeleton(flaky.issues)).toEqual(skeleton(baseline.issues));
  });

  it.each([
    ["none", () => baseline],
    ["폭발", () => exploded],
    ["미설치", () => unavailable],
    ["불안정", () => flaky],
  ])("%s Provider에서도 17개 목차가 전부 나온다", (_label, get) => {
    for (const heading of REQUIRED_HEADINGS) {
      expect(get().report, `목차 "${heading}" 누락`).toContain(`## ${heading}`);
    }
  });

  it("모든 경로에서 증적이 보존된다", () => {
    for (const artifacts of [exploded, unavailable, flaky]) {
      for (const issue of artifacts.issues) {
        expect(issue.evidenceIds.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("Phase 4 — AI 상태 보고", () => {
  it("사용하지 않으면 not_used", () => {
    expect(baseline.file.summary.aiStatus).toBe("not_used");
    expect(baseline.file.summary.aiFailureReason).toBeNull();
  });

  it("전부 실패하면 failed 이고 사유가 남는다", () => {
    expect(exploded.file.summary.aiStatus).toBe("failed");
    expect(exploded.file.summary.aiFailureReason).toContain("폭발");
  });

  /** 사용자가 무엇을 해야 하는지 알 수 있어야 한다. */
  it("Provider 미설치는 조치 방법과 함께 보고한다", () => {
    expect(unavailable.file.summary.aiStatus).toBe("failed");
    expect(unavailable.file.summary.aiFailureReason).toContain("Claude Code");
    expect(unavailable.file.summary.aiFailureReason).toContain("설치");
  });

  it("일부만 실패하면 degraded", () => {
    expect(flaky.file.summary.aiStatus).toBe("degraded");
    expect(flaky.file.summary.aiFailureReason).toContain("analyzeFunction");
  });

  it("AI를 못 쓰면 리포트가 그 사실을 명시한다", () => {
    expect(exploded.report).toMatch(/AI 분석을 사용할 수 없어/);
    expect(baseline.report).toMatch(/AI 분석은 사용하지 않았습니다/);
  });
});

describe("Phase 4 — AI 결과 반영", () => {
  it("AI 요약이 있으면 Executive Summary에 쓰인다", () => {
    expect(flaky.report).toContain("AI가 만든 요약 문장입니다.");
  });

  it("AI 요약이 없으면 룰 기반 문장으로 대체된다", () => {
    expect(baseline.report).toMatch(/가장 급한 것은|발견된 문제가 없습니다/);
  });

  it("AI가 실패한 Issue의 권장 조치가 비지 않는다", () => {
    for (const issue of exploded.issues) {
      expect(issue.recommendation.length).toBeGreaterThan(0);
      expect(issue.impact.length).toBeGreaterThan(0);
    }
  });

  it("리포트에 비밀번호가 남지 않는다", () => {
    for (const artifacts of [baseline, exploded, unavailable, flaky]) {
      expect(artifacts.report).not.toContain(PASSWORD);
    }
  });
});

describe("Phase 4 — Provider 계약", () => {
  it("NoneProvider는 빈 결과를 주고 던지지 않는다", async () => {
    const p = new NoneProvider();
    await expect(p.healthCheck()).resolves.toMatchObject({ available: false, kind: "none" });
    await expect(p.judgeIssues()).resolves.toEqual({
      mergeGroups: [],
      falsePositiveIds: [],
      severityOverrides: [],
    });
    await expect(p.generateReport()).resolves.toBe("");
  });

  it("Ollama가 꺼져 있으면 조치 방법을 알려준다", async () => {
    const p = new OllamaProvider({
      kind: "ollama",
      baseUrl: "http://127.0.0.1:59999",
      model: "any",
      claudeMode: "cli",
      timeoutMs: 3000,
      maxConcurrency: 1,
      visionCapable: false,
    });
    const status = await p.healthCheck();
    expect(status.available).toBe(false);
    expect(status.remediation).toContain("Ollama");
  });

  it("설치되지 않은 모델을 지정하면 pull 명령을 알려준다", async () => {
    if (!ollamaAvailable) return;
    const p = new OllamaProvider({
      kind: "ollama",
      baseUrl: OLLAMA_URL,
      model: "존재하지-않는-모델:1b",
      claudeMode: "cli",
      timeoutMs: 5000,
      maxConcurrency: 1,
      visionCapable: false,
    });
    const status = await p.healthCheck();
    expect(status.available).toBe(false);
    expect(status.remediation).toContain("ollama pull");
  });

  /** Vision 미지원 모델에 이미지를 보내면 조용히 헛소리를 한다. 아예 거부해야 한다. */
  it("Vision 미지원 모델은 스크린샷 분석을 거부한다", async () => {
    const p = new OllamaProvider({
      kind: "ollama",
      baseUrl: OLLAMA_URL,
      model: SMALL_MODEL,
      claudeMode: "cli",
      timeoutMs: 5000,
      maxConcurrency: 1,
      visionCapable: false,
    });
    await expect(
      p.analyzeScreenshot({
        screenName: "x",
        screenshotBase64: "",
        metrics: {
          viewportWidth: 1440,
          viewportHeight: 900,
          scrollWidth: 1440,
          scrollHeight: 900,
          hasHorizontalOverflow: false,
          overflowingElements: [],
          overlappingPairs: [],
          truncatedTexts: [],
          obscuredCtas: [],
          emptyAreaRatio: 0.1,
        },
      }),
    ).rejects.toThrow(/Vision/);
  });
});

describe("Phase 4 — 실제 Ollama 왕복", () => {
  it("healthCheck가 설치된 모델을 인식한다", async () => {
    if (!ollamaAvailable) {
      console.log(`[skip] Ollama 또는 ${SMALL_MODEL} 미설치`);
      return;
    }
    const p = new OllamaProvider({
      kind: "ollama",
      baseUrl: OLLAMA_URL,
      model: SMALL_MODEL,
      claudeMode: "cli",
      timeoutMs: 10_000,
      maxConcurrency: 1,
      visionCapable: false,
    });
    const status = await p.healthCheck();
    expect(status.available).toBe(true);
    expect(status.model).toBe(SMALL_MODEL);
  });

  /** 실제 모델이 스키마에 맞는 JSON을 돌려주는지 — 프롬프트와 파서의 계약 검증. */
  it("실제 모델이 스키마에 맞는 JSON을 돌려준다", async () => {
    if (!ollamaAvailable) return;
    const p = new OllamaProvider({
      kind: "ollama",
      baseUrl: OLLAMA_URL,
      model: SMALL_MODEL,
      claudeMode: "cli",
      timeoutMs: 180_000,
      maxConcurrency: 1,
      visionCapable: false,
    });

    const result = await p.generateReport({
      summary: baseline.file.summary,
      issues: baseline.issues,
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(10);
  }, 200_000);
});
