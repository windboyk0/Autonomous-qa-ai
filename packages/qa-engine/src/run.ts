import {
  redactRunConfig,
  type ActionResult,
  type CrudResult,
  type Evidence,
  type AiProvider,
  type AiProviderConfig,
  type Issue,
  type IssuesFile,
  type ProviderStatus,
  type RunConfig,
  type RunStatus,
  type RunSummary,
} from "@qa/shared";
import { emit, log } from "./emitter.js";
import { launch, preflightBrowser } from "./browser.js";
import { Collector } from "./collector.js";
import { captureScreen } from "./capture.js";
import { login } from "./login.js";
import type { RunContext } from "./run-context.js";
import { Explorer, makeStartPlan, type ExploreResult } from "./explorer.js";
import { judge } from "./judge.js";
import { runSourceQa, type SourceQaOutcome } from "./source/run-source.js";
import { computeImpact, gitChangedFiles, type ChangeImpact } from "./source/change-impact.js";
import { attachCodeRefs, buildApiIndex } from "./source/api-map.js";
import { scanProject } from "./source/scan.js";
import { renderReport } from "./report.js";
import { AiGuard, createProvider, enrich, passthrough, type EnrichResult } from "./ai/index.js";
import { NO_CONTROL, type RunControl } from "./control.js";
import { CrudTester } from "./crud.js";

export interface RunOutcome {
  status: RunStatus;
  message: string;
}

export interface RunOptions {
  /**
   * Provider 주입 지점.
   *
   * 없으면 `config.ai.kind`로 만든다. 테스트가 실패하는 Provider를 꽂아
   * "AI가 죽어도 리포트는 나온다"를 검증하는 데 쓰고, Phase 5의 Electron이
   * 자기 Provider를 넘길 수도 있다.
   */
  createProvider?: (config: AiProviderConfig) => AiProvider;
  /** 실행 제어 채널. 없으면 제어 없이 끝까지 돈다. */
  control?: RunControl;
}

/**
 * 미검증 영역을 액션 기록에서 뽑아낸다.
 *
 * 차단은 성공이지만 **숨기면 실패다.** 실행하지 않은 것을 리포트에 적지 않으면
 * 사용자는 전부 검증했다고 착각한다. 이 도구의 가장 위험한 실패 모드다.
 */
function unverifiedAreas(results: ActionResult[], config: RunConfig): string[] {
  const grouped = new Map<string, { screens: Set<string>; reason: string; count: number }>();
  for (const r of results) {
    if (r.outcome === "EXECUTED") continue;
    const key = `${r.action.label}|${r.outcome}`;
    const entry = grouped.get(key) ?? { screens: new Set<string>(), reason: r.reason, count: 0 };
    entry.screens.add(r.action.screenName);
    entry.count += 1;
    grouped.set(key, entry);
  }

  const out = [...grouped.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([key, v]) => {
      const label = key.split("|")[0];
      return `"${label}" — ${v.count}회 발견, 실행하지 않음 (${v.reason}). 화면: ${[...v.screens].join(", ")}`;
    });

  for (const kind of ["create", "update", "delete"] as const) {
    if (!config.crud[kind]) out.push(`${kind.toUpperCase()} 테스트 — 설정에서 꺼져 있어 실행하지 않았습니다.`);
    else if (kind === "delete" && !config.crud.deleteConsent)
      out.push("DELETE 테스트 — 별도 삭제 동의가 없어 실행하지 않았습니다.");
  }
  if (config.ai.kind === "none") {
    out.push("AI 분석 (원인 추정·화면 평가·기능 누락 후보) — Provider를 사용하지 않았습니다.");
  }

  return out;
}

/**
 * AI 보강을 시도한다. **어떤 실패도 위로 던지지 않는다.**
 *
 * Provider가 없거나, 헬스체크에서 떨어지거나, 호출이 전부 실패해도
 * 입력으로 받은 룰 기반 Issue를 그대로 돌려준다. 이것이 Phase 4의 존재 이유다.
 */
