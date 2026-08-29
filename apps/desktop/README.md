# @qa/desktop — Electron 셸

엔진을 자식 프로세스로 띄우고, 그 stdout(JSON Lines)을 화면에 중계한다.
**QA 로직은 하나도 여기 없다.**

## 구조

```
electron/          main 프로세스 (esbuild → dist/electron/*.cjs)
  main.ts          창, 저장소, IPC 등록
  engine.ts        엔진 자식 프로세스 관리 + stdin 제어 채널
  ipc.ts           렌더러 ↔ main 의 유일한 통로
  store.ts         SQLite (projects / qa_runs / qa_issues)
  credentials.ts   safeStorage 암복호화
  preload.ts       contextBridge — 여기 없는 것은 렌더러가 할 수 없다
src/               렌더러 (Vite + React + Tailwind)
  screens/         프로젝트 · QA설정 · Monitor · Issue · 증적 · 리포트 · History
```

## 실행

```bash
pnpm build          # 저장소 루트에서 (엔진 빌드가 선행되어야 한다)
pnpm --filter @qa/desktop start
```

## 알아둘 함정

**`ELECTRON_RUN_AS_NODE`가 켜져 있으면 앱이 기동하지 못한다.**
Electron이 순수 Node로 실행되어 `require("electron")` 이 API 대신 실행 파일 경로
문자열을 돌려준다. VS Code 같은 Electron 기반 도구가 자식 프로세스에 이 값을
심어두므로, 터미널에서 실행할 때 조용히 상속될 수 있다. 증상이 보이면:

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE
```

반대로 엔진을 띄울 때는 **일부러 켠다** — 사용자 PC에 Node.js가 없어도
Electron 자신을 Node 런타임으로 재사용하기 위해서다.

**main 프로세스는 ESM이 아니라 CJS 번들이다.**
`node_modules/electron` 이 내장 모듈을 가리기 때문이다. `scripts/build-main.mjs` 참고.

## 보안 경계

- 렌더러는 `contextIsolation: true` 이며 Node에 직접 닿지 않는다
- preload에 **자격증명을 읽는 API가 없다**. 저장 여부(`hasPassword`)만 노출한다
- 비밀번호는 `safeStorage`로 암호화해 BLOB으로만 저장하고, 엔진에는 환경변수로 넘긴다
- 증적 파일은 main이 읽어 data URL로 넘긴다. 상대경로는 `safeJoin`으로 탈출을 막는다
