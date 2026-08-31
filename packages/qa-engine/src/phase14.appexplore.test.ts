import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunConfig } from "@qa/shared";
import { RunContext, makeRunId } from "./run-context.js";
import { AppExplorer } from "./app/explorer.js";
import type { AppDriver } from "./app/driver.js";
import { readScreen, type AppScreen } from "./app/observe.js";

/**
 * Phase 14 DoD — 앱 자율 탐색 루프.
 *
 *   화면을 넓게 훑되 **같은 화면을 두 번 훑지 않고**, 예산에서 멈추고,
 *   되돌릴 수 없는 동작은 동의 없이 누르지 않는다.
 *
 * 실제 기기로는 이것을 잴 수 없다. 기기 상태(GPS·시간·데이터)가 매번 달라
 * 같은 결과가 나오지 않기 때문이다. 그래서 **화면 그래프를 흉내 내는 가짜 기기**로
 * "루프가 규칙대로 도는가"만 정확히 잰다. 웹이 fixture 서버를 쓴 것과 같은 자리다.
 */

/** 화면 하나를 XML 로 만든다. 실제 uiautomator 덤프와 같은 모양이다. */
function screenXml(title: string, labels: string[], extra = ""): string {
  const nodes = labels
    .map(
      (label, i) =>
        `<node class="android.view.View" content-desc="${label}" clickable="true" enabled="true" ` +
        `bounds="[60,${300 + i * 150}][1020,${400 + i * 150}]"/>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][1080,2340]">
    <node class="android.view.View" resource-id="app:id/title" text="${title}" bounds="[40,120][600,190]"/>
${nodes}
${extra}
  </node>
</hierarchy>`;
}

interface FakeApp {
  /** 화면 이름 → XML */
  screens: Record<string, string>;
  /** "화면|라벨" → 가는 곳. 없으면 제자리(= 죽은 버튼) */
  edges: Record<string, string>;
  /** 이 라벨을 누르면 앱 밖으로 나간다 */
  leavesApp?: string[];
  /** 이 화면에 오면 로그에 이 오류가 남는다 */
  logErrors?: Record<string, string[]>;
}

class FakeDriver implements AppDriver {
  current = "home";
  private stack: string[] = [];
  private outside = false;
  private pendingLog: string[] = [];
  readonly taps: string[] = [];
  readonly launches: string[] = [];

  constructor(private readonly app: FakeApp) {}

  launch(): void {
    this.launches.push(this.current);
    this.current = "home";
    this.stack = [];
    this.outside = false;
  }

  observe(): AppScreen | null {
    if (this.outside) return null;
    const xml = this.app.screens[this.current];
    return xml ? readScreen(xml) : null;
  }

  tap(x: number, y: number): void {
    const screen = this.observe();
    const element = screen?.elements.find((e) => e.x === x && e.y === y);
    if (!element) return;

    this.taps.push(`${this.current}|${element.label}`);

    if ((this.app.leavesApp ?? []).includes(element.label)) {
      this.outside = true;
      return;
    }

    const to = this.app.edges[`${this.current}|${element.label}`];
    if (to && to !== this.current) {
      this.stack.push(this.current);
      this.current = to;
      this.pendingLog = this.app.logErrors?.[to] ?? [];
    }
  }

  back(): void {
    const prev = this.stack.pop();
    if (prev) this.current = prev;
  }

  scrollDown(): void {
    /* 가짜 기기에는 숨은 요소가 없다 */
  }

  inApp(): boolean {
    return !this.outside;
  }

  freshLogErrors(): string[] {
    const out = this.pendingLog;
    this.pendingLog = [];
    return out;
  }

  screenshot(): boolean {
    return true;
  }

  settle(): void {
    /* 가짜 기기는 즉시 안정된다 */
  }

  /** 무선 디버깅이 끊긴 상황을 흉내내려고 테스트에서 false 로 바꾼다. */
  reachable = true;

  isReachable(): boolean {
    return this.reachable;
  }
}

let outDir: string;
let ctx: RunContext;

const config = (app: Record<string, unknown> = {}): RunConfig =>
  RunConfig.parse({
    projectName: "app",
    mode: "app",
    app: { packageName: "com.example.app", ...app },
    outDir: "runs",
  });

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "qa-phase14-"));
  ctx = new RunContext(makeRunId(), "runs", outDir);
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