async function enrichWithAi(input: {
  config: RunConfig;
  issues: Issue[];
  explored: ExploreResult;
  evidences: readonly Evidence[];
  makeProvider: (config: AiProviderConfig) => AiProvider;
  /** 탐색 전에 이미 확인했으면 그 결과. 없으면 여기서 확인한다. */
  ready?: AiReady | null;
}): Promise<EnrichResult> {
  const { config, issues, explored, evidences } = input;
  if (config.ai.kind === "none") return passthrough(issues);

  // 탐색 전에 확인해 두었으면 다시 묻지 않는다. 같은 것을 두 번 물으면
  // 사용자가 로그에서 같은 줄을 두 번 본다.
  const ready = input.ready !== undefined ? input.ready : await preflightAi(config, input.makeProvider);
  if (!ready || !ready.ok) {
    return {
      ...passthrough(issues),
      status: "failed",
      failureReason: ready?.ok === false ? ready.reason : "AI Provider를 사용할 수 없습니다.",
    };
  }
  const { provider, status } = ready;

  const pages = explored.graph.nodes.map((n) => ({
    screenName: n.screenName,
    pathTemplate: n.signals.pathTemplate,
    visibleText: n.signals.heading,
    domOutline: n.signals.navLabels.join(", "),
  }));

  // 요약 프롬프트에 넣을 임시 summary. 최종 summary는 보강 결과로 다시 만든다.
  const draftSummary = buildSummary({
    runId: "draft",
    config,
    startedAt: new Date(),
    explored,
    issues,
    ai: null,
  });

  try {
    return await enrich({
      provider,
      config: config.ai,
      status,
      issues,
      summary: draftSummary,
      evidences,
      actionResults: explored.actionResults,
      pages,
    });
  } catch (err) {
    // enrich 내부는 전부 guard를 통과하지만, 만약을 대비해 한 겹 더 둔다.
    const reason = err instanceof Error ? err.message : String(err);
    log("error", `AI 보강이 예기치 않게 실패했습니다. 룰 결과로 진행합니다: ${reason}`);
    return { ...passthrough(issues), status: "failed", failureReason: reason };
  }
}

function buildSummary(input: {
  runId: string;
  config: RunConfig;
  startedAt: Date;
  explored: ExploreResult;
  issues: Issue[];
  ai: EnrichResult | null;
  crud?: CrudResult[];
  leftovers?: string[];
  stopped?: boolean;
  source?: SourceQaOutcome | null;
  impact?: ChangeImpact | null;
}): RunSummary {
  const { runId, config, startedAt, explored, issues } = input;
  const finishedAt = new Date();
  const count = (s: Issue["severity"]) => issues.filter((i) => i.severity === s).length;

  return {
    runId,
    // 중단으로 끝났으면 그렇게 기록한다. 부분 결과를 완주한 것처럼 보이게 하면 안 된다.
    status: input.stopped ? "STOPPED" : "COMPLETED",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    // 리포트로 나가는 설정은 반드시 마스킹된 판본이어야 한다.
    config: redactRunConfig(config),
    screensExplored: explored.graph.nodes.length,
    actionsExecuted: explored.actionResults.filter((r) => r.outcome === "EXECUTED").length,
    actionsSkipped: explored.actionResults.filter((r) => r.outcome !== "EXECUTED").length,
    issueCounts: {
      critical: count("CRITICAL"),
      high: count("HIGH"),
      medium: count("MEDIUM"),
      low: count("LOW"),
    },
    crud: input.crud ?? [],
    aiStatus: input.ai?.status ?? "not_used",
    aiFailureReason: input.ai?.failureReason ?? null,
    explorationLimits: explored.limits,
    changeImpact: input.impact
      ? {
          comparedWith: input.impact.changed.comparedWith,
          changedFiles: input.impact.changed.files,
          endpoints: input.impact.endpoints.map((e) => `${e.method} ${e.path}`),
          apiPaths: input.impact.apiPaths,
          notes: input.impact.notes,
        }
      : null,
    unverifiedAreas: [
      ...unverifiedAreas(explored.actionResults, config),
      // 소스 QA 가 하지 않은 것도 같은 자리에 적는다. 모드가 달라도 "안 본 것"은 하나다.
      ...(input.source?.unverified ?? []),
      // 정리하지 못한 테스트 데이터는 **식별자와 함께** 반드시 남긴다.
      // 사용자가 직접 지울 수 있어야 한다.
      ...(input.leftovers ?? []).map((l) => `정리되지 않은 테스트 데이터: ${l}`),
    ],
  };
}

