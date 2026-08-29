import { useEffect } from "react";
import { qa } from "./api.js";
import { useStore, type Screen } from "./store.js";
import { Projects } from "./screens/Projects.js";
import { Setup } from "./screens/Setup.js";
import { Monitor } from "./screens/Monitor.js";
import { Issues } from "./screens/Issues.js";
import { Evidence } from "./screens/Evidence.js";
import { Report } from "./screens/Report.js";
import { History } from "./screens/History.js";

const NAV: Array<{ key: Screen; label: string }> = [
  { key: "projects", label: "프로젝트" },
  { key: "setup", label: "QA 설정" },
  { key: "monitor", label: "실행 Monitor" },
  { key: "issues", label: "Issue" },
  { key: "evidence", label: "증적" },
  { key: "report", label: "리포트" },
  { key: "history", label: "History" },
];

export function App() {
  const { screen, go, running, applyEvent, beginRun, endRun, noteNoise, setRuns, setResult } = useStore();

  /**
   * 엔진 이벤트 구독.
   *
   * main이 중계해 주는 것을 그대로 스토어에 접는다.
   * Run이 끝나면 저장소에서 확정된 결과를 다시 읽어 화면을 갱신한다.
   */
  useEffect(() => {
    return qa().onRun((message) => {
      switch (message.type) {
        case "started":
          break;
        case "event":
          applyEvent(message.event);
          break;
        case "engine-noise":
          noteNoise(message.text);
          break;
        case "exited":
          endRun({
            crashed: message.crashed,
            code: message.code,
            reason: message.reason,
            runDir: message.runDir,
          });
          void (async () => {
            const rows = await qa().runs.list();
            setRuns(rows);
            const latest = rows[0];
            if (latest) {
              const { summary, issues } = await qa().runs.detail(latest.id);
              setResult(summary, issues);
            }
          })();
          break;
      }
    });
  }, []);

  return (
    <div className="app">
      <nav className="side">
        <h1>자율 QA</h1>
        {NAV.map((item) => (
          <button
            key={item.key}
            className={screen === item.key ? "on" : ""}
            onClick={() => go(item.key)}
            data-testid={`nav-${item.key}`}
          >
            {item.label}
          </button>
        ))}
        {running && <div className="running-dot">실행 중</div>}
      </nav>

      <main className="main">
        {screen === "projects" && <Projects />}
        {screen === "setup" && <Setup />}
        {screen === "monitor" && <Monitor />}
        {screen === "issues" && <Issues />}
        {screen === "evidence" && <Evidence />}
        {screen === "report" && <Report />}
        {screen === "history" && <History />}
      </main>
    </div>
  );
}
