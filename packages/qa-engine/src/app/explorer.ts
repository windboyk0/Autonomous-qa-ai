import type { RunConfig } from "@qa/shared";
import { riskAtMost, MIN_CONFIDENCE } from "../classify.js";
import { classifyAppElement } from "./classify-app.js";
import { emit, log } from "../emitter.js";
import type { RunControl } from "../control.js";
import { NO_CONTROL } from "../control.js";
import type { RunContext } from "../run-context.js";
import { RunContext as _RunContext } from "../run-context.js";
import type { AppDriver } from "./driver.js";
import type { AppElement, AppScreen } from "./observe.js";

/**
 * 앱 자율 탐색.
 *
 * 웹 `Explorer` 의 형제다. 원리는 같지만 **이동 방식이 근본적으로 다르다.**
 *
 * 웹은 아무 화면이나 URL 로 바로 갈 수 있어서 큐에 계획을 쌓아 두고 꺼내 쓴다.
 * 앱에는 주소가 없다. 어떤 화면에 가려면 **앱을 다시 띄우고 그 경로를 다시 눌러야** 한다.
 * 그래서 깊이 우선으로 들어갔다가 `back` 으로 되돌아 나오고, 되돌아 나오지 못하면
 * 앱을 다시 띄워 경로를 재생한다.
 */

export interface AppActionResult {
  /** 누른 요소의 라벨 */
  label: string;
  fromStateKey: string;
  toStateKey: string | null;
  outcome: "EXECUTED" | "SKIPPED_RISK" | "SKIPPED_DENYLIST" | "SKIPPED_LOW_CONFIDENCE" | "SKIPPED_VISITED" | "FAILED";
  reason: string;
  /** 화면이 실제로 바뀌었는가. 안 바뀌면 죽은 버튼일 수 있다. */
  stateChanged: boolean;
  /** 조작부터 화면 안정까지 걸린 시간 */
  durationMs: number;
  screenName: string;
  /** 이 조작 직후에 관측된 이상 */
  errors: string[];
}

export interface AppVisitedScreen {
  stateKey: string;
  screenName: string;
  depth: number;
  screenshotPath: string | null;
  /** 화면에 그대로 노출된 예외 문자열 */
  screenErrors: string[];
  elementCount: number;
}

export interface AppExploreResult {
  screens: AppVisitedScreen[];
  actions: AppActionResult[];
  /** 예산·이탈 등으로 못 본 것. 조용히 끝내지 않는다. */
  limits: string[];
  steps: number;
}

export class AppExplorer {
  private readonly screens: AppVisitedScreen[] = [];
  private readonly actions: AppActionResult[] = [];
  private readonly limits: string[] = [];
  private readonly visited = new Set<string>();
  /** 화면마다 이미 눌러 본 라벨. 같은 화면에서 같은 것을 두 번 누르지 않는다. */
  private readonly tried = new Map<string, Set<string>>();
  /** 되돌릴 수 없어 미룬 것들. tryRiskyLast 가 켜져 있으면 맨 끝에 한 번씩 본다. */
  private readonly deferred: Array<{ path: string[]; label: string; screenName: string }> = [];
  private steps = 0;
  private readonly startedAt = Date.now();

  constructor(
    private readonly driver: AppDriver,
    private readonly ctx: RunContext,
    private readonly config: RunConfig,
    private readonly control: RunControl = NO_CONTROL,
  ) {}

  private get budget() {
    return this.config.app;
  }

  private exhausted(): string | null {
    if (this.steps >= this.budget.maxSteps) return `최대 스텝(${this.budget.maxSteps}) 소진`;
    if (this.visited.size >= this.budget.maxScreens)
      return `최대 화면 수(${this.budget.maxScreens}) 소진`;
    if (Date.now() - this.startedAt >= this.budget.maxDurationMs)
      return `최대 실행 시간(${Math.round(this.budget.maxDurationMs / 1000)}초) 소진`;
    return null;
  }

