import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractSpringEndpoints, type ExtractedEndpoint } from "./endpoints.js";
import type { ProjectScan } from "./scan.js";

/**
 * Git Change Impact Agent.
 *
 * "이번에 바뀐 코드가 어느 화면에 닿는가"를 먼저 본다.
 *
 * 이것을 Root Cause(Phase 11)보다 앞에 둔 이유가 있다. 매퍼의 **약한 버전을
 * 싼값에 검증**할 수 있기 때문이다. 여기서 매핑이 부정확하면 그 위에 얹는
 * 원인 추적은 애초에 성립하지 않으므로 미리 걸러진다.
 * 덤으로 실행 시간이 줄어든다 — 실측에서 전체 탐색이 243초였다.
 */

export interface ChangedFiles {
  /** 프로젝트 루트 기준 상대 경로 */
  files: string[];
  /** 무엇과 비교했는가. 리포트에 그대로 적는다. */
  comparedWith: string;
  /** git을 쓸 수 없었던 이유. 있으면 files는 비어 있다. */
  error: string | null;
}

function git(rootDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
}

/**
 * 바뀐 파일 목록.
 *
 * 기본은 **아직 커밋하지 않은 변경**이다. 지금 고치고 있는 것을 바로 확인하는 것이
 * 이 기능의 쓸모이기 때문이다. 작업 트리가 깨끗하면 마지막 커밋으로 물러선다 —
 * 아무것도 못 찾았다고 조용히 끝내면 사용자는 기능이 고장 난 줄 안다.
 */
