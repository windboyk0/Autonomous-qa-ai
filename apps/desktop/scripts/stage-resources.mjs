import { build } from "esbuild";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 설치본에 들어갈 자산을 `resources/` 에 모은다.
 *
 * 사용자 PC에는 Node.js도, pnpm도, Playwright 캐시도 없다고 가정한다.
 * 설치 직후 바로 QA를 시작할 수 있어야 한다 (CLAUDE.md §31).
 *
 * ```
 * resources/
 *   engine/
 *     cli.js            엔진 번들 (playwright만 외부)
 *     node_modules/
 *       playwright, playwright-core
 *   browsers/
 *     chromium-<rev>/   풀 크로미움 — 헤드리스·헤드풀 둘 다 이걸로 돈다
 *     winldd-<rev>/     Windows 의존성 확인용
 * ```
 */

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(appRoot, "..", "..");
const resources = join(appRoot, "resources");

function mb(dir) {
  let total = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else total += st.size;
    }
  };
  if (existsSync(dir)) walk(dir);
  return Math.round(total / 1024 / 1024);
}

// ── 0. 초기화 ────────────────────────────────────────────────────────
rmSync(resources, { recursive: true, force: true });
mkdirSync(join(resources, "engine"), { recursive: true });

// ── 1. 엔진 번들 ─────────────────────────────────────────────────────
// @qa/shared 와 zod 는 인라인한다. playwright 만 외부로 남긴다 —
// 브라우저 프로토콜 파일을 런타임에 자기 위치 기준으로 읽기 때문에 번들에 넣으면 깨진다.
await build({
  entryPoints: [join(repoRoot, "packages/qa-engine/src/cli.ts")],
  outfile: join(resources, "engine/cli.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: false,
  minify: false, // 스택 트레이스가 읽혀야 사용자가 문제를 신고할 수 있다
  external: ["playwright"],
  logLevel: "warning",
});

/**
 * 번들은 CJS인데 `.js` 확장자다.
 *
 * Node는 파일에서 위로 올라가며 가장 가까운 package.json의 `type` 을 본다.
 * 개발 중에는 `apps/desktop/package.json` 의 `"type": "module"` 에 걸려
 * "require is not defined in ES module scope" 로 죽는다(실측).
 * 위치와 무관하게 CJS로 읽히도록 여기에 표식을 박아 둔다.
 */
writeFileSync(
  join(resources, "engine/package.json"),
  JSON.stringify({ name: "qa-engine-bundle", private: true, type: "commonjs" }, null, 2),
);

// ── 2. playwright 패키지 ─────────────────────────────────────────────
const engineModules = join(resources, "engine/node_modules");
mkdirSync(engineModules, { recursive: true });

/**
 * 패키지 디렉터리를 찾는다.
 *
 * `require.resolve("playwright/package.json")` 은 쓸 수 없다 — playwright의
 * `exports` 맵이 `./package.json` 하위경로를 막아 둔다. 그래서 심볼릭 링크를
 * 직접 따라간다. pnpm은 워크스페이스의 node_modules에 스토어로 가는 링크를 만든다.
 */
function packageDir(name) {
  const linked = join(repoRoot, "packages/qa-engine/node_modules", name);
  if (existsSync(linked)) return realpathSync(linked);
  // playwright-core 는 playwright 옆에 있다 (pnpm 스토어의 같은 폴더).
  const sibling = join(dirname(realpathSync(join(repoRoot, "packages/qa-engine/node_modules/playwright"))), name);
  if (existsSync(sibling)) return realpathSync(sibling);
  throw new Error(`${name} 패키지를 찾지 못했습니다. \`pnpm install\` 을 먼저 실행하세요.`);
}

for (const pkg of ["playwright", "playwright-core"]) {
  cpSync(packageDir(pkg), join(engineModules, pkg), {
    recursive: true,
    dereference: true, // pnpm 심볼릭 링크를 실제 파일로 편다
  });
}

// ── 3. 브라우저 ──────────────────────────────────────────────────────
// **풀 크로미움만 넣는다.** 헤드리스 셸은 넣지 않는다:
//  - 셸까지 넣으면 700MB
//  - 셸만 넣으면 헤드풀이 안 되고, SSO·2FA 대상은 검사조차 못 한다
//  - 실측상 셸과 풀 크로미움의 레이아웃 계측값은 동일하다
const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
if (!existsSync(cache)) {
  throw new Error(
    `Playwright 브라우저 캐시를 찾지 못했습니다: ${cache}\n` +
      `먼저 \`pnpm exec playwright install chromium\` 을 실행하세요.`,
  );
}

const browsers = join(resources, "browsers");
mkdirSync(browsers, { recursive: true });

const wanted = readdirSync(cache).filter(
  (name) => /^chromium-\d+$/.test(name) || /^winldd-\d+$/.test(name),
);
if (!wanted.some((n) => n.startsWith("chromium-"))) {
  throw new Error(`${cache} 에 chromium-<rev> 폴더가 없습니다. \`playwright install chromium\` 을 실행하세요.`);
}
for (const name of wanted) {
  cpSync(join(cache, name), join(browsers, name), { recursive: true, dereference: true });
}

// Playwright가 캐시 디렉터리로 인식하도록 표식을 남긴다.
writeFileSync(join(browsers, ".links"), "");

console.log(`[stage] engine   ${mb(join(resources, "engine"))} MB`);
console.log(`[stage] browsers ${mb(browsers)} MB (${wanted.join(", ")})`);
console.log(`[stage] 합계     ${mb(resources)} MB`);