  /** 현재 화면을 관찰하고 증적을 남긴다. */
  private look(depth: number): AppScreen | null {
    const screen = this.driver.observe();
    if (!screen) return null;

    if (!this.visited.has(screen.stateKey)) {
      this.visited.add(screen.stateKey);

      const seq = this.ctx.nextSeq();
      const file = `${seq}-${_RunContext.slug(screen.screenName)}.png`;
      const shotPath = `screenshots/${file}`;
      const ok = this.driver.screenshot(`${this.ctx.runDir}/${shotPath}`);

      this.ctx.addEvidence({
        kind: "screenshot",
        stateKey: screen.stateKey,
        screenName: screen.screenName,
        path: ok ? shotPath : null,
        summary: `요소 ${screen.elements.length}개${screen.screenErrors.length > 0 ? ` · 화면 예외 ${screen.screenErrors.length}건` : ""}`,
      });

      /*
       * 원본 덤프도 남긴다. 웹이 DOM 을 남기는 것과 같은 이유다.
       *
       * 스크린샷은 **무엇이 보였는지**만 알려준다. 왜 그 화면을 그 이름으로
       * 불렀는지, 왜 그 요소를 못 찾았는지는 덤프를 봐야 안다. 기기가 끊기면
       * 다시 뜰 때까지 아무것도 확인할 수 없다 — 실측에서 두 번 막혔다.
       */
      try {
        const dumpPath = this.ctx.writeText("dom", `${seq}-${_RunContext.slug(screen.screenName)}.xml`, screen.xml);
        this.ctx.addEvidence({
          kind: "dom",
          stateKey: screen.stateKey,
          screenName: screen.screenName,
          path: dumpPath,
          summary: `UI 덤프 ${screen.xml.length.toLocaleString()}자 · 노드 ${(screen.xml.match(/<node\b/g) ?? []).length}개`,
        });
      } catch (err) {
        // 증적을 못 남기는 것으로 탐색을 멈추지는 않는다.
        log("warn", `UI 덤프 저장 실패 (${screen.screenName}): ${String(err)}`);
      }

      this.screens.push({
        stateKey: screen.stateKey,
        screenName: screen.screenName,
        depth,
        screenshotPath: ok ? shotPath : null,
        screenErrors: screen.screenErrors,
        elementCount: screen.elements.length,
      });

      emit({
        type: "run:progress",
        at: new Date().toISOString(),
        screensExplored: this.screens.length,
        screensQueued: 0,
        actionsExecuted: this.actions.filter((a) => a.outcome === "EXECUTED").length,
        currentTask: "앱 자율 탐색",
        currentScreen: screen.screenName,
      });
    }
    return screen;
  }

  /**
   * 앱을 다시 띄우고 경로를 재생한다.
   *
   * 앱 밖으로 나갔거나 `back` 이 엉뚱한 곳으로 갔을 때 쓴다.
   * 재생에 실패하면 그 사실을 기록한다 — 조용히 다른 화면을 훑으면
   * 리포트의 "탐색한 화면"이 거짓이 된다.
   */
  private replay(path: readonly string[]): AppScreen | null {
    this.driver.launch();
    let screen = this.look(0);

    for (const label of path) {
      if (!screen) return null;
      const target = screen.elements.find((e) => e.label === label);
      if (!target) {
        this.limits.push(`경로 재생 실패: "${label}" 을 다시 찾지 못했습니다.`);
        return screen;
      }
      this.driver.tap(target.x, target.y);
      this.driver.settle();
      screen = this.look(path.indexOf(label) + 1);
    }
    return screen;
  }

  /** 되돌릴 수 없어 미뤄 둔 것을 맨 마지막에 한 번씩만 시도한다. */
  private runDeferred(): void {
    if (!this.budget.tryRiskyLast || this.deferred.length === 0) return;

    log("warn", `되돌릴 수 없는 동작 ${this.deferred.length}건을 마지막에 시도합니다 (동의함).`);
    for (const item of this.deferred) {
      if (this.control.stopped || this.exhausted()) break;

      const screen = this.replay(item.path);
      const target = screen?.elements.find((e) => e.label === item.label);
      if (!screen || !target) {
        this.limits.push(`"${item.label}" 을 다시 찾지 못해 시도하지 못했습니다.`);
        continue;
      }
      log("warn", `동의한 위험 동작 실행: "${item.label}" (${item.screenName})`);
      this.act(screen, target, item.path.length);
    }
  }

