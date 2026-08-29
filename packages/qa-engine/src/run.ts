import type { RunConfig, RunStatus } from "@qa/shared";
import { log } from "./emitter.js";
import { launch, preflightBrowser } from "./browser.js";
import { Collector } from "./collector.js";
import { captureScreen } from "./capture.js";
import { login } from "./login.js";
import type { RunContext } from "./run-context.js";
import { Explorer, makeStartPlan } from "./explorer.js";

export interface RunOutcome {
  status: RunStatus;
  message: string;
}

/**
 * Run 본체.
 *
 * Preflight → Login → 자율 탐색 → (Phase 3) 검출·리포트.
 *
 * CLI에서 분리해 둔 이유는 통합 테스트가 프로세스를 띄우지 않고
 * 이 함수만 직접 호출할 수 있게 하기 위해서다.
 */
export async function runQa(config: RunConfig, ctx: RunContext): Promise<RunOutcome> {
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
    log("info", result.reason);

    ctx.writeJson("actions", "login.json", {
      success: result.success,
      landedUrl: result.landedUrl,
      reason: result.reason,
      signals: result.signals,
      usedSelectors: result.usedSelectors,
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

    // ── 자율 탐색 ─────────────────────────────────────────────────────
    const explorer = new Explorer(session.page, ctx, collector, config);
    const explored = await explorer.explore(makeStartPlan(result.landedUrl));

    ctx.writeJson("actions", "graph.json", explored.graph);

    const executed = explored.actionResults.filter((r) => r.outcome === "EXECUTED").length;
    const skipped = explored.actionResults.length - executed;

    log(
      "info",
      `탐색 완료: 화면 ${explored.graph.nodes.length}개 · 액션 실행 ${executed}건 · 미실행 ${skipped}건`,
    );
    for (const limit of explored.limits) log("warn", `탐색 제한: ${limit}`);

    log("warn", "룰 기반 검출과 리포트 생성은 Phase 3에서 구현됩니다.");

    return {
      status: "COMPLETED",
      message:
        `화면 ${explored.graph.nodes.length}개 탐색 · 액션 ${executed}건 실행 · ` +
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
