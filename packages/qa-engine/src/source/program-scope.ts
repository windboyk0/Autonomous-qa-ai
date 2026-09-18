import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProgramScopeConfig } from "@qa/shared";
import { computeImpact, explicitChangedFiles } from "./change-impact.js";
import type { ProjectScan } from "./scan.js";

/**
 * Program Scope Agent (CLAUDE.md 4부, Phase 18~19).
 *
 * 소스 파일 경로 목록 → 연관 엔드포인트(§2.3, `computeImpact` 재사용) → 연관 화면(§2.4, 안 A)
 * 까지 잇는다. **호출 그래프를 만들지 않는다** — 화면이 어느 API를 부르는지는 과거
 * 전체 탐색(베이스라인) Run이 실제로 관측한 사실만 믿는다.
 *
 * 베이스라인이 없으면 매핑할 수 없다. 그 경우 대상을 줄이지 않고(§2.4 "확대 해석하지
 * 않는다"), 이번 Run이 다음 부분 검수의 기준이 된다는 사실을 그대로 알린다.
 */

export interface BaselineScreen {
  stateKey: string;
  screenName: string;
  /** 빈 문자열이면(앱 QA 등 URL이 없는 상태) 시드로 쓸 수 없다. */
  url: string;
  pathTemplate: string;
  /** 이 화면을 방문하는 동안 관측된 "METHOD 엔드포인트템플릿" 목록 */
  endpoints: string[];
}

interface GraphJson {
  nodes: Array<{
    stateKey: string;
    screenName: string;
    url: string;
    signals: { pathTemplate: string };
  }>;
}

interface EvidenceIndexJson {
  evidences: Array<{ kind: string; stateKey: string; path: string | null }>;
}

/**
 * `outDir` 아래에서 그래프·증적 색인을 모두 가진 가장 최근 Run을 찾는다.
 *
 * `runId`는 `makeRunId()`가 만드는 `yyyyMMdd_HHmmss`라 문자열 정렬이 곧 시간 순이다.
 */
export function findBaselineRun(outDir: string, excludeRunId?: string): { runId: string; runDir: string } | null {
  let entries: string[];
  try {
    entries = readdirSync(outDir);
  } catch {
    return null;
  }

  const candidates = entries
    .filter((name) => name !== excludeRunId)
    .filter((name) => {
      const dir = join(outDir, name);
      return existsSync(join(dir, "actions", "graph.json")) && existsSync(join(dir, "evidence.json"));
    })
    .sort();

  const runId = candidates.at(-1);
  if (!runId) return null;
  return { runId, runDir: join(outDir, runId) };
}

/** 베이스라인 Run의 화면·엔드포인트 관측 사실을 읽는다. 못 읽으면 빈 배열 — 억지로 만들지 않는다. */
export function loadBaselineScreens(runDir: string): BaselineScreen[] {
  let graph: GraphJson;
  try {
    graph = JSON.parse(readFileSync(join(runDir, "actions", "graph.json"), "utf8")) as GraphJson;
  } catch {
    return [];
  }

  let index: EvidenceIndexJson;
  try {
    index = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as EvidenceIndexJson;
  } catch {
    index = { evidences: [] };
  }

  const endpointsByState = new Map<string, Set<string>>();
  for (const ev of index.evidences) {
    if (ev.kind !== "network" || !ev.path) continue;
    try {
      const entries = JSON.parse(readFileSync(join(runDir, ev.path), "utf8")) as Array<{
        method: string;
        endpointTemplate: string;
      }>;
      const set = endpointsByState.get(ev.stateKey) ?? new Set<string>();
      for (const e of entries) set.add(`${e.method.toUpperCase()} ${e.endpointTemplate}`);
      endpointsByState.set(ev.stateKey, set);
    } catch {
      /* 못 읽으면 그 화면은 엔드포인트 정보 없이 넘어간다 */
    }
  }

  return graph.nodes.map((n) => ({
    stateKey: n.stateKey,
    screenName: n.screenName,
    url: n.url,
    pathTemplate: n.signals.pathTemplate,
    endpoints: [...(endpointsByState.get(n.stateKey) ?? [])],
  }));
}

export interface MappedScreen {
  screenName: string;
  url: string;
  confidence: number;
  matchedVia: string;
}