  /** 요소 하나를 눌러 보고 결과를 기록한다. */
  private act(from: AppScreen, element: AppElement, depth: number): AppScreen | null {
    this.steps += 1;
    const startedAt = Date.now();

    this.driver.tap(element.x, element.y);
    this.driver.settle();

    // 앱 밖으로 나갔으면 되돌린다. 밖을 훑으면 남의 앱을 QA 하는 셈이다.
    if (!this.driver.inApp()) {
      this.actions.push({
        label: element.label,
        fromStateKey: from.stateKey,
        toStateKey: null,
        outcome: "EXECUTED",
        reason: "앱 밖으로 이탈했습니다. 다시 띄웁니다.",
        stateChanged: true,
        durationMs: Date.now() - startedAt,
        screenName: from.screenName,
        errors: this.driver.freshLogErrors(),
      });
      return null;
    }

    const after = this.look(depth + 1);
    const errors = [...this.driver.freshLogErrors(), ...(after?.screenErrors ?? [])];
    const changed = after !== null && after.stateKey !== from.stateKey;

    this.actions.push({
      label: element.label,
      fromStateKey: from.stateKey,
      toStateKey: after?.stateKey ?? null,
      outcome: after === null ? "FAILED" : "EXECUTED",
      reason:
        after === null
          ? "조작 후 화면을 읽지 못했습니다."
          : changed
            ? "화면이 바뀌었습니다."
            : "화면이 바뀌지 않았습니다.",
      stateChanged: changed,
      durationMs: Date.now() - startedAt,
      screenName: from.screenName,
      errors,
    });

    return after;
  }

  /** 실행하지 않기로 한 것을 사유와 함께 남긴다. */
  private skip(
    from: AppScreen,
    element: AppElement,
    outcome: AppActionResult["outcome"],
    reason: string,
  ): void {
    this.actions.push({
      label: element.label,
      fromStateKey: from.stateKey,
      toStateKey: null,
      outcome,
      reason,
      stateChanged: false,
      durationMs: 0,
      screenName: from.screenName,
      errors: [],
    });
  }