/**
 * Run 본체.
 *
 * Preflight → Login → 자율 탐색 → (Phase 3) 검출·리포트.
 *
 * CLI에서 분리해 둔 이유는 통합 테스트가 프로세스를 띄우지 않고
 * 이 함수만 직접 호출할 수 있게 하기 위해서다.
 */
/**
 * AI Provider 를 **탐색 전에** 확인한다.
 *
 * 원래는 보강 단계에서야 확인했다. 그러면 두 가지가 나빴다.
 *   - 실행 Monitor 가 탐색 내내 "AI 사용 안 함" 으로 보인다. 실제로는 아직
 *     차례가 오지 않았을 뿐인데 사용자는 설정이 안 먹은 줄 안다(실측 신고).
 *   - Claude 가 없거나 로그인이 안 된 상태를 **4분짜리 탐색이 끝난 뒤에** 안다.
 *     그때는 이미 늦다.
 *
 * 여기서 확인하고 결과를 그대로 보강 단계로 넘긴다. 실패해도 던지지 않는다 —
 * AI 가 없어도 룰 QA 는 끝까지 간다는 원칙은 그대로다.
 */
type AiReady =
  | { ok: true; provider: AiProvider; status: ProviderStatus }
  /** 실패 사유는 **반드시** 들고 간다. 없으면 사용자는 왜 AI 가 안 붙었는지 모른다. */
  | { ok: false; reason: string };

async function preflightAi(
  config: RunConfig,
  makeProvider: (c: AiProviderConfig) => AiProvider,
): Promise<AiReady | null> {
  if (config.ai.kind === "none") {
    log("info", "AI Provider 를 사용하지 않습니다. 룰 기반으로만 진행합니다.");
    emit({
      type: "ai:status",
      at: new Date().toISOString(),
      available: false,
      detail: "사용 안 함 (룰 기반만)",
    });
    return null;
  }

  const provider = makeProvider(config.ai);
  const status = await new AiGuard(config.ai.timeoutMs)
    .run("healthCheck", () => provider.healthCheck())
    .catch(() => null);

  if (!status?.available) {
    const detail = status?.detail ?? "Provider 상태를 확인할 수 없습니다.";
    log("warn", `AI Provider를 사용할 수 없습니다: ${detail}`);
    if (status?.remediation) log("warn", `조치: ${status.remediation}`);
    emit({ type: "ai:status", at: new Date().toISOString(), available: false, detail });
    return {
      ok: false,
      reason: status?.remediation ? `${detail} (${status.remediation})` : detail,
    };
  }

  log("info", status.detail);
  emit({ type: "ai:status", at: new Date().toISOString(), available: true, detail: status.detail });
  return { ok: true, provider, status };
}

/**
 * 이번 변경이 닿는 영역을 계산한다.
 *
 * 스캔을 한 번 더 도는 비용이 있지만, 소스 QA 를 켜지 않은 실행 QA 에서도
 * 이 기능만 쓰고 싶을 수 있다. 그 경우가 오히려 흔하다.
 */
function computeChangeImpact(config: RunConfig): ChangeImpact | null {
  if (!config.source.changeImpact) return null;
  const rootDir = config.source.rootDir;
  if (rootDir.trim() === "") return null;

  const changed = gitChangedFiles(rootDir, config.source.changeBase);
  if (changed.error) log("warn", `변경 영향 분석 불가: ${changed.error}`);

  const scan = scanProject(rootDir, {
    maxFiles: config.source.maxFiles,
    maxFileBytes: config.source.maxFileBytes,
    maxTotalBytes: config.source.maxTotalBytes,
  });
  const impact = computeImpact(rootDir, scan, changed);

  log(
    "info",
    `변경 영향: 파일 ${changed.files.length}개(${changed.comparedWith || "비교 불가"}) → ` +
      `엔드포인트 ${impact.endpoints.length}개 · 힌트 ${impact.hints.length}개`,
  );
  return impact;
}

