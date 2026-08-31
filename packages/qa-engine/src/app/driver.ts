import { Adb } from "./adb.js";
import { pickLogcatErrors, readScreen, type AppScreen } from "./observe.js";

/**
 * 앱 조작의 최소 계약.
 *
 * 탐색 루프는 adb 를 직접 부르지 않고 이 인터페이스만 쓴다.
 * **그래야 기기 없이도 루프를 검증할 수 있다.** 웹은 fixture 서버를 띄워
 * 탐지율을 쟀지만, 앱은 실제 기기 상태(GPS·시간·데이터)가 매번 달라
 * 같은 방식이 성립하지 않는다. 대신 화면 그래프를 흉내 내는 가짜 드라이버로
 * "루프가 규칙대로 도는가"를 잰다.
 */
export interface AppDriver {
  /** 앱을 처음 상태로 띄운다. */
  launch(): void;
  /** 현재 화면. 덤프를 읽지 못하면 null — 빈 화면과 구분한다. */
  observe(): AppScreen | null;
  tap(x: number, y: number): void;
  back(): void;
  /** 숨은 요소를 찾기 위해 아래로 스크롤한다. */
  scrollDown(): void;
  /** 우리 앱 안에 있는가. 밖으로 나가면 탐색이 엉뚱한 곳을 훑는다. */
  inApp(): boolean;
  /** 마지막 호출 이후의 크래시성 로그. */
  freshLogErrors(): string[];
  /** 증적 스크린샷을 남긴다. 실패하면 false. */
  screenshot(path: string): boolean;
  /** 조작 후 화면이 안정될 때까지 기다린다. */
  settle(): void;
  /** 기기가 아직 붙어 있는가. 화면을 못 읽었을 때 원인을 가리기 위해 쓴다. */
  isReachable(): boolean;
}

/** 실제 기기용 구현. */
export class AdbDriver implements AppDriver {
  private logMarker: string | null = null;

  constructor(
    private readonly adb: Adb,
    private readonly packageName: string,
    private readonly settleMs: number,
  ) {}

  launch(): void {
    this.adb.launch(this.packageName);
    this.adb.sleep(Math.max(this.settleMs, 2_000));
  }

  observe(): AppScreen | null {
    return readScreen(this.adb.dumpUi());
  }

  tap(x: number, y: number): void {
    this.adb.tap(x, y);
  }

  back(): void {
    this.adb.back();
  }

  scrollDown(): void {
    const size = this.adb.screenSize() ?? { width: 1080, height: 1920 };
    const x = Math.floor(size.width / 2);
    this.adb.swipe(x, Math.floor(size.height * 0.7), x, Math.floor(size.height * 0.3));
  }

  inApp(): boolean {
    return this.adb.currentFocus().startsWith(this.packageName);
  }

  freshLogErrors(): string[] {
    const { lines, marker } = this.adb.logcatSince(this.logMarker);
    this.logMarker = marker;
    return pickLogcatErrors(lines);
  }

  screenshot(path: string): boolean {
    return this.adb.screenshot(path);
  }

  settle(): void {
    this.adb.sleep(this.settleMs);
  }

  isReachable(): boolean {
    return this.adb.isReachable();
  }
}
