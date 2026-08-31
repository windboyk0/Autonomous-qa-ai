import { describe, expect, it } from "vitest";
import { RunConfig } from "@qa/shared";
import { readScreen, pickLogcatErrors } from "./app/observe.js";
import { resolveAdb, resetAdbCache, searchedAdbLocations } from "./app/adb.js";

/**
 * Phase 13 DoD — 앱 QA 착지장.
 *
 *   adb 를 찾고, 기기 상태를 **단계별로 구분해** 알려주고,
 *   화면 덤프에서 요소와 지문을 뽑는다.
 *
 * 대상은 Android 만이다. iOS 는 전송 계층이 통째로 달라 같은 설정으로 다룰 수 없다.
 */

/** 실제 기기 덤프의 최소 재현. Flutter 앱은 content-desc 로 라벨을 준다. */
const DUMP = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][1080,2340]">
    <node class="android.view.View" resource-id="com.x:id/title" text="출근부" bounds="[40,120][600,190]"/>
    <node class="android.view.View" content-desc="출근하기" clickable="true" enabled="true" bounds="[60,900][1020,1040]"/>
    <node class="android.view.View" content-desc="근태 조회" clickable="true" enabled="true" bounds="[60,1100][1020,1200]"/>
    <node class="android.widget.ScrollView" scrollable="true" bounds="[0,200][1080,2340]"/>
    <node class="android.view.View" text="TimeoutException after 0:00:15.000000: Future not completed" bounds="[40,300][1040,360]"/>
    <node class="android.view.View" content-desc="보이지않음" clickable="true" bounds="[0,0][0,0]"/>
  </node>
