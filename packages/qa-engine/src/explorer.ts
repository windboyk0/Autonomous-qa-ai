import type { Page } from "playwright";
import type {
  ActionOutcome,
  ActionResult,
  DiscoveredAction,
  PageState,
  RunConfig,
  StateGraph,
  IssueCandidate,
} from "@qa/shared";
import { emit, log } from "./emitter.js";
import { captureScreen } from "./capture.js";
import type { Collector } from "./collector.js";
import type { RunContext } from "./run-context.js";
import { discoverActions } from "./discover.js";
import { detectConsole, detectNetwork, detectVisual } from "./detect.js";
import { MIN_CONFIDENCE, hitsDenylist, riskAtMost } from "./classify.js";
import { readState } from "./fingerprint.js";
import { pathTemplate, queryKeys, sha1 } from "./normalize.js";
import { hasLoginForm, login } from "./login.js";
import { NO_CONTROL, type RunControl } from "./control.js";
import { impactScore } from "./source/change-impact.js";

/**
 * Explorer Agent.
 *
 * PAGE → ACTION DISCOVERY → RISK CLASSIFICATION → EXECUTION → STATE CHANGE DETECTION → NEW STATE
 *
 * 단순 링크 크롤러가 아니다. 모달·탭처럼 URL이 바뀌지 않는 화면도 상태로 잡아야 한다.
 */

/**
 * 큐 항목은 "이 화면에 도달하는 방법"이다.
 *
 * URL만으로 갈 수 있는 화면이 대부분이지만, 모달처럼 URL이 없는 화면은
 * `url`로 이동한 뒤 `replay`의 클릭을 순서대로 재생해야 도달한다.
 */
interface Plan {
  url: string;
  replay: Array<{ selector: string; label: string }>;
  depth: number;
  viaActionId: string | null;
}

/**
 * 계획 지문. 같은 화면으로 가는 계획을 여러 번 큐에 넣지 않기 위한 것.
 *
 * **id 세그먼트를 접어서 비교한다.** 목록의 사용자 47명 링크가 전부 큐에 들어가면
 * 46번은 방문 후 SKIPPED_VISITED로 버려진다 — 예산만 태우고 얻는 게 없다.
 * 여기서 미리 접으면 `/users/:id` 하나만 큐에 남는다.
 */
function planSignature(plan: Plan): string {
  const u = new URL(plan.url);
  return sha1(
    JSON.stringify([
      pathTemplate(u.pathname),
      queryKeys(u.search),
      plan.replay.map((r) => r.selector),
    ]),
  );
}

/**
 * 프로그램 범위 한정 (CLAUDE.md 4부, Phase 19).
 *
 * `impactHints`와 다르다 — 힌트는 **순서만** 바꾸는 비파괴적 힌트고, 이것은 **범위 자체를
 * 제한한다.** 그래서 같은 필드에 얹지 않고 별도 파라미터로 분리했다.
 */
export interface AllowedScope {
  /** 탐색 큐를 이 시드들로만 초기화한다. */
  seedUrls: readonly string[];
  /** 이 밖으로 이어지는 링크는(같은 화면 안의 액션은 예외) 더 이상 확장하지 않는다. */
  allowedPathTemplates: ReadonlySet<string>;
}

export interface ExploreResult {
  graph: StateGraph;
  actionResults: ActionResult[];
  /** 예산 소진·차단 등으로 보지 못한 영역. 리포트의 "탐색 제한"에 그대로 들어간다. */
  limits: string[];
  /** 룰 검출기가 화면마다 만들어낸 후보. Issue Judge가 여기서 최종 Issue를 만든다. */
  candidates: IssueCandidate[];
}

export class Explorer {
  private readonly visitedStates = new Map<string, PageState>();
  private readonly edges: StateGraph["edges"] = [];
  private readonly results: ActionResult[] = [];
  private readonly queue: Plan[] = [];
  private readonly enqueued = new Set<string>();
  private readonly limits: string[] = [];
  private readonly candidates: IssueCandidate[] = [];