export interface ProgramScopeResult {
  inputFiles: string[];
  /** 시드로 쓸 URL. 탐색 큐를 이 목록으로만 초기화한다. */
  seedUrls: string[];
  /** 허용된 화면의 path 템플릿. depth-0 제한 판정에 쓴다. */
  allowedPathTemplates: Set<string>;
  mappedScreens: MappedScreen[];
  /** 매핑하지 못한 엔드포인트. "확대 해석하지 않는다" — 미검증으로만 남긴다. */
  unmatchedEndpoints: string[];
  baselineFound: boolean;
  baselineRunId: string | null;
  notes: string[];
}

function readFileList(path: string): { files: string[]; error: string | null } {
  if (path.trim() === "") return { files: [], error: null };
  try {
    const files = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return { files, error: null };
  } catch (err) {
    return { files: [], error: `프로그램 목록 파일을 읽지 못했습니다 (${path}): ${String(err)}` };
  }
}

export function mapProgramScope(input: {
  rootDir: string;
  scan: ProjectScan;
  cfg: ProgramScopeConfig;
  baseline: BaselineScreen[] | null;
  baselineRunId: string | null;
}): ProgramScopeResult {
  const notes: string[] = [];
  const listed = readFileList(input.cfg.sourceFilesListPath);
  if (listed.error) notes.push(listed.error);

  const inputFiles = [...new Set([...input.cfg.sourceFiles, ...listed.files])];

  const changed = explicitChangedFiles(input.rootDir, inputFiles);
  if (changed.error) notes.push(changed.error);

  const impact = computeImpact(input.rootDir, input.scan, changed);
  notes.push(...impact.notes);

  const endpointKeys = new Set(impact.endpoints.map((e) => `${e.method.toLowerCase()} ${e.path.toLowerCase()}`));
  const pathOnlyKeys = new Set(impact.endpoints.map((e) => e.path.toLowerCase()));

  if (!input.baseline) {
    return {
      inputFiles,
      seedUrls: [],
      allowedPathTemplates: new Set(),
      mappedScreens: [],
      unmatchedEndpoints: [...endpointKeys],
      baselineFound: false,
      baselineRunId: null,
      notes: [
        ...notes,
        "베이스라인(과거 전체 탐색) 결과가 없어 매핑할 수 없습니다. 이번 Run은 전체 탐색으로 진행하고, " +
          "이 결과가 다음 부분 검수의 기준(베이스라인)이 됩니다.",
      ],
    };
  }

  const mappedScreens: MappedScreen[] = [];
  const seedUrls: string[] = [];
  const allowedPathTemplates = new Set<string>();
  const matchedEndpointKeys = new Set<string>();

  for (const screen of input.baseline) {
    let confidence = 0;
    let via = "";
    for (const raw of screen.endpoints) {
      const key = raw.toLowerCase();
      if (endpointKeys.has(key)) {
        confidence = Math.max(confidence, 1);
        via = "엔드포인트 정확히 일치";
        matchedEndpointKeys.add(key);
        continue;
      }
      const pathOnly = key.split(" ").slice(1).join(" ");
      if (pathOnlyKeys.has(pathOnly) && confidence < 0.8) {
        confidence = 0.8;
        via = via || "경로 일치 (메서드 다름)";
      }
    }
    if (confidence === 0 && impact.hints.length > 0) {
      const haystack = `${screen.url} ${screen.screenName} ${screen.pathTemplate}`.toLowerCase();
      if (impact.hints.some((h) => haystack.includes(h))) {
        confidence = 0.5;
        via = "낱말 힌트 일치 (추정)";
      }
    }

    if (confidence >= input.cfg.minConfidence) {
      mappedScreens.push({ screenName: screen.screenName, url: screen.url, confidence, matchedVia: via });
      if (screen.url.trim() !== "") {
        seedUrls.push(screen.url);
        allowedPathTemplates.add(screen.pathTemplate);
      }
    }
  }

  const unmatchedEndpoints = [...endpointKeys].filter((k) => !matchedEndpointKeys.has(k));
  if (mappedScreens.length === 0) {
    notes.push(
      "입력한 프로그램 목록에 대응하는 화면을 베이스라인에서 찾지 못했습니다. " +
        "확대 해석하지 않고 미검증으로 남깁니다.",
    );
  }

  return {
    inputFiles,
    seedUrls: [...new Set(seedUrls)],
    allowedPathTemplates,
    mappedScreens,
    unmatchedEndpoints,
    baselineFound: true,
    baselineRunId: input.baselineRunId,
    notes,
  };
}
