import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ipcMain, shell, type BrowserWindow } from "electron";
import { RunConfig, type EngineEvent, type Issue, type RunSummary } from "@qa/shared";
import { EngineProcess, resolveEnginePath } from "./engine.js";
import { credentialStatus, decryptPassword, encryptPassword } from "./credentials.js";
import type { ProjectRow, RunRow, Store } from "./store.js";

/**
 * IPC 계층.
 *
 * 렌더러 ↔ main 사이의 유일한 통로다. **새 통신 규약을 만들지 않는다** —
 * 엔진이 흘리는 `EngineEvent`를 그대로 중계하고, 나머지는 저장소 CRUD다.
 *
 * 렌더러는 파일시스템에도 자식 프로세스에도 직접 닿지 않는다.
 */

export interface StartRunInput {
  projectId: number;
  config: RunConfig;
  /** 화면에서 방금 입력한 비밀번호. 없으면 저장된 자격증명을 쓴다. */
  password?: string;
  /** 방금 입력한 비밀번호를 저장할지. */
  savePassword?: boolean;
}

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

export class IpcLayer {
  private readonly engine = new EngineProcess();
  private currentRunPk: number | null = null;
  private currentRunDir: string | null = null;
  private lastSummary: RunSummary | null = null;
  private lastIssues: Issue[] = [];
  private currentRunId: string | null = null;
  /** 엔진이 `run:finished`를 보냈는가. */
  private sawFinish = false;
  /**
   * 엔진이 마지막으로 알린 종료 상태와 사유.
   *
   * **로그인 실패는 크래시가 아니다.** 엔진이 스스로 판단해 `FAILED` 를 보내고
   * 증적까지 남긴 뒤 종료 코드 1로 끝낸다. 이걸 "비정상 종료"로 표시하면
   * 사용자는 프로그램이 깨진 줄 알고 진짜 원인(로그인 실패)을 놓친다.
   */
  private lastStatus: { status: string; message: string } | null = null;

  constructor(
    private readonly store: Store,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly workspaceRoot: string,
  ) {}

  private push(message: RunLifecycle): void {
    this.getWindow()?.webContents.send("qa:run", message);
  }

