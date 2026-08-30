import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { accessOf, type FileAccess } from "./secrets.js";

/**
 * Project Scanner Agent.
 *
 * 프로젝트 폴더를 훑어 **무엇을 읽을지** 정한다. 여기서 범위를 잘못 잡으면
 * 뒤의 모든 것이 무의미해진다.
 *
 * - `node_modules` 하나가 파일 수를 백 배로 만든다. 예산 없는 스캔은 끝나지 않는다.
 * - 시크릿 파일은 읽는 방식 자체가 다르다(§16-1). 그 판정을 여기서 한 번에 한다.
 */

/** 어떤 경우에도 들어가지 않는 디렉터리. 스캔 대상이 아니라 산출물이다. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".nuxt",
  ".cache",
  "vendor",
]);

/** 읽어도 얻을 것이 없는 확장자. 이미지·폰트·아카이브. */
const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".bmp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".tar", ".gz", ".7z", ".rar", ".jar", ".war", ".class",
  ".pdf", ".mp4", ".mp3", ".wav", ".mov",
  ".lock", ".map", ".min.js",
]);

export type SourceLang = "java" | "kotlin" | "ts" | "js" | "tsx" | "jsx" | "python" | "config" | "other";

export interface ScannedFile {
  /** 프로젝트 루트 기준 상대 경로. 절대 경로는 어디에도 남기지 않는다. */
  path: string;
  bytes: number;
  lang: SourceLang;
  access: FileAccess;
}

export interface ProjectScan {
  rootDir: string;
  files: ScannedFile[];
  /** 자동 판별한 기술 스택 */
  stack: string[];
  /** 예산에 걸려 못 본 것. 조용히 끝내지 않는다. */
  limits: string[];
  totalBytes: number;
  /** 있으면 실행할 수 있었을 명령. Phase 12 의 동의 대상이며 지금은 실행하지 않는다. */
  runnableCommands: Array<{ command: string; from: string; purpose: "build" | "test" | "lint" }>;
}

export interface ScanBudget {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

function langOf(path: string): SourceLang {
  const p = path.toLowerCase();
  if (p.endsWith(".java")) return "java";
  if (p.endsWith(".kt")) return "kotlin";
  if (p.endsWith(".tsx")) return "tsx";
  if (p.endsWith(".jsx")) return "jsx";
  if (p.endsWith(".ts")) return "ts";
  if (p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".cjs")) return "js";
  if (p.endsWith(".py")) return "python";
  if (/\.(ya?ml|json|properties|toml|ini|env|xml|gradle|conf)$/.test(p)) return "config";
  return "other";
}

function extOf(path: string): string {
  const at = path.lastIndexOf(".");
  return at < 0 ? "" : path.slice(at).toLowerCase();
}

/**
 * 기술 스택 판별.
 *
 * 파일 하나로 단정하지 않는다. 존재하는 신호를 모아 목록으로 돌려준다 —
 * 없는 것을 있다고 말하는 쪽이 더 나쁘다.
 */
function detectStack(files: ScannedFile[], read: (p: string) => string): string[] {
  const has = (re: RegExp) => files.some((f) => re.test(f.path.replace(/\\/g, "/")));
  const stack: string[] = [];

  if (has(/(^|\/)build\.gradle(\.kts)?$/)) stack.push("Gradle");
  if (has(/(^|\/)pom\.xml$/)) stack.push("Maven");
  if (has(/(^|\/)requirements\.txt$/) || has(/(^|\/)pyproject\.toml$/)) stack.push("Python");
  if (has(/(^|\/)go\.mod$/)) stack.push("Go");
  if (has(/(^|\/)docker-compose\.ya?ml$/)) stack.push("Docker Compose");
  if (has(/(^|\/)Dockerfile$/)) stack.push("Docker");

  for (const f of files) {
    if (!/(^|\/)build\.gradle(\.kts)?$|(^|\/)pom\.xml$/.test(f.path.replace(/\\/g, "/"))) continue;
    const text = read(f.path);
    if (/spring-boot/.test(text)) stack.push("Spring Boot");
    if (/spring-boot-starter-security/.test(text)) stack.push("Spring Security");
    if (/spring-boot-starter-data-jpa/.test(text)) stack.push("JPA");
    if (/postgresql/.test(text)) stack.push("PostgreSQL");
    if (/mysql|mariadb/.test(text)) stack.push("MySQL");
  }

  for (const f of files) {
    if (!/(^|\/)package\.json$/.test(f.path.replace(/\\/g, "/"))) continue;
    const text = read(f.path);
    if (/"react"/.test(text)) stack.push("React");
    if (/"vue"/.test(text)) stack.push("Vue");
    if (/"next"/.test(text)) stack.push("Next.js");
    if (/"@angular\/core"/.test(text)) stack.push("Angular");
    if (/"express"/.test(text)) stack.push("Express");
    if (/"typescript"/.test(text)) stack.push("TypeScript");
  }
  if (files.some((f) => f.lang === "ts" || f.lang === "tsx")) stack.push("TypeScript");
  if (files.some((f) => f.lang === "java")) stack.push("Java");

  return [...new Set(stack)];
}

/**
 * 실행 가능한 명령을 **찾기만** 한다.
 *
 * Phase 9 는 아무것도 실행하지 않는다(CLAUDE.md §9). 그런데 무엇을 실행할 수 있는지
 * 조차 알려주지 않으면 사용자는 이 도구가 무엇을 건너뛰었는지 모른다.
 * 그래서 목록만 만들고 실행은 Phase 12 의 동의에 맡긴다.
 */