/** 홈에서 두 화면으로 갈라지고, 한쪽에 죽은 버튼이 있는 앱. */
const SIMPLE: FakeApp = {
  screens: {
    home: screenXml("출근부", ["근태 조회", "일정관리", "먹통버튼"]),
    attendance: screenXml("근태 조회", ["달력 보기"]),
    calendar: screenXml("달력", ["오늘로"]),
    schedule: screenXml("일정관리", []),
  },
  edges: {
    "home|근태 조회": "attendance",
    "home|일정관리": "schedule",
    "attendance|달력 보기": "calendar",
    // "먹통버튼" 과 "오늘로" 는 간선이 없다 → 화면이 바뀌지 않는다
  },
};

describe("Phase 14 — 화면을 넓게 훑는다", () => {
  it("도달 가능한 화면을 모두 방문한다", () => {
    const driver = new FakeDriver(SIMPLE);
    const result = new AppExplorer(driver, ctx, config()).explore();

    expect(result.screens.map((s) => s.screenName).sort()).toEqual(
      ["근태 조회", "달력", "일정관리", "출근부"].sort(),
    );
  });

  /** 같은 화면을 두 번 훑으면 예산만 태우고 얻는 게 없다. */
  it("같은 화면에서 같은 요소를 두 번 누르지 않는다", () => {
    const driver = new FakeDriver(SIMPLE);
    new AppExplorer(driver, ctx, config()).explore();

    const counts = new Map<string, number>();
    for (const tap of driver.taps) counts.set(tap, (counts.get(tap) ?? 0) + 1);
    for (const [tap, n] of counts) expect(n, `${tap} 를 ${n}번 눌렀다`).toBe(1);
  });

  /** 눌렀는데 아무 일도 일어나지 않는 버튼은 결함 후보다. Phase 15 가 이 기록을 쓴다. */
  it("화면이 바뀌지 않은 조작을 기록한다", () => {
    const driver = new FakeDriver(SIMPLE);
    const result = new AppExplorer(driver, ctx, config()).explore();

    const dead = result.actions.find((a) => a.label === "먹통버튼");
    expect(dead?.outcome).toBe("EXECUTED");
    expect(dead?.stateChanged).toBe(false);
    expect(dead?.reason).toContain("바뀌지 않았습니다");
  });

  it("화면마다 스크린샷 증적을 남긴다", () => {
    const driver = new FakeDriver(SIMPLE);
    const result = new AppExplorer(driver, ctx, config()).explore();
    expect(result.screens.every((s) => s.screenshotPath !== null)).toBe(true);
    expect(ctx.listEvidences().length).toBeGreaterThanOrEqual(result.screens.length);
  });
});

describe("Phase 14 — 앱 밖으로 나갔을 때", () => {
  const LEAVES: FakeApp = {
    screens: {
      home: screenXml("홈", ["설정 열기", "근태 조회"]),
      attendance: screenXml("근태 조회", []),
    },
    edges: { "home|근태 조회": "attendance" },
    leavesApp: ["설정 열기"],
  };

  /** 밖을 훑으면 남의 앱을 QA 하는 셈이다. */
  it("이탈하면 다시 띄우고 이어서 탐색한다", () => {
    const driver = new FakeDriver(LEAVES);
    const result = new AppExplorer(driver, ctx, config()).explore();

    const left = result.actions.find((a) => a.label === "설정 열기");
    expect(left?.reason).toContain("이탈");
    // 다시 띄운 뒤 나머지도 봤다.
    expect(result.screens.map((s) => s.screenName)).toContain("근태 조회");
    expect(driver.launches.length).toBeGreaterThan(1);
  });
});