  register(): void {
    // ── 프로젝트 ──────────────────────────────────────────────────────
    ipcMain.handle("projects:list", (): ProjectRow[] => this.store.listProjects());

    ipcMain.handle("projects:get", (_e, id: number) => ({
      project: this.store.getProject(id),
      config: this.store.getProjectConfig(id),
    }));

    ipcMain.handle("projects:save", (_e, input: {
      id: number | null;
      name: string;
      targetUrl: string;
      startPath: string;
      username: string;
      password: string | null;
      config: Partial<RunConfig>;
    }) => {
      // password === null 이면 기존 자격증명 유지, "" 면 삭제.
      const passwordEnc =
        input.password === null
          ? null
          : input.password === ""
            ? new Uint8Array(0)
            : (encryptPassword(input.password) ?? new Uint8Array(0));

      if (input.id === null) {
        return this.store.createProject({
          name: input.name,
          targetUrl: input.targetUrl,
          startPath: input.startPath,
          username: input.username,
          passwordEnc: passwordEnc && passwordEnc.length > 0 ? passwordEnc : null,
          config: input.config,
        });
      }
      this.store.updateProject(input.id, {
        name: input.name,
        targetUrl: input.targetUrl,
        startPath: input.startPath,
        username: input.username,
        passwordEnc,
        config: input.config,
      });
      return input.id;
    });

    ipcMain.handle("projects:delete", (_e, id: number) => {
      this.store.deleteProject(id);
    });

    // ── 실행 ──────────────────────────────────────────────────────────
    ipcMain.handle("run:preflight", () => {
      const credentials = credentialStatus();
      let enginePath: string | null = null;
      let engineError: string | null = null;
      try {
        enginePath = resolveEnginePath();
      } catch (err) {
        engineError = err instanceof Error ? err.message : String(err);
      }
      return { credentials, enginePath, engineError, running: this.engine.running };
    });

    /**
     * 설치된 Ollama 모델 목록.
     *
     * 렌더러는 CSP(`default-src 'self'`)에 막혀 외부로 요청할 수 없다.
     * main이 대신 물어보고 결과만 넘긴다 — 렌더러에 네트워크 권한을 주지 않는다.
     */
    ipcMain.handle("ai:ollamaModels", async (_e, baseUrl: string) => {
      try {
        const res = await fetch(new URL("/api/tags", baseUrl).toString(), {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return { ok: false as const, models: [], error: `HTTP ${res.status}` };
        const body = (await res.json()) as { models?: Array<{ name: string; size?: number }> };
        const models = (body.models ?? []).map((m) => ({
          name: m.name,
          // 화면에 크기를 같이 보여주면 어떤 모델을 고를지 판단하기 쉽다.
          sizeGb: m.size ? Math.round((m.size / 1024 ** 3) * 10) / 10 : null,
        }));
        return { ok: true as const, models, error: null };
      } catch (err) {
        return {
          ok: false as const,
          models: [],
          error:
            err instanceof Error && /timeout|abort/i.test(err.message)
              ? "Ollama가 응답하지 않습니다. 실행 중인지 확인하세요."
              : `Ollama에 연결할 수 없습니다 (${baseUrl}).`,
        };
      }
    });

    ipcMain.handle("run:start", (_e, input: StartRunInput) => this.startRun(input));
    ipcMain.handle("run:pause", () => this.engine.pause());
    ipcMain.handle("run:resume", () => this.engine.resume());
    ipcMain.handle("run:stop", () => {
      this.engine.stop();
      return true;
    });

    // ── 결과 조회 ─────────────────────────────────────────────────────
    ipcMain.handle("runs:list", (_e, projectId?: number): RunRow[] => this.store.listRuns(projectId));

    ipcMain.handle("runs:detail", (_e, runPk: number) => ({
      summary: this.store.getRunSummary(runPk),
      issues: this.store.listIssues(runPk),
    }));

    ipcMain.handle("runs:report", (_e, runDir: string) => this.readRunFile(runDir, "report.md"));

    /** 스크린샷 등 증적 파일. data URL로 돌려줘 렌더러가 파일시스템에 닿지 않게 한다. */
    ipcMain.handle("runs:evidence", (_e, runDir: string, relPath: string) => {
      const full = this.safeJoin(runDir, relPath);
      if (!full || !existsSync(full)) return null;
      if (/\.png$/i.test(relPath)) {
        return { kind: "image" as const, dataUrl: `data:image/png;base64,${readFileSync(full).toString("base64")}` };
      }
      return { kind: "text" as const, text: readFileSync(full, "utf8").slice(0, 200_000) };
    });

    ipcMain.handle("runs:openFolder", (_e, runDir: string) => {
      const full = this.safeJoin(runDir, ".");
      if (full) void shell.openPath(full);
    });
  }

  /**
   * 경로 탈출 방지.
   * 렌더러가 보낸 상대경로를 그대로 붙이면 `../../` 로 아무 파일이나 읽을 수 있다.
   */
  private safeJoin(runDir: string, relPath: string): string | null {
    const base = resolve(this.workspaceRoot, runDir);
    if (!base.startsWith(resolve(this.workspaceRoot))) return null;
    const full = resolve(base, relPath);
    return full.startsWith(base) ? full : null;
  }

  private readRunFile(runDir: string, name: string): string | null {
    const full = this.safeJoin(runDir, name);
    if (!full || !existsSync(full)) return null;
    return readFileSync(full, "utf8");
  }

  private startRun(input: StartRunInput): { ok: boolean; error?: string } {
    if (this.engine.running) return { ok: false, error: "이미 실행 중인 Run이 있습니다." };

    const parsed = RunConfig.safeParse(input.config);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
      };
    }
    const config = parsed.data;

    if (config.crud.delete && !config.crud.deleteConsent) {
      return { ok: false, error: "삭제 테스트는 별도 동의 없이 실행할 수 없습니다." };
    }

    // 비밀번호: 방금 입력한 것 > 저장된 것.
    let password = input.password ?? "";
    if (!password && config.login.enabled) {
      password = decryptPassword(this.store.getPasswordEnc(input.projectId));
    }
    if (input.password && input.savePassword) {
      const enc = encryptPassword(input.password);
      const project = this.store.getProject(input.projectId);
      if (enc && project) {
        this.store.updateProject(input.projectId, {
          name: project.name,
          targetUrl: project.targetUrl,
          startPath: project.startPath,
          username: config.login.username,
          passwordEnc: enc,
          config: this.store.getProjectConfig(input.projectId),
        });
      }
    }

    const runPk = this.store.startRun(input.projectId, "(대기)", new Date().toISOString());
    this.currentRunPk = runPk;
    this.currentRunDir = null;
    this.lastSummary = null;
    this.lastIssues = [];
    this.sawFinish = false;
    this.lastStatus = null;
    this.currentRunId = null;

    try {
      this.engine.start(config, password, this.workspaceRoot, {
        onEvent: (event) => this.onEngineEvent(event, config),
        onRawLine: (text) => this.push({ type: "engine-noise", text }),
        onStderr: (text) => this.push({ type: "engine-noise", text }),
        onExit: (code, signal) => this.onExit(code, signal),
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.store.failRun(runPk, "FAILED");
      this.currentRunPk = null;
      return { ok: false, error };
    }

    this.push({ type: "started", runPk });
    return { ok: true };
  }

  private onEngineEvent(event: EngineEvent, config: RunConfig): void {
    if (event.type === "run:status") {
      this.currentRunId = event.runId;
      this.currentRunDir = join(config.outDir, event.runId);
      if (event.status !== "RUNNING" && event.status !== "PENDING") {
        this.lastStatus = { status: event.status, message: event.message };
      }
    }
    if (event.type === "run:finished") {
      this.sawFinish = true;
      this.lastSummary = event.summary;
      this.currentRunDir = join(config.outDir, event.summary.runId);
    }
    if (event.type === "issue:found") {
      this.lastIssues.push(event.issue);
    }
    this.push({ type: "event", event });
  }

  /**
   * 엔진 종료 처리.
   *
   * **여기서 절대 예외를 던지지 않는다.** 엔진이 어떻게 죽든 Electron은 살아 있어야 한다
   * (CLAUDE.md §24). 결과를 못 받았으면 크래시로 기록하고 화면에 알린다.
   */
  private onExit(code: number | null, signal: string | null): void {
    const runPk = this.currentRunPk;

    /**
     * 크래시는 **엔진이 아무 말도 없이 죽은 경우만**이다.
     * `run:finished` 를 받았거나, 엔진이 스스로 FAILED/STOPPED 를 알렸다면
     * 그건 판정 결과이지 프로그램 오류가 아니다.
     */
    const crashed = !this.sawFinish && this.lastStatus === null;
    const reason = this.lastStatus?.message ?? null;

    try {
      if (runPk !== null) {
        if (this.lastSummary) {
          this.store.finishRun(runPk, this.lastSummary, this.currentRunDir ?? "", this.lastIssues);
        } else {
          this.store.failRun(runPk, this.lastStatus?.status ?? "FAILED", {
            runId: this.currentRunId ?? undefined,
            // 증적은 남아 있다. 폴더를 열 수 있어야 원인을 확인한다.
            runDir: this.currentRunDir ?? undefined,
            reason:
              reason ??
              `엔진이 아무 결과도 남기지 못하고 종료했습니다 (종료 코드 ${code ?? "?"}${signal ? `, ${signal}` : ""}).`,
          });
        }
      }
    } catch {
      /* 저장 실패가 UI를 죽이면 안 된다 */
    }

    this.currentRunPk = null;
    this.push({
      type: "exited",
      code,
      signal,
      crashed,
      reason,
      runDir: this.currentRunDir,
    });
  }

  dispose(): void {
    this.engine.kill();
  }
}