/**
 * 앱 전용 Run.
 *
 * 브라우저를 띄우지 않는다. 대상이 폰이므로 Chromium 이 있든 없든 상관없다.
 *
 * 앱 탐색 결과를 **웹과 같은 파이프라인**에 얹는다. 화면은 그래프 노드로,
 * 조작은 ActionResult 로 옮겨 담는다. 그래야 judge·리포트·Monitor 가
 * 모드를 몰라도 되고, 사용자도 리포트 읽는 법을 한 번만 배우면 된다.
 */
async function runAppOnly(
  config: RunConfig,
  ctx: RunContext,
  startedAt: Date,
  options: RunOptions,
): Promise<RunOutcome> {
  const { preflightApp } = await import("./app/preflight.js");
  const { Adb } = await import("./app/adb.js");
  const { AdbDriver } = await import("./app/driver.js");
  const { AppExplorer } = await import("./app/explorer.js");
  const { detectAppIssues, appUnverifiedAreas } = await import("./app/detect-app.js");

  /*
   * 기기부터 확인한다. 없는 기기로 15분짜리 탐색을 시작해 놓고 끝에 가서
   * 실패를 알리면 안 된다.
   */
  const pre = preflightApp({
    adbPath: config.app.adbPath,
    deviceSerial: config.app.deviceSerial,
    packageName: config.app.packageName,
  });
  if (!pre.ok) {
    const reason = pre.remediation ? `${pre.detail} ${pre.remediation}` : pre.detail;
    log("error", reason);
    return { status: "FAILED", message: pre.detail };
  }

  const aiReady = await preflightAi(config, options.createProvider ?? createProvider);

  const adb = new Adb(pre.adbPath!, pre.device!.serial);
  // 이전 실행의 로그가 이번 결함으로 잡히지 않게 비운다.
  adb.clearLogcat();

  const driver = new AdbDriver(adb, config.app.packageName, config.app.settleMs);
  const appResult = new AppExplorer(driver, ctx, config, options.control).explore();

  /*
   * 앱 화면에는 URL 도 DOM 도 없다. 없는 신호를 지어내지 않고 빈 값으로 둔다 —
   * 리포트에 그럴듯한 가짜 경로가 찍히면 사용자가 그것을 찾아 헤맨다.
   */
  const explored: ExploreResult = {
    graph: {
      nodes: appResult.screens.map((s) => ({
        stateKey: s.stateKey,
        signals: {
          pathTemplate: "",
          queryKeys: [],
          title: s.screenName,
          heading: s.screenName,
          activeTab: null,
          dialogTitle: null,
          navLabels: [],
          structureHash: s.stateKey,
        },
        url: "",
        depth: s.depth,
        arrivedByActionId: null,
        visitedAt: new Date().toISOString(),
        screenName: s.screenName,
      })),
      edges: [],
    },
    actionResults: [],
    candidates: detectAppIssues(appResult, ctx),
    limits: [...appResult.limits, ...appUnverifiedAreas(appResult)],
  };

  const judged = judge(explored.candidates, explored.graph);
  log("info", `Issue 확정: 후보 ${judged.mergedFrom}건 → Issue ${judged.issues.length}건`);

  const enriched = await enrichWithAi({
    config,
    issues: judged.issues,
    explored,
    evidences: ctx.listEvidences(),
    makeProvider: options.createProvider ?? createProvider,
    ready: aiReady,
  });

  for (const issue of enriched.issues) {
    emit({ type: "issue:found", at: new Date().toISOString(), issue });
  }

  const summary = buildSummary({
    runId: ctx.runId,
    config,
    startedAt,
    explored,
    issues: enriched.issues,
    ai: enriched,
    stopped: options.control?.stopped ?? false,
  });

  /*
   * 실행/미실행 수는 앱 탐색의 실제 숫자로 덮는다.
   * ActionResult 로 옮겨 담지 않았으므로 그냥 두면 0 으로 나가고,
   * 사용자는 아무것도 안 눌린 줄 안다.
   */
  summary.actionsExecuted = appResult.actions.filter((a) => a.outcome === "EXECUTED").length;
  summary.actionsSkipped = appResult.actions.length - summary.actionsExecuted;

  const reportPath = ctx.writeReport(
    renderReport({
      summary,
      issues: enriched.issues,
      evidences: ctx.listEvidences(),
      aiSummary: enriched.summaryText,
    }),
  );
  const issuesPath = ctx.writeIssues({ schemaVersion: 1, summary, issues: enriched.issues });

  emit({ type: "run:finished", at: new Date().toISOString(), summary, reportPath, issuesPath });
  return {
    status: summary.status,
    message: `화면 ${appResult.screens.length}개 · 결함 ${enriched.issues.length}건`,
  };
}

