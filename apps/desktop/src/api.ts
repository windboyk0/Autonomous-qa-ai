import type { EngineEvent, Issue, RunConfig, RunSummary } from "@qa/shared";
import type { ProjectRow, RunRow } from "./store.js";

/**
 * preload가 노출한 API의 타입.
 *
 * 렌더러가 쓸 수 있는 것은 여기 적힌 것뿐이다.
 * **자격증명을 읽는 경로는 없다** — 저장 여부(`hasPassword`)만 알 수 있다.
 */

export type RunLifecycle =
  | { type: "started"; runPk: number }
  | { type: "event"; event: EngineEvent }
  | { type: "engine-noise"; text: string }
  | {
      type: "exited";
      code: number | null;
      signal: string | null;
      /** 엔진이 아무 말도 없이 죽었는가. 로그인 실패 같은 판정 결과는 크래시가 아니다. */
      crashed: boolean;
      /** 엔진이 알린 종료 사유. 크래시면 null. */
      reason: string | null;
      /** 증적 폴더. 실패해도 증적은 대개 남아 있다. */
      runDir: string | null;
    };

export interface Preflight {
  credentials: { available: boolean; reason: string | null };
  enginePath: string | null;
  engineError: string | null;
  running: boolean;
}

export interface QaApi {
  projects: {
    list(): Promise<ProjectRow[]>;
    get(id: number): Promise<{ project: ProjectRow | null; config: Partial<RunConfig> }>;
    save(input: {
      id: number | null;
      name: string;
      targetUrl: string;
      startPath: string;
      username: string;
      password: string | null;
      config: Partial<RunConfig>;
    }): Promise<number>;
    remove(id: number): Promise<void>;
  };
  dialog: {
    pickFolder(): Promise<{ ok: boolean; dir: string | null }>;
  };
  ai: {
    ollamaModels(baseUrl: string): Promise<{
      ok: boolean;
      models: Array<{ name: string; sizeGb: number | null }>;
      error: string | null;
    }>;
  };
  run: {
    preflight(): Promise<Preflight>;
    start(input: {
      projectId: number;
      config: RunConfig;
      password?: string;
      savePassword?: boolean;
    }): Promise<{ ok: boolean; error?: string }>;
    pause(): Promise<boolean>;
    resume(): Promise<boolean>;
    stop(): Promise<boolean>;
  };
  runs: {
    list(projectId?: number): Promise<RunRow[]>;
    detail(runPk: number): Promise<{ summary: RunSummary | null; issues: Issue[] }>;
    report(runDir: string): Promise<string | null>;
    evidence(
      runDir: string,
      relPath: string,
    ): Promise<{ kind: "image"; dataUrl: string } | { kind: "text"; text: string } | null>;
    openFolder(runDir: string): Promise<void>;
  };
  onRun(handler: (message: RunLifecycle) => void): () => void;
}

declare global {
  interface Window {
    qa: QaApi;
  }
}

export const qa = (): QaApi => window.qa;