  private actionsExecuted = 0;
  private readonly startedAt = Date.now();

  constructor(
    private readonly page: Page,
    private readonly ctx: RunContext,
    private readonly collector: Collector,
    private readonly config: RunConfig,
    private readonly control: RunControl = NO_CONTROL,
    /**
     * 이번 변경이 닿아 보이는 화면을 먼저 보게 하는 힌트.
     *
     * **대상을 줄이지 않고 순서만 바꾼다.** 추정이 틀려도 잃는 것은 순서뿐이고,
     * 예산이 남는 한 나머지 화면도 전부 본다. 줄이면 못 본 것이 생기는데
     * 그 사실이 리포트에 "정상"으로 읽힌다.
     */
    private readonly impactHints: readonly string[] = [],
    /**
     * 화면 범위 자체를 제한한다. 없으면(`null`) 기존 동작과 완전히 동일하다 — 회귀 없음
     * (CLAUDE.md 4부 §2.5 "programScope.enabled === false 면 기존 동작과 완전 동일").
     */
    private readonly allowedScope: AllowedScope | null = null,
  ) {}

  private get allowedOrigins(): string[] {
    const configured = this.config.safety.allowedOrigins;
    return configured.length > 0 ? configured : [new URL(this.config.targetUrl).origin];
  }

  private sameSite(url: string): boolean {
    try {
      return this.allowedOrigins.includes(new URL(url).origin);
    } catch {
      return false;
    }
  }

  /** 두 URL이 다른 경로(pathTemplate)를 가리키는가. 쿼리·모달 상태는 같은 경로로 본다. */
  private isDifferentRoute(a: string, b: string): boolean {
    try {
      return pathTemplate(new URL(a).pathname) !== pathTemplate(new URL(b).pathname);
    } catch {
      return false;
    }
  }

  /** href가 programScope로 매핑된 화면 중 하나로 이어지는가. */
  private inAllowedScope(href: string): boolean {
    if (!this.allowedScope) return true;
    try {
      const template = pathTemplate(new URL(href).pathname);
      return this.allowedScope.allowedPathTemplates.has(template);
    } catch {
      return false;
    }
  }

  /** 예산이 남아 있는가. 소진된 항목이 있으면 사유를 돌려준다. */
  private budgetExhausted(): string | null {
    const b = this.config.budget;
    if (this.visitedStates.size >= b.maxScreens) return `최대 화면 수(${b.maxScreens}) 소진`;
    if (this.actionsExecuted >= b.maxActions) return `최대 액션 수(${b.maxActions}) 소진`;
    if (Date.now() - this.startedAt >= b.maxDurationMs)
      return `최대 실행 시간(${Math.round(b.maxDurationMs / 1000)}초) 소진`;
    return null;
  }

  private enqueue(plan: Plan): boolean {
    if (plan.depth > this.config.budget.maxDepth) return false;
    const sig = planSignature(plan);
    if (this.enqueued.has(sig)) return false;
    this.enqueued.add(sig);
    this.queue.push(plan);
    return true;
  }

  private record(
    action: DiscoveredAction,
    outcome: ActionOutcome,
    reason: string,
    extra: Partial<ActionResult> = {},
  ): void {
    this.results.push({
      action,
      outcome,
      reason,
      fromStateKey: action.stateKey,
      toStateKey: null,
      stateChanged: false,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      evidenceIds: [],
      error: null,
      ...extra,
    });
  }

  /** 세션이 끊겼으면 재로그인해 원래 자리로 돌아온다. */
  private async ensureSession(): Promise<boolean> {
    if (!this.config.login.enabled) return true;
    if (!(await hasLoginForm(this.page))) return true;

    if (!this.config.safety.reloginOnSessionLoss) {
      this.limits.push("세션이 끊겼고 재로그인이 꺼져 있어 탐색을 중단했습니다.");
      return false;
    }

    log("warn", "세션이 끊겼습니다. 재로그인합니다.");
    const result = await login(this.page, this.config.login, this.config.targetUrl);
    if (!result.success) {
      this.limits.push(`재로그인 실패로 탐색을 중단했습니다: ${result.reason}`);
      return false;
    }
    return true;
  }