describe("Phase 14 — 되돌릴 수 없는 동작", () => {
  const RISKY: FakeApp = {
    screens: {
      home: screenXml("홈", ["근태 조회", "로그아웃", "출근하기"]),
      attendance: screenXml("근태 조회", []),
    },
    edges: { "home|근태 조회": "attendance" },
  };

  /** 탐색 도중에 로그아웃되면 나머지 탐색이 통째로 무의미해진다. */
  it("동의하지 않으면 누르지 않고 사유를 남긴다", () => {
    const driver = new FakeDriver(RISKY);
    const result = new AppExplorer(driver, ctx, config()).explore();

    expect(driver.taps.join("\n")).not.toContain("로그아웃");
    expect(driver.taps.join("\n")).not.toContain("출근하기");

    const logout = result.actions.find((a) => a.label === "로그아웃");
    expect(logout?.outcome).toBe("SKIPPED_DENYLIST");

    const clockIn = result.actions.find((a) => a.label === "출근하기");
    expect(clockIn?.outcome).toMatch(/SKIPPED_(RISK|LOW_CONFIDENCE)/);
  });

  /** 동의했더라도 **맨 마지막에** 본다. 먼저 누르면 나머지를 못 본다. */
  it("동의하면 일반 탐색을 마친 뒤에 시도한다", () => {
    const driver = new FakeDriver(RISKY);
    new AppExplorer(driver, ctx, config({ tryRiskyLast: true })).explore();

    const taps = driver.taps;
    const risky = taps.findIndex((t) => t.includes("출근하기"));
    const normal = taps.findIndex((t) => t.includes("근태 조회"));
    expect(risky).toBeGreaterThan(-1);
    expect(normal).toBeGreaterThan(-1);
    expect(risky, "위험 동작이 일반 탐색보다 먼저 실행됐다").toBeGreaterThan(normal);

    // denylist 는 동의해도 누르지 않는다.
    expect(taps.join("\n")).not.toContain("로그아웃");
  });
});

describe("Phase 14 — 예산", () => {
  /** 예산이 없으면 자율 탐색은 끝나지 않는다. */
  it("스텝 상한에서 멈추고 그 사실을 남긴다", () => {
    const driver = new FakeDriver(SIMPLE);
    const result = new AppExplorer(driver, ctx, config({ maxSteps: 2 })).explore();

    expect(result.steps).toBeLessThanOrEqual(2);
    expect(result.limits.join("\n")).toContain("최대 스텝");
  });

  it("화면 수 상한에서 멈춘다", () => {
    const driver = new FakeDriver(SIMPLE);
    const result = new AppExplorer(driver, ctx, config({ maxScreens: 2 })).explore();
    expect(result.screens.length).toBeLessThanOrEqual(3);
    expect(result.limits.join("\n")).toContain("최대 화면 수");
  });
});

describe("Phase 14 — 읽지 못했을 때", () => {
  /**
   * Flutter 앱이 Semantics 를 노출하지 않으면 요소가 하나도 안 나온다.
   * 그것을 "이상 없음"으로 끝내면 아무것도 안 보고 성공한 척하게 된다.
   */
  it("요소를 못 찾으면 그 사실을 한계로 남긴다", () => {
    const driver = new FakeDriver({ screens: { home: screenXml("홈", []) }, edges: {} });
    const result = new AppExplorer(driver, ctx, config()).explore();

    expect(result.screens.length).toBe(1);
    expect(result.limits.join("\n")).toContain("클릭 가능한 요소를 찾지 못했습니다");
    expect(result.limits.join("\n")).toContain("Semantics");
  });

  it("덤프 자체를 읽지 못하면 다른 사유를 남긴다", () => {
    const driver = new FakeDriver({ screens: {}, edges: {} });
    const result = new AppExplorer(driver, ctx, config()).explore();
    expect(result.limits.join("\n")).toContain("접근성 정보");
  });

  /*
   * 실측: 무선 디버깅이 탐색 도중 끊겼는데 "앱이 접근성 정보를 노출하지
   * 않는다"고 안내했다. 사용자는 멀쩡한 앱을 뜯어보게 된다.
   * 원인이 다르면 안내도 달라야 한다.
   */
  it("기기가 끊긴 것과 요소가 없는 것을 구분해 안내한다", () => {
    const driver = new FakeDriver({ screens: {}, edges: {} });
    driver.reachable = false;

    const result = new AppExplorer(driver, ctx, config()).explore();

    const limits = result.limits.join("\n");
    expect(limits).toContain("기기 연결이 끊겼습니다");
    expect(limits).not.toContain("접근성 정보");
  });
});

