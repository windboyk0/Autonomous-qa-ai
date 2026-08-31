import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunContext, makeRunId } from "./run-context.js";
import { detectAppIssues, appUnverifiedAreas } from "./app/detect-app.js";
import type { AppActionResult, AppExploreResult } from "./app/explorer.js";

/**
 * Phase 15 DoD — 앱에서 본 이상을 **웹과 같은 결함 파이프라인**에 얹는다.
 *
 * 앱 결함을 따로 담으면 사용자가 리포트를 두 개 읽어야 한다. 여기서 만든 후보는
 * judge 를 그대로 통과해야 하므로, 계약(증적 1건 이상·dedupKey)을 지키는지 잰다.
 */

let outDir: string;
let ctx: RunContext;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "phase15-"));
  ctx = new RunContext(makeRunId(), "runs", outDir);
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

const action = (over: Partial<AppActionResult> = {}): AppActionResult => ({
  label: "조회",
  fromStateKey: "s1",
  toStateKey: "s2",
  outcome: "EXECUTED",
  reason: "",
  stateChanged: true,
  durationMs: 300,
  screenName: "홈",
  errors: [],
  ...over,
});

const result = (over: Partial<AppExploreResult> = {}): AppExploreResult => ({
  screens: [],
  actions: [],
  limits: [],
  steps: 0,
  ...over,
});

describe("Phase 15 — 화면에 새어 나온 예외", () => {
  it("스택 트레이스가 보이면 HIGH 로 올린다", () => {
    const found = detectAppIssues(
      result({
        screens: [
          {
            stateKey: "s1",
            screenName: "근태 조회",
            depth: 1,
            screenshotPath: null,
            screenErrors: ["NullPointerException at Attendance.kt:42"],
            elementCount: 5,
          },
        ],
      }),
      ctx,
    );

    expect(found).toHaveLength(1);
    expect(found[0]!.suggestedSeverity).toBe("HIGH");
    expect(found[0]!.ruleId).toBe("APP-SCREEN-ERROR");
    expect(found[0]!.screenName).toBe("근태 조회");
  });

  /*
   * 같은 예외가 화면마다 다른 결함으로 세어지면 "결함 40건" 같은 숫자가 나오고,
   * 사용자는 리포트를 믿지 않게 된다.
   */
  it("행 번호만 다른 같은 예외는 같은 것으로 묶는다", () => {
    const one = detectAppIssues(
      result({
        screens: [
          {
            stateKey: "s1",
            screenName: "화면1",
            depth: 0,
            screenshotPath: null,
            screenErrors: ["TimeoutException at Api.kt:120"],
            elementCount: 1,
          },
          {
            stateKey: "s2",
            screenName: "화면2",
            depth: 1,
            screenshotPath: null,
            screenErrors: ["TimeoutException at Api.kt:377"],
            elementCount: 1,
          },
        ],
      }),
      ctx,
    );

    expect(one).toHaveLength(2);
    expect(one[0]!.dedupKey).toBe(one[1]!.dedupKey);
  });
});

describe("Phase 15 — 조작에서 본 이상", () => {
  it("조작 직후의 오류 로그를 그 화면의 결함으로 만든다", () => {
    const found = detectAppIssues(
      result({ actions: [action({ errors: ["FATAL EXCEPTION: main"] })] }),
      ctx,
    );
    expect(found[0]!.ruleId).toBe("APP-LOG-ERROR");
    expect(found[0]!.description).toContain("조회");
  });

  it("실패한 조작은 사유와 함께 남긴다", () => {
    const found = detectAppIssues(
      result({ actions: [action({ outcome: "FAILED", reason: "요소를 찾지 못했습니다" })] }),
      ctx,
    );
    expect(found[0]!.ruleId).toBe("APP-ACTION-FAILED");
    expect(found[0]!.description).toContain("요소를 찾지 못했습니다");
  });

  /*
   * 탭 다시 누르기처럼 정상적으로 아무 일도 없는 경우가 많다.
   * 확실하지 않은 것을 높게 올리면 리포트 전체가 믿기 어려워진다.
   */
  it("눌러도 안 바뀐 것은 LOW 로만 남긴다", () => {
    const found = detectAppIssues(
      result({ actions: [action({ stateChanged: false })] }),
      ctx,
    );
    expect(found[0]!.ruleId).toBe("APP-DEAD-CONTROL");
    expect(found[0]!.suggestedSeverity).toBe("LOW");
  });

  it("실패한 조작을 죽은 버튼으로 두 번 세지 않는다", () => {
    const found = detectAppIssues(
      result({ actions: [action({ outcome: "FAILED", stateChanged: false, reason: "실패" })] }),
      ctx,
    );
    expect(found).toHaveLength(1);
  });
});

describe("Phase 15 — 결함 파이프라인 계약", () => {
  it("후보마다 증적을 하나씩 붙인다", () => {
    const found = detectAppIssues(
      result({ actions: [action({ errors: ["오류 A"] }), action({ stateChanged: false })] }),
      ctx,
    );
    for (const c of found) expect(c.evidenceIds.length).toBeGreaterThanOrEqual(1);
    expect(ctx.listEvidences().length).toBe(found.length);
  });

  it("정상적으로 지나간 조작은 결함으로 만들지 않는다", () => {
    expect(detectAppIssues(result({ actions: [action()] }), ctx)).toHaveLength(0);
  });
});

describe("Phase 15 — 확인하지 않은 영역", () => {
  /*
   * 되돌릴 수 없어서 안 누른 것은 결함이 아니다. 그러나 적지 않으면
   * 사용자는 앱 전체가 검증된 줄 안다.
   */
  it("건너뛴 동작을 사유와 함께 남긴다", () => {
    const areas = appUnverifiedAreas(
      result({
        actions: [
          action({
            label: "출근하기",
            outcome: "SKIPPED_RISK",
            reason: '되돌릴 수 없는 동작으로 지정됨: "출근"',
          }),
        ],
      }),
    );
    expect(areas).toHaveLength(1);
    expect(areas[0]).toContain("출근하기");
    expect(areas[0]).toContain("출근");
  });

  it("건너뛴 것을 결함으로 만들지 않는다", () => {
    const found = detectAppIssues(
      result({ actions: [action({ outcome: "SKIPPED_DENYLIST", reason: "차단 패턴" })] }),
      ctx,
    );
    expect(found).toHaveLength(0);
  });

  it("같은 사유로 건너뛴 것은 한 줄로 모은다", () => {
    const areas = appUnverifiedAreas(
      result({
        actions: [
          action({ label: "퇴근하기", outcome: "SKIPPED_RISK", reason: "위험", screenName: "홈" }),
          action({ label: "퇴근하기", outcome: "SKIPPED_RISK", reason: "위험", screenName: "목록" }),
        ],
      }),
    );
    expect(areas).toHaveLength(1);
    expect(areas[0]).toContain("2회");
    expect(areas[0]).toContain("목록");
  });
});