/**
 * 소스 전용 Run.
 *
 * 탐색 그래프가 없으므로 빈 결과를 만들어 넘긴다. 리포트 목차는 하나뿐이고,
 * 모드마다 다른 리포트를 만들면 사용자가 두 가지를 읽는 법을 배워야 한다.
 */
async function runSourceOnly(
  config: RunConfig,
  ctx: RunContext,
  startedAt: Date,
  options: RunOptions,
): Promise<RunOutcome> {
  const aiReady = await preflightAi(config, options.createProvider ?? createProvider);
  const source = runSourceQa(config, ctx);
  const impact = computeChangeImpact(config);

  const explored: ExploreResult = {
    graph: { nodes: [], edges: [] },
    actionResults: [],
    candidates: [],
    limits: [],
  };

  const judged = judge(source.candidates, explored.graph);
  log("info", `Issue 확정: 후보 ${judged.mergedFrom}건 → Issue ${judged.issues.length}건`);

  const enriched = await enrichWithAi({
    config,
    issues: judged.issues,
    explored,
    evidences: ctx.listEvidences(),
    makeProvider: options.createProvider ?? createProvider,
    ready: aiReady,
  });

  for (const issue of enriched.issues) {
    emit({ type: "issue:found", at: new Date().toISOString(), issue });
  }

  const summary = buildSummary({
    runId: ctx.runId,
    config,
    startedAt,
    explored,
    issues: enriched.issues,
    ai: enriched,
    source,
    impact,
    stopped: options.control?.stopped ?? false,
  });

  const reportPath = ctx.writeReport(
    renderReport({
      summary,
      issues: enriched.issues,
      evidences: ctx.listEvidences(),
      aiSummary: enriched.summaryText,
    }),
  );
  const issuesPath = ctx.writeIssues({ schemaVersion: 1, summary, issues: enriched.issues });

  emit({ type: "run:finished", at: new Date().toISOString(), summary, reportPath, issuesPath });
  return { status: summary.status, message: `소스 결함 ${enriched.issues.length}건` };
}