  /** 계획대로 화면에 도달한다. 실패하면 null. */
  private async navigateTo(plan: Plan): Promise<string | null> {
    try {
      await this.page.goto(plan.url, { waitUntil: "domcontentloaded" });
    } catch (err) {
      return `이동 실패: ${String(err)}`;
    }

    if (!(await this.ensureSession())) return "세션 복구 실패";

    for (const step of plan.replay) {
      try {
        await this.page.locator(step.selector).first().click({ timeout: 5000 });
        await this.page.waitForTimeout(this.config.budget.settleMs);
      } catch (err) {
        return `재생 실패 (${step.label}): ${String(err)}`;
      }
    }
    return null;
  }

  /**
   * 액션 1건을 실행하고 상태 변화를 관찰한다.
   * 실행하지 않기로 한 것도 반드시 사유와 함께 기록한다 — 그게 "미검증 영역"의 근거다.
   */
  private async runAction(action: DiscoveredAction, plan: Plan, from: PageState): Promise<void> {
    // ── 게이트 1: denylist (분류를 신뢰하지 않고 다시 본다) ──────────────
    const denied = hitsDenylist(action.label, null, this.config.safety);
    if (denied) {
      this.record(action, "SKIPPED_DENYLIST", `차단 패턴 /${denied}/ 에 걸림`);
      return;
    }

    // ── 게이트 2: 위험도 ────────────────────────────────────────────────
    if (!riskAtMost(action.risk, this.config.safety.maxAutoRisk)) {
      this.record(
        action,
        "SKIPPED_RISK",
        `${action.risk} > 허용 최대 ${this.config.safety.maxAutoRisk} · ${action.riskReason}`,
      );
      return;
    }

    // ── 게이트 3: 신뢰도 ────────────────────────────────────────────────
    if (action.confidence < MIN_CONFIDENCE) {
      this.record(
        action,
        "SKIPPED_LOW_CONFIDENCE",
        `분류 신뢰도 ${action.confidence} < ${MIN_CONFIDENCE} · ${action.riskReason}`,
      );
      return;
    }

    // ── 링크는 실행하지 않고 계획만 만든다 ───────────────────────────────
    // 클릭해서 이동하나 URL로 가나 결과는 같은데, 계획으로 두면 큐가 단순해지고
    // 재방문이 결정적으로 재현된다.
    if (action.type === "NAVIGATE" && action.selectorStrategy === "css" && action.selector.startsWith("a[href")) {
      const href = await this.hrefOf(action.selector);
      if (href && !this.sameSite(href)) {
        this.record(action, "SKIPPED_DENYLIST", `허용되지 않은 origin: ${new URL(href).origin}`);
        return;
      }
      if (href && this.allowedScope && !this.inAllowedScope(href)) {
        this.record(
          action,
          "SKIPPED_SCOPE",
          "programScope 범위 밖: 매핑되지 않은 화면으로 이어지는 링크라 확장하지 않습니다.",
        );
        return;
      }
      if (href) {
        const queued = this.enqueue({
          url: href,
          replay: [],
          depth: plan.depth + 1,
          viaActionId: action.id,
        });
        this.record(action, "EXECUTED", queued ? "링크 대상 큐 등록" : "이미 큐에 있는 대상");
        return;
      }
    }

    // ── 실제로 클릭한다 ─────────────────────────────────────────────────
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let error: string | null = null;

    try {
      await this.page.locator(action.selector).first().click({ timeout: 5000 });
      await this.page.waitForTimeout(this.config.budget.settleMs);
    } catch (err) {
      error = String(err);
    }
    this.actionsExecuted += 1;

    if (error) {
      this.record(action, "FAILED", "클릭 실패", {
        startedAt,
        durationMs: Date.now() - t0,
        error,
      });
      await this.restore(plan);
      return;
    }

    if (!this.sameSite(this.page.url())) {
      this.record(action, "EXECUTED", `외부 도메인으로 이탈해 되돌립니다: ${this.page.url()}`, {
        startedAt,
        durationMs: Date.now() - t0,
      });
      this.limits.push(`외부 링크로 이탈: ${action.label}`);
      await this.restore(plan);
      return;
    }

    const after = await readState(this.page, from.depth + 1, action.id);
    const changed = after.stateKey !== from.stateKey;

    this.record(action, "EXECUTED", changed ? "새 상태로 이동" : "상태 변화 없음", {
      startedAt,
      durationMs: Date.now() - t0,
      toStateKey: after.stateKey,
      stateChanged: changed,
    });

    if (changed && !this.visitedStates.has(after.stateKey)) {
      /*
       * 여기로 오는 액션 중 일부는 모달·탭(같은 경로, URL 안 바뀜)이 아니라
       * data-testid가 달린 `<a>` 태그다 — `actionTypeOf`는 태그만 보고 NAVIGATE로
       * 분류하지만, testid 셀렉터는 위 "링크는 계획만 만든다" 빠른 경로의
       * `a[href` css 조건에 걸리지 않아 실제로 클릭된다. 경로 자체가 바뀌었다면
       * 이것도 "새로운 다른 화면으로 이어지는 링크"이므로 같은 범위 게이트를 적용한다.
       * 경로가 같으면(모달·탭) 범위와 무관하게 항상 허용한다.
       */
      const newRoute = this.isDifferentRoute(plan.url, after.url);
      if (newRoute && this.allowedScope && !this.inAllowedScope(after.url)) {
        this.limits.push(
          `programScope 범위 밖: "${action.label}" 클릭이 매핑되지 않은 화면(${after.url})으로 이동해 더 탐색하지 않습니다.`,
        );
      } else {
        // 클릭으로만 도달하는 화면(모달·탭)이다. 재생 계획으로 큐에 넣는다.
        this.enqueue({
          url: plan.url,
          replay: [...plan.replay, { selector: action.selector, label: action.label }],
          depth: plan.depth + 1,
          viaActionId: action.id,
        });
      }
    }

    // 다음 액션은 원래 화면에서 이어가야 한다.
    await this.restore(plan);
  }