  /**
   * 한 화면을 훑는다.
   *
   * 깊이 우선이다. 들어갔다가 `back` 으로 나오고, 나오지 못하면 경로를 재생한다.
   */
  private walk(screen: AppScreen, path: string[], depth: number): void {
    if (this.control.stopped) return;

    const tried = this.tried.get(screen.stateKey) ?? new Set<string>();
    this.tried.set(screen.stateKey, tried);

    let current: AppScreen | null = screen;
    let scrolled = false;

    for (;;) {
      if (this.control.stopped) return;
      const done = this.exhausted();
      if (done) {
        if (!this.limits.some((l) => l.startsWith(done))) {
          this.limits.push(`${done}. 남은 화면을 보지 못했습니다.`);
          log("warn", `예산 소진: ${done}`);
        }
        return;
      }
      if (!current) return;

      const next = current.elements.find((e) => !tried.has(e.label) && e.enabled);
      if (!next) {
        /*
         * 화면에 더 볼 것이 없다. 스크롤이 되는 화면이면 한 번 내려 숨은 요소를 찾는다.
         * 웹의 "보이는 요소만 지문에 넣는다"와 같은 이유로, 안 보이는 것은 애초에 없다.
         */
        if (current.scrollable && !scrolled) {
          scrolled = true;
          this.driver.scrollDown();
          this.driver.settle();
          current = this.driver.observe();
          continue;
        }
        return;
      }

      tried.add(next.label);

      const verdict = classifyAppElement(next, this.config.safety, this.budget.riskyLabels);

      if (verdict.risk === "DANGEROUS" && verdict.confidence >= 0.99) {
        this.skip(current, next, "SKIPPED_DENYLIST", verdict.reason);
        continue;
      }
      if (!riskAtMost(verdict.risk, this.config.safety.maxAutoRisk)) {
        /*
         * 되돌릴 수 없는 동작이다. 동의했으면 **맨 마지막에** 한 번 본다 —
         * 탐색 도중에 로그아웃이나 출근 기록이 남으면 나머지 탐색이 통째로 무의미해진다.
         */
        this.deferred.push({ path: [...path], label: next.label, screenName: current.screenName });
        this.skip(
          current,
          next,
          "SKIPPED_RISK",
          `${verdict.risk} > 허용 최대 ${this.config.safety.maxAutoRisk} · ${verdict.reason}`,
        );
        continue;
      }
      if (verdict.confidence < MIN_CONFIDENCE) {
        this.deferred.push({ path: [...path], label: next.label, screenName: current.screenName });
        this.skip(current, next, "SKIPPED_LOW_CONFIDENCE", verdict.reason);
        continue;
      }

      const before: AppScreen = current;
      const after = this.act(current, next, depth);

      if (after === null) {
        // 이탈했거나 화면을 못 읽었다. 앱을 다시 띄우고 여기까지 돌아온다.
        current = this.replay(path);
        continue;
      }

      if (after.stateKey === before.stateKey) {
        // 화면이 그대로다. 같은 화면에서 다음 요소를 계속 본다.
        current = after;
        continue;
      }

      if (!this.visited.has(after.stateKey) || (this.tried.get(after.stateKey)?.size ?? 0) === 0) {
        this.walk(after, [...path, next.label], depth + 1);
      }

      // 돌아온다. back 이 원래 화면으로 데려다주지 못하면 경로를 재생한다.
      this.driver.back();
      this.driver.settle();
      const back = this.driver.observe();
      current = back?.stateKey === before.stateKey ? back : this.replay(path);
    }
  }

  explore(): AppExploreResult {
    this.driver.launch();
    const root = this.look(0);

    if (!root) {
      /*
       * 원인이 둘이고 안내가 완전히 다르다.
       * 기기가 끊긴 것을 "앱이 접근성 정보를 노출하지 않는다"고 하면
       * 사용자는 멀쩡한 앱을 뜯어보게 된다(실측).
       */
      const gone = !this.driver.isReachable();
      this.limits.push(
        gone
          ? "기기 연결이 끊겼습니다. 무선 디버깅은 화면이 꺼지면 끊어집니다 — " +
            "다시 연결한 뒤 시도하세요."
          : "화면을 읽지 못했습니다. 앱이 접근성 정보를 노출하지 않으면 요소를 찾을 수 없습니다.",
      );
      log("warn", gone ? "기기 연결이 끊겼습니다." : "UI 덤프를 읽지 못했습니다.");
      return { screens: this.screens, actions: this.actions, limits: this.limits, steps: this.steps };
    }

    if (root.elements.length === 0) {
      this.limits.push(
        "첫 화면에서 클릭 가능한 요소를 찾지 못했습니다. " +
          "Flutter 앱이라면 Semantics 가 노출되는지 확인하세요.",
      );
      log("warn", "클릭 가능한 요소가 없습니다.");
    }

    this.walk(root, [], 0);
    this.runDeferred();

    log(
      "info",
      `앱 탐색 완료: 화면 ${this.screens.length}개 · 스텝 ${this.steps} · ` +
        `실행 ${this.actions.filter((a) => a.outcome === "EXECUTED").length}건 · ` +
        `미실행 ${this.actions.filter((a) => a.outcome !== "EXECUTED").length}건`,
    );
    for (const limit of this.limits) log("warn", `탐색 제한: ${limit}`);

    return { screens: this.screens, actions: this.actions, limits: this.limits, steps: this.steps };
  }
}
