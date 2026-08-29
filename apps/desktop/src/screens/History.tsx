import { useEffect } from "react";
import { qa } from "../api.js";
import { useStore } from "../store.js";

/** 실행 History. Run을 고르면 Issue·리포트 화면이 그 Run을 본다. */
export function History() {
  const { runs, setRuns, selectRun, selectedRunPk, setResult, go } = useStore();

  useEffect(() => {
    void (async () => setRuns(await qa().runs.list()))();
  }, []);

  const open = async (runPk: number) => {
    selectRun(runPk);
    const { summary, issues } = await qa().runs.detail(runPk);
    setResult(summary, issues);
    go("issues");
  };

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold mb-4">실행 History</h1>
      {runs.length === 0 ? (
        <p className="text-slate-500">실행 기록이 없습니다.</p>
      ) : (
        <table className="w-full text-sm" data-testid="history-table">
          <thead>
            <tr className="text-left border-b border-slate-200">
              <th className="py-2">시작</th>
              <th>Run ID</th>
              <th>상태</th>
              <th>화면</th>
              <th>C / H / M / L</th>
              <th>AI</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr
                key={r.id}
                className={`border-b border-slate-100 cursor-pointer hover:bg-slate-50 ${
                  r.id === selectedRunPk ? "bg-blue-50" : ""
                }`}
                onClick={() => void open(r.id)}
                data-testid={`history-row-${r.id}`}
              >
                <td className="py-2">{r.startedAt.slice(0, 19).replace("T", " ")}</td>
                <td className="font-mono text-xs">{r.runId}</td>
                <td>{r.status}</td>
                <td>{r.screensExplored}</td>
                <td>
                  {r.critical} / {r.high} / {r.medium} / {r.low}
                </td>
                <td>{r.aiStatus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