export async function runQa(
  config: RunConfig,
  ctx: RunContext,
  options: RunOptions = {},
): Promise<RunOutcome> {
  const startedAt = new Date();

  /*
   * 소스 QA 는 브라우저를 띄우지 않는다.
   *
   * preflightBrowser() 를 먼저 부르면 Chromium 이 없는 환경에서 소스 QA 조차
   * 시작하지 못한다. 모드가 요구하지 않는 자원은 확인하지도 않는다.
   */
  if (config.mode === "source") {
    return await runSourceOnly(config, ctx, startedAt, options);
  }

  // 앱 QA 도 마찬가지다. 대상이 폰이므로 브라우저를 확인할 이유가 없다.
  if (config.mode === "app") {
    return await runAppOnly(config, ctx, startedAt, options);
  }

  const pre = await preflightBrowser();
  if (!pre.ok) {
    log("error", pre.remediation ?? "브라우저를 기동할 수 없습니다.");
    return { status: "FAILED", message: pre.remediation ?? "브라우저 기동 실패" };
  }

  const session = await launch(config);
  const collector = new Collector();
  collector.attach(session.page);

  try {
    const startUrl = new URL(config.startPath, config.targetUrl).toString();
    await session.page.goto(startUrl, { waitUntil: "domcontentloaded" });

    if (!config.login.enabled) {
      log("info", "로그인을 건너뜁니다 (--no-login)");
      await captureScreen(session.page, ctx, collector, {
        stateKey: "entry",
        screenName: "진입",
      });
      return { status: "COMPLETED", message: "로그인 없이 진입 화면 증적을 수집했습니다." };
    }

    // 로그인 화면 증적은 비밀번호를 넣기 **전에** 찍는다.
    await captureScreen(
      session.page,
      ctx,
      collector,
      { stateKey: "login", screenName: "로그인" },
      { clearPasswordFields: true },
    );

    const result = await login(session.page, config.login, config.targetUrl);
    log(result.success ? "info" : "warn", result.reason);
    if (result.warning) log("warn", result.warning);

    ctx.writeJson("actions", "login.json", {
      success: result.success,
      landedUrl: result.landedUrl,
      reason: result.reason,
      signals: result.signals,
      usedSelectors: result.usedSelectors,
      warning: result.warning,
    });

    if (!result.success) {
      // 실패 화면을 남기되, 비밀번호가 찍히지 않도록 먼저 비운다.
      await captureScreen(
        session.page,
        ctx,
        collector,
        { stateKey: "login-failed", screenName: "로그인실패" },
        { clearPasswordFields: true },
      );
      return { status: "FAILED", message: result.reason };
    }

    /*
     * AI 는 탐색 **전에** 확인한다. 여기서 확인하지 않으면 Provider 를 골라 놓고도
     * 탐색이 끝날 때까지 화면에 "사용 안 함" 이 떠 있고, 연결 실패도 그때 안다.
     */
    const aiReady = await preflightAi(config, options.createProvider ?? createProvider);

    // ── 자율 탐색 ─────────────────────────────────────────────────────
    // 변경 영향은 탐색 **전에** 계산해야 순서에 반영된다.
    const impact = computeChangeImpact(config);
    const explorer = new Explorer(
      session.page,
      ctx,
      collector,
      config,
      options.control ?? NO_CONTROL,
      impact?.hints ?? [],
    );
    const explored = await explorer.explore(makeStartPlan(result.landedUrl));

    ctx.writeJson("actions", "graph.json", explored.graph);

    const executed = explored.actionResults.filter((r) => r.outcome === "EXECUTED").length;
    const skipped = explored.actionResults.length - executed;
    /*
     * 미실행 건수만 적으면 그만큼의 기능을 놓친 것처럼 읽힌다.
     * 실제로는 목록의 행마다 붙은 같은 버튼과, 화면을 다시 열 때마다 다시 세어진 것이
     * 대부분이다(실측: 511건이 기능 35종). 종 수를 같이 적어야 오해가 없다.
     */
    const skippedKinds = new Set(
      explored.actionResults.filter((r) => r.outcome !== "EXECUTED").map((r) => r.action.label.trim()),
    ).size;

    log(
      "info",
      `탐색 완료: 화면 ${explored.graph.nodes.length}개 · 액션 실행 ${executed}건 · ` +
        `미실행 ${skipped}건 (기능 ${skippedKinds}종, 상세는 리포트 §17)`,
    );
    for (const limit of explored.limits) log("warn", `탐색 제한: ${limit}`);

    // ── 쓰기 테스트 ───────────────────────────────────────────────────
    // 탐색이 끝난 뒤에만 돈다. 탐색 중에 데이터를 만들면 화면이 바뀌어
    // 상태 지문이 흔들리고 결정성이 깨진다.
    const crud = new CrudTester(session.page, ctx, collector, config, options.control ?? NO_CONTROL);
    const crudOutcome = await crud.run(explored.graph);

    const leftovers = crudOutcome.ledger.leftovers();
    if (leftovers.length > 0) {
      log("warn", `정리하지 못한 테스트 데이터 ${leftovers.length}건: ${leftovers.map((r) => r.marker).join(", ")}`);
    }

    // ── Issue 확정 (룰) ───────────────────────────────────────────────
    /*
     * 통합 모드에서는 소스 결함도 **같은 judge** 에 넣는다.
     * 파이프라인을 하나로 두어야 우선순위가 한 자에서 매겨진다 —
     * 소스 리포트와 실행 리포트를 따로 내면 사용자가 둘을 손으로 합쳐야 한다.
     */
    const sourceOutcome =
      config.mode === "integrated"
        ? runSourceQa(config, ctx, { screensExplored: explored.graph.nodes.length })
        : null;
    const judged = judge(
      [...explored.candidates, ...crudOutcome.candidates, ...(sourceOutcome?.candidates ?? [])],
      explored.graph,
    );
    log(
      "info",
      `Issue 확정: 후보 ${judged.mergedFrom}건 → Issue ${judged.issues.length}건`,
    );

    /*
     * 통합 모드의 본론.
     *
     * 실행 QA 가 본 것은 `POST /api/users → 500` 뿐이다. 그것을 컨트롤러
     * 파일·줄로 옮기는 것이 이 도구의 차별점이다. **AI 보강보다 먼저** 한다 —
     * 모델에게 소스 위치를 알려주고 원인을 묻는 것과, 모르는 채로 묻는 것은 다르다.
     */
    let mapping: { mapped: number; unmapped: string[] } | null = null;
    let issuesForAi = judged.issues;
    if (sourceOutcome) {
      const index = buildApiIndex(
        config.source.rootDir,
        sourceOutcome.endpoints,
        sourceOutcome.scan.files,
      );
      const attached = attachCodeRefs(judged.issues, index);
      issuesForAi = attached.issues;
      mapping = { mapped: attached.mapped, unmapped: attached.unmapped };
      log(
        "info",
        `API→소스 매핑: ${attached.mapped}건 연결` +
          (attached.unmapped.length > 0 ? ` · 못 찾음 ${attached.unmapped.length}건` : ""),
      );
    }

    // ── AI 보강 ───────────────────────────────────────────────────────
    // 탐색이 끝난 뒤에만 돈다. 여기서 무슨 일이 나도 위의 judged.issues는 그대로다.
    const enriched = await enrichWithAi({
      config,
      issues: issuesForAi,
      explored,
      evidences: ctx.listEvidences(),
      makeProvider: options.createProvider ?? createProvider,
      ready: aiReady,
    });

    for (const issue of enriched.issues) {
      emit({ type: "issue:found", at: new Date().toISOString(), issue });
    }

    // ── 리포트 ────────────────────────────────────────────────────────
    const summary = buildSummary({
      runId: ctx.runId,
      config,
      startedAt,
      explored,
      issues: enriched.issues,
      ai: enriched,
      crud: crudOutcome.results,
      source: sourceOutcome
        ? {
            ...sourceOutcome,
            unverified: [
              ...sourceOutcome.unverified,
              // 소스 위치를 못 찾은 것도 "안 본 것"이다. 조용히 넘어가지 않는다.
              ...(mapping && mapping.unmapped.length > 0
                ? [
                    `아래 요청은 소스에서 대응하는 핸들러를 찾지 못했습니다: ${mapping.unmapped.join(", ")}`,
                  ]
                : []),
            ],
          }
        : null,
      impact,
      leftovers: leftovers.map((r) => `${r.marker} (${r.screen}) — ${r.cleanupError ?? "사유 미상"}`),
      stopped: options.control?.stopped ?? false,
    });

    const reportPath = ctx.writeReport(
      renderReport({
        summary,
        issues: enriched.issues,
        evidences: ctx.listEvidences(),
        aiSummary: enriched.summaryText,
        missingFeatures: enriched.missingFeatures,
        suspectedFalsePositives: enriched.suspectedFalsePositives,
      }),
    );
    const issuesPath = ctx.writeIssues({ schemaVersion: 1, summary, issues: enriched.issues });

    emit({
      type: "run:finished",
      at: new Date().toISOString(),
      summary,
      reportPath,
      issuesPath,
    });

    const c = summary.issueCounts;
    const stopped = options.control?.stopped ?? false;
    return {
      status: stopped ? "STOPPED" : "COMPLETED",
      message:
        `화면 ${explored.graph.nodes.length}개 탐색 · Issue ${judged.issues.length}건 ` +
        `(Critical ${c.critical} · High ${c.high} · Medium ${c.medium} · Low ${c.low}) · ` +
        `증적 ${ctx.listEvidences().length}건`,
    };
  } finally {
    await session.close();
    // 증적 색인은 Run 출력 계약의 일부다. 중단·실패로 끝나도 반드시 남긴다.
    // (CLI가 아니라 여기서 쓰는 이유: runQa를 직접 호출하는 호출자 — Phase 5의
    //  Electron, 통합 테스트 — 도 똑같이 색인을 받아야 한다)
    ctx.saveEvidenceIndex();
  }
}