  private async hrefOf(selector: string): Promise<string | null> {
    try {
      const raw = await this.page.locator(selector).first().getAttribute("href");
      return raw ? new URL(raw, this.page.url()).toString() : null;
    } catch {
      return null;
    }
  }

  /** 액션 실행 후 원래 화면으로 되돌린다. */
  private async restore(plan: Plan): Promise<void> {
    await this.navigateTo(plan);
  }

  /**
   * 다음에 볼 화면을 꺼낸다.
   *
   * 힌트가 없으면 넣은 순서 그대로다(기존 동작, 결정성 유지).
   * 힌트가 있으면 점수가 가장 높은 것을 먼저 꺼내되, 점수가 같으면
   * 역시 넣은 순서를 지킨다 — 여기서 순서가 흔들리면 회귀 테스트가 불가능해진다.
   */
  private takeNextPlan(): Plan {
    if (this.impactHints.length === 0) return this.queue.shift()!;

    let bestAt = 0;
    let best = impactScore(this.queue[0]!.url, this.impactHints);
    for (let i = 1; i < this.queue.length; i += 1) {
      const score = impactScore(this.queue[i]!.url, this.impactHints);
      if (score > best) {
        best = score;
        bestAt = i;
      }
    }
    return this.queue.splice(bestAt, 1)[0]!;
  }

