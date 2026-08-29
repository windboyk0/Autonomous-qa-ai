import { contextBridge, ipcRenderer } from "electron";

/**
 * 렌더러에 노출하는 유일한 API.
 *
 * 여기 없는 것은 렌더러가 할 수 없다 — 파일시스템도, 자식 프로세스도,
 * Node 모듈도 닿지 않는다. 자격증명은 **읽는 경로가 아예 없다.**
 */
const api = {
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    get: (id: number) => ipcRenderer.invoke("projects:get", id),
    save: (input: unknown) => ipcRenderer.invoke("projects:save", input),
    remove: (id: number) => ipcRenderer.invoke("projects:delete", id),
  },
  run: {
    preflight: () => ipcRenderer.invoke("run:preflight"),
    start: (input: unknown) => ipcRenderer.invoke("run:start", input),
    pause: () => ipcRenderer.invoke("run:pause"),
    resume: () => ipcRenderer.invoke("run:resume"),
    stop: () => ipcRenderer.invoke("run:stop"),
  },
  runs: {
    list: (projectId?: number) => ipcRenderer.invoke("runs:list", projectId),
    detail: (runPk: number) => ipcRenderer.invoke("runs:detail", runPk),
    report: (runDir: string) => ipcRenderer.invoke("runs:report", runDir),
    evidence: (runDir: string, relPath: string) => ipcRenderer.invoke("runs:evidence", runDir, relPath),
    openFolder: (runDir: string) => ipcRenderer.invoke("runs:openFolder", runDir),
  },
  /** 엔진 이벤트 구독. 해제 함수를 돌려준다. */
  onRun: (handler: (message: unknown) => void) => {
    const listener = (_event: unknown, message: unknown) => handler(message);
    ipcRenderer.on("qa:run", listener);
    return () => ipcRenderer.removeListener("qa:run", listener);
  },
};

contextBridge.exposeInMainWorld("qa", api);

export type QaApi = typeof api;
