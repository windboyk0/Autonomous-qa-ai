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
      // 클릭으로만 도달하는 화면(모달·탭)이다. 재생 계획으로 큐에 넣는다.
      this.enqueue({
        url: plan.url,
        replay: [...plan.replay, { selector: action.selector, label: action.label }],
        depth: plan.depth + 1,
        viaActionId: action.id,
      });
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

  async explore(startPlan: Plan): Promise<ExploreResult> {
    this.enqueue(startPlan);

    while (this.queue.length > 0) {
      const exhausted = this.budgetExhausted();
      if (exhausted) {
        this.limits.push(`${exhausted}. 큐에 남은 화면 ${this.queue.length}개를 보지 못했습니다.`);
        log("warn", `예산 소진: ${exhausted}`);
        break;
      }

      const plan = this.queue.shift()!;
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
