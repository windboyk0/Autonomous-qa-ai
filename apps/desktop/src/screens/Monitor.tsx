import { useEffect, useRef, useState } from "react";
import { qa } from "../api.js";
import { useStore } from "../store.js";

/**
 * 실행 Monitor (CLAUDE.md §22).
 *
 * 진행 상황과 현재 화면 스크린샷을 실시간으로 보여준다.
 * 화면이 멈춘 것처럼 보이면 사용자는 중단 버튼을 누르므로, 엔진이 보내는
 * `run:progress`를 그대로 흘려보낸다.
 */
export function Monitor() {
  const {
    running,
    paused,
    runStatus,
    progress,
    logs,
    visitedScreens,
    liveIssues,
    aiDetail,
    crashed,
    lastError,
    setPaused,
    go,
    selectedRunPk,
  } = useStore();

  const [preview, setPreview] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const latest = visitedScreens.at(-1);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs.length]);

  // 마지막으로 방문한 화면의 스크린샷을 실시간 미리보기로 띄운다.
  useEffect(() => {
    void (async () => {
      if (!latest?.screenshotPath) return;
      const runs = await qa().runs.list();
      const current = runs[0];
      if (!current?.runDir) return;
      const file = await qa().runs.evidence(current.runDir, latest.screenshotPath);
      setPreview(file && file.kind === "image" ? file.dataUrl : null);
    })();
  }, [latest?.screenshotPath]);

  const counts = {
    critical: liveIssues.filter((i) => i.severity === "CRITICAL").length,
    high: liveIssues.filter((i) => i.severity === "HIGH").length,
    medium: liveIssues.filter((i) => i.severity === "MEDIUM").length,
    low: liveIssues.filter((i) => i.severity === "LOW").length,
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">
          QA {running ? (paused ? "일시정지" : "실행 중") : "종료"}
          <span className="ml-2 text-sm text-slate-500" data-testid="run-status">
            {runStatus}
          </span>
        </h1>
        <div className="flex gap-2">
          <button
            className="btn-ghost"
            disabled={!running}
            data-testid="btn-pause"
            onClick={() => {
              void (paused ? qa().run.resume() : qa().run.pause());
              setPaused(!paused);
            }}
          >
            {paused ? "재개" : "일시정지"}
          </button>
          <button
            className="btn-ghost text-red-600"
            disabled={!running}
            data-testid="btn-stop"
            onClick={() => void qa().run.stop()}
          >
            중단
          </button>
          {!running && (
            <button className="btn-primary" data-testid="goto-report" onClick={() => go("report")}>
              리포트 열기
            </button>
          )}
        </div>
      </div>

      {crashed && (
        <div className="alert-error mb-4" data-testid="crash-banner">
          <b>엔진이 비정상 종료했습니다.</b> 프로그램은 계속 사용할 수 있습니다. {lastError}
        </div>
      )}
      {lastError && !crashed && <div className="alert-error mb-4">{lastError}</div>}

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-1 space-y-4">
          <div className="card">
            <h2>진행</h2>
            <dl className="stat">
              <dt>현재 화면</dt>
              <dd data-testid="cur-screen">{progress.currentScreen}</dd>
              <dt>현재 작업</dt>
              <dd>{progress.currentTask}</dd>
              <dt>탐색</dt>
              <dd data-testid="cur-screens">
                {progress.screensExplored} 화면 (대기 {progress.screensQueued})
              </dd>
              <dt>실행 액션</dt>
              <dd>{progress.actionsExecuted}</dd>
              <dt>AI</dt>
              <dd>{aiDetail ?? "사용 안 함"}</dd>
            </dl>
          </div>

          <div className="card">
            <h2>Issue</h2>
            <dl className="stat">
              <dt>Critical</dt>
              <dd>{counts.critical}</dd>
              <dt>High</dt>
              <dd>{counts.high}</dd>
              <dt>Medium</dt>
              <dd>{counts.medium}</dd>
              <dt>Low</dt>
              <dd>{counts.low}</dd>
            </dl>
          </div>
        </div>

        <div className="col-span-2 space-y-4">
          <div className="card">
            <h2>현재 화면 미리보기</h2>
            {preview ? (
              <img src={preview} alt={latest?.name ?? ""} className="w-full border border-slate-200 rounded" />
            ) : (
              <p className="text-slate-500">아직 스크린샷이 없습니다.</p>
            )}
          </div>

          <div className="card">
            <h2>로그</h2>
            <div className="log" ref={logRef} data-testid="log-box">
              {logs.map((l, i) => (
                <div key={i} className={`log-${l.level}`}>
                  [{l.level}] {l.message}
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <h2>탐색한 화면 ({visitedScreens.length})</h2>
            <ol className="list">
              {visitedScreens.map((s, i) => (
                <li key={i}>{s.name}</li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