describe("Phase 14 — logcat", () => {
  it("화면 진입 직후의 로그 오류를 그 조작에 붙인다", () => {
    const driver = new FakeDriver({
      screens: {
        home: screenXml("홈", ["근태 조회"]),
        attendance: screenXml("근태 조회", []),
      },
      edges: { "home|근태 조회": "attendance" },
      logErrors: { attendance: ["E/AndroidRuntime: FATAL EXCEPTION: main"] },
    });
    const result = new AppExplorer(driver, ctx, config()).explore();

    const action = result.actions.find((a) => a.label === "근태 조회");
    expect(action?.errors.join("\n")).toContain("FATAL EXCEPTION");
  });
});

/*
 * 실기기에서만 드러난 것들이다. 가짜 덤프를 아무리 잘 만들어도
 * "Flutter 는 text 를 안 쓴다" 같은 것은 상상해서 나오지 않는다.
 */
describe("Phase 14 — 화면 이름", () => {
  /** 실제 근태관리 앱 덤프의 모양. 라벨이 전부 content-desc 로 온다. */
  const flutterBar = (title: string, extra = "") => `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][1080,2340]">
    <node class="android.view.View" content-desc="메뉴" clickable="true" bounds="[48,150][132,234]"/>
    <node class="android.view.View" content-desc="${title}" bounds="[200,150][700,230]"/>
    <node class="android.view.View" content-desc="알림" clickable="true" bounds="[700,150][784,234]"/>
    <node class="android.view.View" content-desc="로그아웃" clickable="true" bounds="[960,150][1044,234]"/>
    <node class="android.view.View" content-desc="퇴근하기" clickable="true" bounds="[48,500][1032,640]"/>
${extra}
  </node>
</hierarchy>`;

  it("햄버거 버튼이 아니라 앱바 제목을 쓴다", () => {
    // 화면 8개가 전부 "메뉴" 로 나왔던 그 상황이다.
    expect(readScreen(flutterBar("출퇴근 관리"))!.screenName).toBe("출퇴근 관리");
  });

  it("아이콘 버튼은 이름 후보에서 뺀다", () => {
    const name = readScreen(flutterBar("근태 내역"))!.screenName;
    expect(name).not.toBe("알림");
    expect(name).not.toBe("로그아웃");
  });

  it("화면을 덮는 스크림을 이름으로 쓰지 않는다", () => {
    const scrim =
      '<node class="android.view.View" content-desc="스크림" clickable="true" bounds="[0,0][1080,2340]"/>';
    const screen = readScreen(flutterBar("근태 내역", scrim))!;
    expect(screen.screenName).not.toContain("스크림");
    expect(screen.screenName).toContain("근태 내역");
  });

  /*
   * 시트가 열린 화면과 안 열린 화면은 제목이 같다. 리포트에 같은 이름이
   * 두 번 나오면 사용자는 같은 화면을 두 번 셌다고 본다.
   */
  it("팝업이 떠 있으면 이름에 밝히고 다른 화면으로 센다", () => {
    const scrim =
      '<node class="android.view.View" content-desc="스크림" clickable="true" bounds="[0,0][1080,2340]"/>';
    const plain = readScreen(flutterBar("근태 내역"))!;
    const sheet = readScreen(flutterBar("근태 내역", scrim))!;

    expect(sheet.screenName).toContain("팝업");
    expect(plain.screenName).not.toContain("팝업");
    expect(sheet.stateKey).not.toBe(plain.stateKey);
  });

  it("쓸 이름이 하나도 없으면 지문으로 부른다", () => {
    const bare = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0"><node class="android.widget.FrameLayout" bounds="[0,0][1080,2340]"/></hierarchy>`;
    expect(readScreen(bare)!.screenName).toMatch(/^화면-/);
  });
});
