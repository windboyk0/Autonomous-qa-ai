import { useEffect } from "react";
import { qa } from "../api.js";
import { useStore } from "../store.js";

/**
 * Report Viewer.
 *
 * 엔진이 만든 `report.md`를 그대로 보여준다. **여기서 리포트를 다시 만들지 않는다** —
 * 화면에 보이는 것과 파일로 남는 것이 달라지면 안 된다.
 */
export function Report() {
  const { runs, selectedRunPk, setRuns, selectRun, report, setReport, summary } = useStore();
  const run = runs.find((r) => r.id === selectedRunPk) ?? runs[0];

  useEffect(() => {
    void (async () => {
      const rows = await qa().runs.list();
      setRuns(rows);
      if (selectedRunPk === null && rows[0]) selectRun(rows[0].id);
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      if (!run?.runDir) return setReport(null);
      setReport(await qa().runs.report(run.runDir));
    })();
  }, [run?.runDir]);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">리포트</h1>
        {run?.runDir && (
          <button className="btn-ghost" onClick={() => void qa().runs.openFolder(run.runDir)}>
            폴더 열기
          </button>
        )}
      </div>

      {summary && (
        <div className="card mb-4">
          <dl className="stat">
            <dt>상태</dt>
            <dd data-testid="report-status">{summary.status}</dd>
            <dt>탐색 화면</dt>
            <dd>{summary.screensExplored}</dd>
            <dt>Issue</dt>
            <dd>
              Critical {summary.issueCounts.critical} · High {summary.issueCounts.high} · Medium{" "}
              {summary.issueCounts.medium} · Low {summary.issueCounts.low}
            </dd>
            <dt>AI</dt>
            <dd>{summary.aiStatus}</dd>
          </dl>
        </div>
      )}

      {report === null ? (
        <p className="text-slate-500" data-testid="report-empty">
          리포트가 아직 없습니다. QA를 실행하면 여기에 표시됩니다.
        </p>
      ) : (
        <pre className="report" data-testid="report-body">
          {report}
        </pre>
      )}
    </div>
  );
}
