import { createInterface } from "node:readline";
import { EngineCommand } from "@qa/shared";
import { log } from "./emitter.js";

/**
 * 실행 제어 (Pause / Resume / Stop).
 *
 * stdin의 JSON Lines로 명령을 받는다. Electron이 [일시정지] [중단] 버튼을
 * 이 통로에 연결한다 — 새 규약을 만들지 않고 Phase 0의 `EngineCommand`를 그대로 쓴다.
 *
 * **Stop은 버리는 것이 아니다.** 지금까지 모은 증적으로 리포트를 만든 뒤 끝낸다.
 * 몇 분씩 걸린 탐색 결과를 중단 한 번으로 날리면 사용자는 중단 버튼을 못 누른다.
 */
export class RunControl {
  private paused = false;
  private stopRequested = false;
  private waiters: Array<() => void> = [];

  private lines: ReturnType<typeof createInterface> | null = null;

  /** stdin 구독을 시작한다. stdin이 없으면(직접 실행) 아무 일도 하지 않는다. */
  listen(input: NodeJS.ReadableStream = process.stdin): void {
    if (process.stdin.isTTY) return; // 사람이 직접 친 터미널이면 제어 채널이 아니다

    const lines = createInterface({ input });
    this.lines = lines;

    /**
     * **stdin을 unref한다.**
     *
     * 부모(Electron)가 연 파이프는 끝나지 않으므로, readline이 참조를 쥐고 있으면
     * Run이 끝나고 리포트까지 다 쓴 뒤에도 프로세스가 종료되지 않는다.
     * 그러면 부모는 `exit`를 못 받아 "실행 중"에서 영원히 멈춘 화면을 보게 된다
     * (실측: 리포트는 다 나왔는데 중단 버튼이 계속 활성 상태로 남았다).
     *
     * unref해도 프로세스가 살아 있는 동안 명령은 정상적으로 수신된다.
     */
    process.stdin.unref?.();

    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = EngineCommand.safeParse(JSON.parse(trimmed));
        if (!parsed.success) return;
        this.apply(parsed.data);
      } catch {
        /* 제어 채널의 잡음은 무시한다 */
      }
    });
  }

  apply(command: EngineCommand): void {
    switch (command.type) {
      case "pause":
        if (!this.paused) {
          this.paused = true;
          log("info", "일시정지 요청을 받았습니다. 진행 중인 액션을 마치고 멈춥니다.");
        }
        break;
      case "resume":
        if (this.paused) {
          this.paused = false;
          log("info", "탐색을 재개합니다.");
          this.release();
        }
        break;
      case "stop":
        this.stopRequested = true;
        this.paused = false;
        log("info", "중단 요청을 받았습니다. 지금까지 모은 증적으로 리포트를 만듭니다.");
        this.release();
        break;
    }
  }

  private release(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Run이 끝나면 구독을 닫는다. 남겨두면 프로세스가 종료되지 않는다. */
  close(): void {
    this.lines?.close();
    this.lines = null;
    this.release();
  }

  get stopped(): boolean {
    return this.stopRequested;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * 일시정지 중이면 재개·중단될 때까지 기다린다.
   *
   * 액션 하나를 실행하기 **전에** 부른다. 진행 중인 액션을 중간에 끊으면
   * 대상 시스템이 어중간한 상태로 남을 수 있다.
   */
  async waitIfPaused(): Promise<void> {
    while (this.paused && !this.stopRequested) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

/** 제어 채널이 없는 경우(테스트 등)를 위한 기본값. */
export const NO_CONTROL = new RunControl();
