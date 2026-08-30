import { join, resolve } from "node:path";
import { app, BrowserWindow, Menu } from "electron";
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
  /*
   * 제목 표시줄과 메뉴바가 흰색으로 남아 본문과 따로 놀았다.
   *
   * 둘 다 Chromium 이 OS 테마로 그리는 것이라 CSS 로는 손댈 수 없다.
   *   - 제목 표시줄: titleBarOverlay 로 색을 지정한다. 창 조작 버튼(최소화·닫기)은
   *     OS 가 그리므로 symbolColor 까지 줘야 어두운 바탕에서 보인다.
   *   - 메뉴바: File/Edit/View/Window/Help 는 Electron 기본 메뉴다. 이 앱은
   *     왼쪽에 자체 내비게이션이 있어 쓸 일이 없다. 없애면 흰 줄도 같이 사라진다.
   *     (개발자 도구는 아래에서 F12 로 남겨 둔다)
   */
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: "관리자웹 자율 QA",
    backgroundColor: "#0f172a",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0f172a", symbolColor: "#e2e8f0", height: 36 },
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

  /*
   * 메뉴를 없애면 F12·Ctrl+Shift+I 단축키도 같이 사라진다.
   * 사용자 PC 에서 문제가 났을 때 콘솔을 볼 방법은 남겨 둔다.
   */
  window.webContents.on("before-input-event", (event, input) => {
    const devtools =
      input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i");
    if (input.type === "keyDown" && devtools) {
      window?.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

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
  // 기본 메뉴(File/Edit/View/Window/Help)를 없앤다. 이 앱의 내비게이션은 왼쪽에 있고,
  // 그 흰 줄 하나 때문에 화면 위쪽이 본문과 따로 놀았다.
  Menu.setApplicationMenu(null);

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