export function gitChangedFiles(rootDir: string, base = ""): ChangedFiles {
  try {
    git(rootDir, ["rev-parse", "--is-inside-work-tree"]);
  } catch (err) {
    /*
     * git 이 **깔려 있지 않은 것**과 폴더가 저장소가 **아닌 것**은 다른 문제고
     * 해결책도 다르다. 둘 다 "저장소가 아닙니다"라고 하면 사용자는 git 이 없는
     * PC 에서 `git init` 을 하게 된다.
     */
    const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    return {
      files: [],
      comparedWith: "",
      error: missing
        ? "이 PC 에 git 이 없습니다. git 을 설치하면 변경 범위를 비교할 수 있습니다."
        : "Git 저장소가 아닙니다.",
    };
  }

  const norm = (out: string): string[] =>
    [...new Set(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];

  if (base.trim() !== "") {
    try {
      return {
        files: norm(git(rootDir, ["diff", "--name-only", `${base}...HEAD`])),
        comparedWith: base,
        error: null,
      };
    } catch (err) {
      return { files: [], comparedWith: base, error: `기준 ${base} 과 비교하지 못했습니다: ${String(err)}` };
    }
  }

  try {
    /*
     * 포슬린 형식은 `XY path` 이고 **X 는 공백일 수 있다**
     * (스테이징하지 않은 수정은 ` M path`).
     * 줄을 먼저 trim 하면 그 공백이 사라져 경로가 한 글자 깎인다 — 실측에서 걸렸다.
     * 그러므로 자리를 자른 **뒤에** 정리한다.
     */
    const dirty = git(rootDir, ["status", "--porcelain"])
      .split(/\r?\n/)
      .filter((l) => l.length > 3)
      .map((l) => {
        const path = l.slice(3).trim();
        const arrow = path.indexOf(" -> ");
        return arrow < 0 ? path : path.slice(arrow + 4);
      })
      .filter(Boolean);
    if (dirty.length > 0) {
      return { files: dirty.map((p) => p.replace(/^"|"$/g, "")), comparedWith: "커밋하지 않은 변경", error: null };
    }
  } catch {
    /* 아래 폴백으로 간다 */
  }

  try {
    return {
      files: norm(git(rootDir, ["diff", "--name-only", "HEAD~1", "HEAD"])),
      comparedWith: "마지막 커밋",
      error: null,
    };
  } catch {
    return { files: [], comparedWith: "", error: "비교할 이전 커밋이 없습니다." };
  }
}

export interface ChangeImpact {
  changed: ChangedFiles;
  /** 바뀐 코드가 닿는 엔드포인트 */
  endpoints: ExtractedEndpoint[];
  /** 바뀐 프런트엔드 파일이 부르는 API 경로 */
  apiPaths: string[];
  /** 화면 URL 을 고를 때 쓰는 힌트 낱말 */
  hints: string[];
  /** 왜 이 결론인지. 추정을 사실처럼 말하지 않기 위해 근거를 같이 남긴다. */
  notes: string[];
}

const FETCH_PATH = /["'`](\/[a-zA-Z0-9_\-/]*)["'`+]/g;

/** 경로에서 의미 있는 낱말만 뽑는다. `/api/users?x=1` → `users` */
function tokensOf(path: string): string[] {
  return path
    .split(/[/?#&=.]/)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length >= 3 && !["api", "v1", "v2", "www", "com", "src", "app"].includes(s));
}

/**
 * 바뀐 파일 → 엔드포인트 → 힌트.
 *
 * **호출 그래프를 만들지 않는다.** 컨트롤러는 어노테이션으로 확정하고,
 * 서비스·리포지터리가 바뀌었을 때는 **그 클래스 이름을 언급하는 컨트롤러**를
 * 찾는 데까지만 간다. 그 이상은 컴파일러 없이 정확할 수 없다.
 */
export function computeImpact(rootDir: string, scan: ProjectScan, changed: ChangedFiles): ChangeImpact {
  const notes: string[] = [];
  if (changed.error) notes.push(changed.error);

  const changedSet = new Set(changed.files);
  const read = (rel: string): string => {
    try {
      return readFileSync(join(rootDir, rel), "utf8");
    } catch {
      return "";
    }
  };

  const controllers = scan.files.filter(
    (f) => f.lang === "java" && f.access === "read" && /controller/i.test(f.path),
  );

  const endpoints: ExtractedEndpoint[] = [];

  // 1. 바뀐 컨트롤러 — 확정이다.
  for (const f of controllers) {
    if (!changedSet.has(f.path)) continue;
    endpoints.push(...extractSpringEndpoints(f.path, read(f.path)));
  }

  // 2. 바뀐 서비스·리포지터리를 **이름으로 언급하는** 컨트롤러 — 추정이다.
  const changedJvmTypes = changed.files
    .filter((p) => /\.(java|kt)$/.test(p) && !/controller/i.test(p))
    .map((p) => p.split("/").pop()!.replace(/\.(java|kt)$/, ""));

  if (changedJvmTypes.length > 0) {
    for (const f of controllers) {
      if (changedSet.has(f.path)) continue;
      const text = read(f.path);
      const hit = changedJvmTypes.find((t) => new RegExp(`\\b${t}\\b`).test(text));
      if (!hit) continue;
      notes.push(`${f.path} 는 바뀐 ${hit} 을 참조합니다 (이름 일치로 추정).`);
      endpoints.push(...extractSpringEndpoints(f.path, read(f.path)));
    }
  }

  // 3. 바뀐 프런트엔드 파일이 부르는 경로
  const apiPaths = new Set<string>();
  for (const p of changed.files) {
    if (!/\.(ts|tsx|js|jsx|vue)$/.test(p)) continue;
    const text = read(p);
    let m: RegExpExecArray | null;
    const rx = new RegExp(FETCH_PATH.source, "g");
    while ((m = rx.exec(text)) !== null) {
      const path = m[1]!;
      if (path.length > 1) apiPaths.add(path);
    }
  }

  const hints = new Set<string>();
  for (const e of endpoints) for (const t of tokensOf(e.path)) hints.add(t);
  for (const p of apiPaths) for (const t of tokensOf(p)) hints.add(t);
  // 화면 파일 이름 자체도 힌트가 된다. UserList.tsx → user, list
  for (const p of changed.files) {
    if (!/\.(tsx|jsx|vue)$/.test(p)) continue;
    const base = p.split("/").pop()!.replace(/\.[a-z]+$/i, "");
    for (const w of base.split(/(?=[A-Z])/)) {
      const t = w.toLowerCase();
      if (t.length >= 3) hints.add(t);
    }
  }

  if (changed.files.length > 0 && endpoints.length === 0 && apiPaths.size === 0) {
    notes.push(
      "바뀐 파일에서 엔드포인트나 API 호출을 찾지 못했습니다. 탐색 순서를 조정하지 않습니다.",
    );
  }

  return {
    changed,
    endpoints: [...new Map(endpoints.map((e) => [`${e.method} ${e.path}`, e])).values()],
    apiPaths: [...apiPaths],
    hints: [...hints],
    notes,
  };
}

/**
 * URL 하나가 이번 변경에 얼마나 닿아 보이는가. 높을수록 먼저 본다.
 *
 * **이것은 추정이다.** 그래서 탐색 대상을 줄이지 않고 **순서만** 바꾼다.
 * 잘못 추정해도 잃는 것은 순서뿐이고, 예산이 남는 한 나머지도 전부 본다.
 */
export function impactScore(url: string, hints: readonly string[]): number {
  if (hints.length === 0) return 0;
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = url.toLowerCase();
  }
  return hints.reduce((acc, h) => (path.includes(h) ? acc + 1 : acc), 0);
}