</hierarchy>`;

describe("Phase 13 — 화면 관찰", () => {
  it("클릭 가능한 요소만, 탭 좌표와 함께 뽑는다", () => {
    const screen = readScreen(DUMP)!;
    expect(screen.elements.map((e) => e.label)).toEqual(["출근하기", "근태 조회"]);

    const clockIn = screen.elements[0]!;
    expect(clockIn.x).toBe(540);
    expect(clockIn.y).toBe(970);
  });

  /** 넓이가 0인 요소는 화면에 없다. 탭해도 아무 일도 일어나지 않는다. */
  it("크기가 없는 요소는 버린다", () => {
    expect(readScreen(DUMP)!.elements.map((e) => e.label)).not.toContain("보이지않음");
  });

  /**
   * 사용자에게 raw 예외가 보이는 것 자체가 결함이다.
   * `mobile/` 실측에서 첫 화면에 TimeoutException 이 그대로 노출돼 있었다.
   */
  it("화면에 노출된 예외 문자열을 잡는다", () => {
    const screen = readScreen(DUMP)!;
    expect(screen.screenErrors.join("\n")).toContain("TimeoutException");
  });

  it("화면 이름을 붙인다", () => {
    expect(readScreen(DUMP)!.screenName).toBe("출근부");
  });

  it("스크롤 가능한 화면을 알아본다 — 숨은 요소를 찾을지 판단한다", () => {
    expect(readScreen(DUMP)!.scrollable).toBe(true);
  });

  /**
   * 덤프를 못 읽은 것과 요소가 없는 것은 다르다.
   * 이걸 뭉뚱그리면 탐색이 아무것도 못 본 채 "이상 없음"으로 끝난다.
   */
  it("덤프를 읽지 못하면 null 이다 — 빈 화면과 구분한다", () => {
    expect(readScreen("")).toBeNull();
    expect(readScreen("uiautomator: something went wrong")).toBeNull();
    expect(readScreen('<hierarchy rotation="0"></hierarchy>')!.elements).toEqual([]);
  });
});

describe("Phase 13 — 화면 지문", () => {
  /** 목록 항목이 몇 개든, 오늘 날짜가 무엇이든 같은 화면이어야 한다. */
  it("텍스트 값이 달라도 같은 화면이다", () => {
    const withOtherText = DUMP.replace("출근부", "출근부(수정)").replace(
      "TimeoutException after 0:00:15.000000: Future not completed",
      "정상",
    );
    expect(readScreen(withOtherText)!.stateKey).toBe(readScreen(DUMP)!.stateKey);
  });

  it("구조가 다르면 다른 화면이다", () => {
    const other = DUMP.replace(
      '<node class="android.view.View" content-desc="근태 조회" clickable="true" enabled="true" bounds="[60,1100][1020,1200]"/>',
      '<node class="android.widget.Button" resource-id="com.x:id/other" content-desc="다른것" clickable="true" bounds="[60,1100][1020,1200]"/>',
    );
    expect(readScreen(other)!.stateKey).not.toBe(readScreen(DUMP)!.stateKey);
  });

  /** 시각·난수를 섞으면 회귀 테스트가 불가능해진다 (CLAUDE.md §27-2). */
  it("같은 덤프는 항상 같은 지문이다", () => {
    expect(readScreen(DUMP)!.stateKey).toBe(readScreen(DUMP)!.stateKey);
  });
});

describe("Phase 13 — logcat", () => {
  it("크래시성 로그만 추린다", () => {
    const lines = [
      "08-31 11:00:00.000 I/flutter: 정상 로그",
      "08-31 11:00:01.000 E/AndroidRuntime: FATAL EXCEPTION: main",
      "08-31 11:00:02.000 I/flutter: Unhandled Exception: Null check operator used on a null value",
      "08-31 11:00:03.000 D/x: 그냥 디버그",
    ];
    const hits = pickLogcatErrors(lines);
    expect(hits.length).toBe(2);
    expect(hits.join("\n")).toContain("FATAL EXCEPTION");
  });

  it("같은 줄이 반복되면 한 번만 센다", () => {
    const same = "E/AndroidRuntime: FATAL EXCEPTION: main";
    expect(pickLogcatErrors([same, same, same]).length).toBe(1);
  });
});

describe("Phase 13 — adb 찾기", () => {
  it("설정에서 지정한 경로가 가장 우선한다", () => {
    resetAdbCache();
    // 존재하지 않는 경로는 무시하고 다음 후보로 넘어간다 — 오타 하나로 멈추면 안 된다.
    expect(resolveAdb("C:/없는경로/adb.exe")).not.toBe("C:/없는경로/adb.exe");
  });

  it("못 찾았을 때 어디를 찾았는지 알려줄 수 있다", () => {
    expect(searchedAdbLocations()[0]).toBe("QA_ADB_PATH");
    expect(searchedAdbLocations().length).toBeGreaterThan(3);
  });
});

describe("Phase 13 — 앱 모드 설정", () => {
  it("패키지명이 없으면 거부한다", () => {
    expect(RunConfig.safeParse({ projectName: "p", mode: "app" }).success).toBe(false);
    expect(
      RunConfig.safeParse({ projectName: "p", mode: "app", app: { packageName: "com.x" } }).success,
    ).toBe(true);
  });

  it("앱 모드에는 URL 도 소스 폴더도 요구하지 않는다", () => {
    const parsed = RunConfig.parse({
      projectName: "p",
      mode: "app",
      app: { packageName: "com.x" },
    });
    expect(parsed.targetUrl).toBe("");
    expect(parsed.source.rootDir).toBe("");
  });

  /** 되돌릴 수 없는 동작은 동의가 있어야 한다. 웹의 삭제 동의와 같은 성격이다. */
  it("위험 동작은 기본으로 시도하지 않는다", () => {
    const parsed = RunConfig.parse({
      projectName: "p",
      mode: "app",
      app: { packageName: "com.x" },
    });
    expect(parsed.app.tryRiskyLast).toBe(false);
    expect(parsed.app.maxSteps).toBeGreaterThan(0);
    expect(parsed.app.maxDurationMs).toBeGreaterThan(0);
  });
});
