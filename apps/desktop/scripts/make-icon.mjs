import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createRequire } from "node:module";

/**
 * 아이콘 만들기 실행기.
 *
 * 진짜 일은 `make-icon.cjs` 가 Electron 런타임 안에서 한다. 이 파일은 그것을
 * **올바른 환경으로** 띄우는 것만 한다.
 *
 * 왜 한 겹 더 두는가: `ELECTRON_RUN_AS_NODE` 가 켜져 있으면 electron 이 평범한
 * node 로 동작해서 `require("electron")` 이 API 대신 실행 파일 경로 문자열을
 * 준다. 그러면 `nativeImage` 가 undefined 가 되고 빌드가 아이콘 단계에서 죽는다.
 * 이 변수는 엔진을 자식 프로세스로 띄울 때 쓰므로 개발 셸에 남아 있기 쉽다 —
 * 실측에서 빌드를 두 번 깨뜨렸다. 환경에 기대지 않고 여기서 지우고 띄운다.
 */

const require = createRequire(import.meta.url);
const electron = require("electron"); // 여기서는 경로 문자열이 맞다.
const script = resolve(import.meta.dirname, "make-icon.cjs");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const res = spawnSync(electron, [script], { stdio: "inherit", env, windowsHide: true });
process.exit(res.status ?? 1);