  async explore(startPlan: Plan): Promise<ExploreResult> {
    /*
     * 범위가 한정되어 있으면 큐를 그 시드들로만 초기화한다 — 진입 화면(startPlan)은
     * 매핑된 화면이 아니면 포함하지 않는다. "그 화면들만 본다"가 이 기능의 전부다.
     */
    if (this.allowedScope) {
      for (const url of this.allowedScope.seedUrls) {
        this.enqueue({ url, replay: [], depth: 0, viaActionId: null });
      }
      if (this.queue.length === 0) {
        this.limits.push("programScope: 매핑된 화면이 없어 탐색할 대상이 없습니다.");
      }
    } else {
      this.enqueue(startPlan);
    }

    while (this.queue.length > 0) {
      // 일시정지는 화면 하나를 다 보고 나서 걸린다.
      await this.control.waitIfPaused();
      if (this.control.stopped) {
        this.limits.push(`사용자 중단. 큐에 남은 화면 ${this.queue.length}개를 보지 못했습니다.`);
        break;
      }

      const exhausted = this.budgetExhausted();
      if (exhausted) {
        this.limits.push(`${exhausted}. 큐에 남은 화면 ${this.queue.length}개를 보지 못했습니다.`);
        log("warn", `예산 소진: ${exhausted}`);
        break;
      }

      const plan = this.takeNextPlan();
      const navError = await this.navigateTo(plan);
      if (navError) {
        this.limits.push(`${plan.url} 도달 실패: ${navError}`);
        log("warn", `${plan.url} 도달 실패: ${navError}`);
        continue;
      }

      const state = await readState(this.page, plan.depth, plan.viaActionId);

      if (this.visitedStates.has(state.stateKey)) {
        continue; // 같은 상태를 다시 탐색하지 않는다
      }
      this.visitedStates.set(state.stateKey, state);

      if (plan.viaActionId) {
        const from = this.results.find((r) => r.action.id === plan.viaActionId);
        if (from) {
          this.edges.push({
            fromStateKey: from.fromStateKey,
            toStateKey: state.stateKey,
            actionId: plan.viaActionId,
            actionLabel: from.action.label,
          });
        }
      }

      const capture = await captureScreen(this.page, this.ctx, this.collector, {
        stateKey: state.stateKey,
        screenName: state.screenName,
      });
      const shot = capture.evidences.find((e) => e.kind === "screenshot");

      // ── 룰 기반 검출 ────────────────────────────────────────────────
      const screenCtx = {
        stateKey: state.stateKey,
        screenName: state.screenName,
        url: state.url,
        evidenceIdByKind: capture.evidenceIdByKind as Partial<Record<string, string>>,
      };
      const found = [
        ...detectNetwork(capture.network, screenCtx),
        ...detectConsole(capture.console, screenCtx),
        ...detectVisual(capture.visual, capture.loadingStuck, screenCtx),
      ];
      this.candidates.push(...found);
      for (const c of found) {
        log("info", `[${c.ruleId}] ${c.screenName}: ${c.title}`);
      }

      emit({
        type: "state:visited",
        at: new Date().toISOString(),
        state,
        screenshotPath: shot?.path ?? null,
      });

      const actions = await discoverActions(
        this.page,
        { stateKey: state.stateKey, screenName: state.screenName },
        this.config.safety,
      );
      this.ctx.writeJson("actions", `${state.stateKey.slice(0, 12)}-actions.json`, actions);

      for (const action of actions) {
        if (this.budgetExhausted()) break;
        // 액션 하나를 실행하기 **전에** 확인한다. 진행 중인 액션을 중간에 끊으면
        // 대상 시스템이 어중간한 상태로 남을 수 있다.
        await this.control.waitIfPaused();
        if (this.control.stopped) break;
        await this.runAction(action, plan, state);
      }

      emit({
        type: "run:progress",
        at: new Date().toISOString(),
        screensExplored: this.visitedStates.size,
        screensQueued: this.queue.length,
        actionsExecuted: this.actionsExecuted,
        currentTask: "자율 탐색",
        currentScreen: state.screenName,
      });
    }

    const graph: StateGraph = { nodes: [...this.visitedStates.values()], edges: this.edges };
    this.ctx.writeJson("actions", "results.json", this.results);

    this.ctx.writeJson("actions", "candidates.json", this.candidates);

    return {
      graph,
      actionResults: this.results,
      limits: this.limits,
      candidates: this.candidates,
    };
  }
}

export function makeStartPlan(url: string): Plan {
  return { url, replay: [], depth: 0, viaActionId: null };
}
