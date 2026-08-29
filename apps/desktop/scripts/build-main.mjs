import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * main 프로세스 번들링.
 *
 * **왜 번들링하는가**
 * Electron의 `electron` 모듈은 런타임이 `require`에 심어주는 내장 모듈이다.
 * 그런데 `node_modules/electron` 에는 실행 파일 경로만 문자열로 내보내는 npm 셸이 있고,
 * ESM 해석기는 그쪽을 먼저 찾는다. 그래서 ESM main에서는 `import { app } from "electron"`
 * 도, `createRequire("electron")` 도 전부 문자열을 돌려받는다 (실측 확인).
 *
 * CJS로 내보내면 Electron이 패치한 `require`가 내장 모듈을 정확히 준다.
 * 다만 `@qa/shared` 는 ESM이라 CJS에서 그냥 require할 수 없으므로, 번들에 인라인한다.
 * Phase 7 패키징에서도 어차피 필요한 단계다.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const common = {
  bundle: true,
  platform: "node",
  target: "node20", // Electron 33이 품은 Node
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
  // electron: 런타임이 주입한다.
  // node-sqlite3-wasm: .wasm 파일을 옆에 두고 읽으므로 번들에 넣으면 안 된다.
  external: ["electron", "node-sqlite3-wasm"],
};

await build({
  ...common,
  entryPoints: [join(root, "electron/main.ts")],
  outfile: join(root, "dist/electron/main.cjs"),
});

await build({
  ...common,
  entryPoints: [join(root, "electron/preload.ts")],
  outfile: join(root, "dist/electron/preload.cjs"),
});

console.log("[desktop] main.cjs / preload.cjs 생성 완료");
