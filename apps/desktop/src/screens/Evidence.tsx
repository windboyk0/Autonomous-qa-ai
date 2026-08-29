import { useEffect, useState } from "react";
import { qa } from "../api.js";
import { useStore } from "../store.js";

interface EvidenceIndex {
  evidences: Array<{
    id: string;
    kind: string;
    screenName: string;
    path: string | null;
    summary: string;
  }>;
}

/** Evidence / Screenshot Viewer (CLAUDE.md §21의 12·13번 화면). */
export function Evidence() {
  const { runs, selectedRunPk, issues, selectedIssueId } = useStore();
  const run = runs.find((r) => r.id === selectedRunPk) ?? runs[0];
  const issue = issues.find((i) => i.id === selectedIssueId) ?? null;

  const [index, setIndex] = useState<EvidenceIndex | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<
    { kind: "image"; dataUrl: string } | { kind: "text"; text: string } | null
  >(null);

  useEffect(() => {
    void (async () => {
      if (!run?.runDir) return;
      const raw = await qa().runs.evidence(run.runDir, "evidence.json");
      if (raw && raw.kind === "text") {
        try {
          setIndex(JSON.parse(raw.text) as EvidenceIndex);
        } catch {
          setIndex(null);
        }
      }
    })();
  }, [run?.runDir]);

  useEffect(() => {
    void (async () => {
      if (!run?.runDir || !selectedPath) return setContent(null);
      setContent(await qa().runs.evidence(run.runDir, selectedPath));
    })();
  }, [run?.runDir, selectedPath]);

  if (!run?.runDir) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold mb-2">증적</h1>
        <p className="text-slate-500">실행 결과를 먼저 선택하세요.</p>
      </div>
    );
  }

  // Issue를 선택한 상태면 그 Issue의 증적만 추린다.
  const wanted = issue ? new Set(issue.evidenceIds) : null;
  const rows = (index?.evidences ?? []).filter((e) => (wanted ? wanted.has(e.id) : true));

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">
          증적 {issue ? <span className="text-sm text-slate-500">— {issue.id} 관련</span> : null}
        </h1>
        <button className="btn-ghost" onClick={() => void qa().runs.openFolder(run.runDir)}>
          폴더 열기
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-1 card overflow-auto max-h-[70vh]">
          <h2>목록 ({rows.length})</h2>
          <ul className="list" data-testid="evidence-list">
            {rows.map((e) => (
              <li key={e.id}>
                <button
                  className={`text-left w-full hover:bg-slate-50 px-1 ${
                    selectedPath === e.path ? "bg-blue-50" : ""
                  }`}
                  disabled={!e.path}
                  onClick={() => setSelectedPath(e.path)}
                >
                  <span className="badge">{e.kind}</span> {e.screenName}
                  <div className="text-xs text-slate-500">{e.summary}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="col-span-2 card overflow-auto max-h-[70vh]">
          {content === null && <p className="text-slate-500">왼쪽에서 증적을 선택하세요.</p>}
          {content?.kind === "image" && (
            <img src={content.dataUrl} alt="" className="w-full border border-slate-200 rounded" />
          )}
          {content?.kind === "text" && <pre className="text-xs whitespace-pre-wrap">{content.text}</pre>}
        </div>
      </div>
    </div>
  );
}
