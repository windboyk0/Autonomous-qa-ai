import { useStore } from "../store.js";

const SEVERITY_CLASS: Record<string, string> = {
  CRITICAL: "sev-critical",
  HIGH: "sev-high",
  MEDIUM: "sev-medium",
  LOW: "sev-low",
};

/** Issue 목록 + 상세 (CLAUDE.md §21의 10·11번 화면을 한 화면에 합쳤다). */
export function Issues() {
  const { issues, liveIssues, selectedIssueId, selectIssue, go } = useStore();
  const list = issues.length > 0 ? issues : liveIssues;
  const selected = list.find((i) => i.id === selectedIssueId) ?? null;

  if (list.length === 0) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold mb-2">Issue</h1>
        <p className="text-slate-500">아직 확정된 Issue가 없습니다.</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold mb-4">Issue ({list.length})</h1>
      <div className="grid grid-cols-2 gap-4">
        <table className="w-full text-sm self-start" data-testid="issue-table">
          <thead>
            <tr className="text-left border-b border-slate-200">
              <th className="py-2">ID</th>
              <th>심각도</th>
              <th>우선순위</th>
              <th>제목</th>
            </tr>
          </thead>
          <tbody>
            {list.map((issue) => (
              <tr
                key={issue.id}
                className={`border-b border-slate-100 cursor-pointer hover:bg-slate-50 ${
                  issue.id === selectedIssueId ? "bg-blue-50" : ""
                }`}
                onClick={() => selectIssue(issue.id)}
                data-testid={`issue-row-${issue.id}`}
              >
                <td className="py-2 font-mono text-xs">{issue.id}</td>
                <td>
                  <span className={SEVERITY_CLASS[issue.severity]}>{issue.severity}</span>
                </td>
                <td>{issue.priority}</td>
                <td className="truncate max-w-xs">{issue.title}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="card">
          {selected ? (
            <>
              <h2 data-testid="issue-detail-title">
                {selected.id} · {selected.severity} · {selected.priority}
              </h2>
              <p className="font-medium mb-2">{selected.title}</p>

              <dl className="stat">
                <dt>화면</dt>
                <dd>{selected.screens.join(", ")}</dd>
                <dt>발생</dt>
                <dd>
                  {selected.occurrenceCount}회 / {selected.screens.length}개 화면
                </dd>
                <dt>룰</dt>
                <dd className="font-mono text-xs">{selected.ruleId}</dd>
              </dl>

              <h3>설명</h3>
              <p className="whitespace-pre-wrap text-sm">{selected.description}</p>

              <h3>영향</h3>
              <p className="text-sm">{selected.impact}</p>

              <h3>재현</h3>
              <ol className="list">
                {selected.reproduction.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>

              <h3>권장 조치</h3>
              <p className="text-sm">{selected.recommendation}</p>

              <h3>증적</h3>
              <p className="text-sm text-slate-600">{selected.evidenceIds.length}건</p>
              <button className="btn-ghost mt-2" onClick={() => go("evidence")}>
                증적 보기 →
              </button>
            </>
          ) : (
            <p className="text-slate-500">왼쪽에서 Issue를 선택하세요.</p>
          )}
        </div>
      </div>
    </div>
  );
}