function findCommands(files: ScannedFile[], read: (p: string) => string): ProjectScan["runnableCommands"] {
  const out: ProjectScan["runnableCommands"] = [];

  for (const f of files) {
    const p = f.path.replace(/\\/g, "/");

    if (/(^|\/)package\.json$/.test(p)) {
      let scripts: Record<string, unknown> = {};
      try {
        scripts = (JSON.parse(read(f.path)) as { scripts?: Record<string, unknown> }).scripts ?? {};
      } catch {
        continue;
      }
      for (const name of Object.keys(scripts)) {
        const purpose =
          name === "test" ? "test" : name === "lint" ? "lint" : name === "build" ? "build" : null;
        if (purpose) out.push({ command: `npm run ${name}`, from: f.path, purpose });
      }
    }

    if (/(^|\/)build\.gradle(\.kts)?$/.test(p)) {
      out.push({ command: "./gradlew test", from: f.path, purpose: "test" });
      out.push({ command: "./gradlew build", from: f.path, purpose: "build" });
    }
    if (/(^|\/)pom\.xml$/.test(p)) {
      out.push({ command: "mvn test", from: f.path, purpose: "test" });
    }
  }
  return out;
}

/**
 * Git 이 관리하는 파일 목록.
 *
 * `.gitignore` 를 직접 파싱하지 않는다. 규칙이 생각보다 복잡하고(부정 패턴,
 * 디렉터리 한정, 중첩된 .gitignore), 틀리면 조용히 잘못된 범위를 읽는다.
 * git 에게 물으면 정확하다.
 *
 * 실측에서 이것이 없어 `release/win-unpacked` 안의 **동봉 Chromium 소스**까지
 * 읽고 결함을 보고했다. 남의 코드에서 나온 결함은 잡음이다.
 */
function gitTrackedFiles(rootDir: string): string[] | null {
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const files = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

/** 프로젝트를 훑는다. 예산을 넘으면 멈추고 **넘었다는 사실을 기록한다.** */
export function scanProject(rootDir: string, budget: ScanBudget): ProjectScan {
  const files: ScannedFile[] = [];
  const limits: string[] = [];
  let totalBytes = 0;
  let stopped = false;

  const walk = (dir: string): void => {
    if (stopped) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (stopped) return;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }

      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith(".") && name !== ".github") continue;
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;

      const rel = relative(rootDir, full).split(sep).join("/");
      if (SKIP_EXT.has(extOf(name))) continue;

      if (files.length >= budget.maxFiles) {
        limits.push(`파일 수 상한(${budget.maxFiles}) 소진 — 이후 파일은 보지 않았습니다.`);
        stopped = true;
        return;
      }
      if (st.size > budget.maxFileBytes) {
        limits.push(`${rel} 가 파일 크기 상한을 넘어 건너뛰었습니다 (${Math.round(st.size / 1024)}KB).`);
        continue;
      }
      if (totalBytes + st.size > budget.maxTotalBytes) {
        limits.push(`전체 크기 상한(${Math.round(budget.maxTotalBytes / 1024 / 1024)}MB) 소진 — 이후 파일은 보지 않았습니다.`);
        stopped = true;
        return;
      }

      totalBytes += st.size;
      files.push({ path: rel, bytes: st.size, lang: langOf(rel), access: accessOf(rel) });
    }
  };

  const tracked = gitTrackedFiles(rootDir);
  if (tracked) {
    // git 이 아는 파일만 본다. 무시되는 것(빌드 산출물·동봉 자산)은 애초에 목록에 없다.
    for (const rel of tracked.sort()) {
      if (files.length >= budget.maxFiles) {
        limits.push(`파일 수 상한(${budget.maxFiles}) 소진 — 이후 파일은 보지 않았습니다.`);
        break;
      }
      const parts = rel.split("/");
      if (parts.some((p) => SKIP_DIRS.has(p))) continue;
      if (SKIP_EXT.has(extOf(rel))) continue;

      let st;
      try {
        st = statSync(join(rootDir, rel));
      } catch {
        continue;
      }
      if (st.size > budget.maxFileBytes) continue;
      if (totalBytes + st.size > budget.maxTotalBytes) {
        limits.push(
          `전체 크기 상한(${Math.round(budget.maxTotalBytes / 1024 / 1024)}MB) 소진 — 이후 파일은 보지 않았습니다.`,
        );
        break;
      }
      totalBytes += st.size;
      files.push({ path: rel, bytes: st.size, lang: langOf(rel), access: accessOf(rel) });
    }
  } else {
    // Git 저장소가 아니면 직접 훑는다. 이때는 무시 규칙을 알 수 없다.
    limits.push("Git 저장소가 아니어서 .gitignore 를 적용하지 못했습니다. 빌드 산출물이 섞일 수 있습니다.");
    walk(rootDir);
  }

  const cache = new Map<string, string>();
  const read = (rel: string): string => {
    const hit = cache.get(rel);
    if (hit !== undefined) return hit;
    let text = "";
    try {
      text = readFileSync(join(rootDir, rel), "utf8");
    } catch {
      text = "";
    }
    cache.set(rel, text);
    return text;
  };

  return {
    rootDir,
    files,
    stack: detectStack(files, read),
    limits,
    totalBytes,
    runnableCommands: findCommands(files, read),
  };
}
