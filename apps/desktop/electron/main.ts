import { join, resolve } from "node:path";
import { app, BrowserWindow } from "electron";
import { IpcLayer } from "./ipc.js";
import { Store } from "./store.js";

/**
 * Electron main.
 *
 * 하는 일은 셋뿐이다: 창을 띄우고, 저장소를 열고, IPC를 등록한다.
 * **QA 로직은 하나도 여기 없다.** 엔진은 자식 프로세스로 돌고,
 * 이 프로세스는 그 stdout을 화면에 중계할 뿐이다.
 */

// CJS로 번들되므로 __dirname 이 dist/electron 을 가리킨다.
const here = __dirname;

/** 개발 중에는 저장소 루트, 패키징 후에는 사용자 데이터 폴더가 작업 기준이 된다. */
function workspaceRoot(): string {
  return app.isPackaged ? app.getPath("userData") : resolve(here, "../../../..");
}

let window: BrowserWindow | null = null;
let store: Store | null = null;
let ipc: IpcLayer | null = null;

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: "관리자웹 자율 QA",
    webPreferences: {
      // preload는 CJS 번들이라 sandbox를 켜도 되지만, node-sqlite3-wasm 등
      // main 쪽 모듈이 sandbox 환경에서 제약을 받으므로 끈다.
      // contextIsolation은 유지하므로 렌더러는 preload가 노출한 API만 쓴다.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(here, "preload.cjs"),
    },
  });

  window.once("ready-to-show", () => window?.show());

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(join(here, "../renderer/index.html"));
  }

  window.on("closed", () => {
    window = null;
  });
}

app.whenReady().then(() => {
  store = new Store(join(app.getPath("userData"), "qa.db"));
  ipc = new IpcLayer(store, () => window, workspaceRoot());
  ipc.register();

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  ipc?.dispose();
  store?.close();
});

/**
 * main 프로세스에서 새어 나온 예외가 앱을 통째로 내리지 않게 한다.
 * 엔진·저장소 어디서 문제가 나도 사용자는 창을 닫을 수 있어야 한다.
 */
process.on("uncaughtException", (err) => {
  console.error("[main] uncaught:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[main] unhandled rejection:", reason);
});
