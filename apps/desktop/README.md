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

## 설치본 만들기 (Phase 7)

```bash
pnpm --filter @qa/desktop package
```

`build → stage → electron-builder` 순으로 돌아 `release/` 에 NSIS 설치 파일이 생긴다.

| 항목 | 값 |
|---|---|
| 설치 파일 | 약 196 MB |
| 설치 후 | 약 726 MB |

### 무엇이 들어가는가

```
resources/
  app.asar        앱 코드 (main.cjs · preload.cjs · 렌더러)
  engine/         엔진 번들 + playwright  ← asar 밖. 자식 프로세스가 실제 경로로 연다
    package.json    { "type": "commonjs" } — 없으면 상위 type:module 에 걸려 죽는다
  browsers/
    chromium-<rev>  풀 크로미움. 헤드리스·헤드풀 둘 다 이걸로 돈다
```

**헤드리스 셸(`chromium_headless_shell`)은 넣지 않는다.** `channel: "chromium"` 이면
풀 크로미움 하나로 두 모드가 다 된다. 셸만 넣으면 헤드풀이 안 되고,
SSO·2FA처럼 사람이 직접 로그인해야 하는 대상은 검사조차 할 수 없다.

### 사용자 PC에 없어도 되는 것

- **Node.js** — Electron을 `ELECTRON_RUN_AS_NODE` 로 재사용한다
- **Playwright 브라우저 캐시** — 동봉한 것을 `PLAYWRIGHT_BROWSERS_PATH` 로 가리킨다
- **인터넷** — 설치 직후 오프라인에서 바로 QA를 시작할 수 있다

### 데이터 위치

`qa.db` 와 증적(`runs/`)은 설치 폴더가 아니라 `%APPDATA%` 아래 userData 로 간다.
프로그램 폴더는 쓰기 권한이 없을 수 있고 재설치 때 지워진다.

### 아직 안 한 것

- **코드 서명** — 서명하지 않아 첫 실행 시 SmartScreen 경고가 뜬다
- **아이콘** — Electron 기본 아이콘
