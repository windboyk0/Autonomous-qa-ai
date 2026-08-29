import { create } from "zustand";
import type { EngineEvent, Issue, RunConfig, RunSummary } from "@qa/shared";

/**
 * 렌더러 상태.
 *
 * 엔진이 흘리는 `EngineEvent`를 그대로 받아 화면 상태로 접는다.
 * **새 규약을 만들지 않는다** — Phase 0의 이벤트 스키마가 그대로 UI의 입력이다.
 */

export interface ProjectRow {
  id: number;
  name: string;
  targetUrl: string;
  startPath: string;
  username: string;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RunRow {
  id: number;
  projectId: number;
  runId: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  runDir: string;
  screensExplored: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  aiStatus: string;
}

export type Screen =
  | "projects"
  | "setup"
  | "monitor"
  | "issues"
  | "evidence"
  | "report"
  | "history";

export interface LogLine {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  at: string;
}

interface Progress {
  screensExplored: number;
  screensQueued: number;
  actionsExecuted: number;
  currentTask: string;
  currentScreen: string;
}

interface State {
  screen: Screen;
  projects: ProjectRow[];
  selectedProjectId: number | null;
  runs: RunRow[];
  selectedRunPk: number | null;

  /** 실행 중 상태 */
  running: boolean;
  paused: boolean;
  runStatus: string;
  progress: Progress;
  logs: LogLine[];
  visitedScreens: Array<{ name: string; screenshotPath: string | null }>;
  liveIssues: Issue[];
  aiDetail: string | null;
  /** 엔진이 결과 없이 죽었는가. 화면에 크게 알려야 한다. */
  crashed: boolean;
  lastError: string | null;

  /** 결과 조회 */
  summary: RunSummary | null;
  issues: Issue[];
  selectedIssueId: string | null;
  report: string | null;

  go: (screen: Screen) => void;
  setProjects: (rows: ProjectRow[]) => void;
  selectProject: (id: number | null) => void;
  setRuns: (rows: RunRow[]) => void;
  selectRun: (runPk: number | null) => void;
  selectIssue: (id: string | null) => void;
  setResult: (summary: RunSummary | null, issues: Issue[]) => void;
  setReport: (text: string | null) => void;

  beginRun: () => void;
  applyEvent: (event: EngineEvent) => void;
  noteNoise: (text: string) => void;
  endRun: (crashed: boolean, code: number | null) => void;
  setPaused: (paused: boolean) => void;
  setError: (message: string | null) => void;
}

const MAX_LOGS = 500;

const emptyProgress: Progress = {
  screensExplored: 0,
  screensQueued: 0,
  actionsExecuted: 0,
  currentTask: "대기",
  currentScreen: "-",
};

export const useStore = create<State>((set) => ({
  screen: "projects",
  projects: [],
  selectedProjectId: null,
  runs: [],
  selectedRunPk: null,

  running: false,
  paused: false,
  runStatus: "PENDING",
  progress: emptyProgress,
  logs: [],
  visitedScreens: [],
  liveIssues: [],
  aiDetail: null,
  crashed: false,
  lastError: null,

  summary: null,
  issues: [],
  selectedIssueId: null,
  report: null,

  go: (screen) => set({ screen }),
  setProjects: (projects) => set({ projects }),
  selectProject: (selectedProjectId) => set({ selectedProjectId }),
  setRuns: (runs) => set({ runs }),
  selectRun: (selectedRunPk) => set({ selectedRunPk }),
  selectIssue: (selectedIssueId) => set({ selectedIssueId }),
  setResult: (summary, issues) => set({ summary, issues }),
  setReport: (report) => set({ report }),
  setPaused: (paused) => set({ paused }),
  setError: (lastError) => set({ lastError }),

  beginRun: () =>
    set({
      running: true,
      paused: false,
      crashed: false,
      lastError: null,
      runStatus: "RUNNING",
      progress: emptyProgress,
      logs: [],
      visitedScreens: [],
      liveIssues: [],
      aiDetail: null,
      summary: null,
      issues: [],
      report: null,
      screen: "monitor",
    }),

  applyEvent: (event) =>
    set((state) => {
      switch (event.type) {
        case "run:status":
          return { runStatus: event.status };
        case "run:progress":
          return {
            progress: {
              screensExplored: event.screensExplored,
              screensQueued: event.screensQueued,
              actionsExecuted: event.actionsExecuted,
              currentTask: event.currentTask,
              currentScreen: event.currentScreen,
            },
          };
        case "state:visited":
          return {
            visitedScreens: [
              ...state.visitedScreens,
              { name: event.state.screenName, screenshotPath: event.screenshotPath },
            ],
          };
        case "issue:found":
          return { liveIssues: [...state.liveIssues, event.issue] };
        case "ai:status":
          return { aiDetail: event.detail };
        case "run:finished":
          return { summary: event.summary, issues: state.liveIssues };
        case "log":
          return {
            logs: [
              ...state.logs.slice(-(MAX_LOGS - 1)),
              { level: event.level, message: event.message, at: event.at },
            ],
          };
        default:
          return {};
      }
    }),

  noteNoise: (text) =>
    set((state) => ({
      logs: [
        ...state.logs.slice(-(MAX_LOGS - 1)),
        { level: "warn" as const, message: text, at: new Date().toISOString() },
      ],
    })),

  endRun: (crashed, code) =>
    set((state) => ({
      running: false,
      paused: false,
      crashed,
      runStatus: crashed ? "FAILED" : state.runStatus === "RUNNING" ? "STOPPED" : state.runStatus,
      lastError: crashed
        ? `엔진이 결과를 남기지 못하고 종료했습니다 (종료 코드 ${code ?? "?"}). 아래 로그를 확인하세요.`
        : state.lastError,
    })),
}));
