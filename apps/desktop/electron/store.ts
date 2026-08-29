import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "node-sqlite3-wasm";
import type { Issue, RunConfig, RunSummary } from "@qa/shared";

/**
 * 로컬 저장소 (CLAUDE.md §20).
 *
 * **비밀번호와 토큰은 여기에 평문으로 들어가지 않는다.** 자격증명은
 * `credentials.ts`가 Electron `safeStorage`로 암호화한 뒤 BLOB으로만 넣는다.
 *
 * 구현체로 WASM SQLite를 쓴다: Electron 33은 Node 20을 품고 있어 `node:sqlite`가
 * 없고, 네이티브 모듈(better-sqlite3)은 Electron ABI에 맞춰 다시 빌드해야 해서
 * 사용자 PC마다 빌드 도구가 필요해진다. 설치본 하나로 끝나야 하는 제품에 맞지 않는다.
 */

export interface ProjectRow {
  id: number;
  name: string;
  targetUrl: string;
  startPath: string;
  username: string;
  /** 저장된 자격증명이 있는가. 값 자체는 절대 내보내지 않는다. */
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RunRow {
  id: number;
  projectId: number;
  runId: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  runDir: string;
  screensExplored: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  aiStatus: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  target_url    TEXT NOT NULL,
  start_path    TEXT NOT NULL DEFAULT '/',
  username      TEXT NOT NULL DEFAULT '',
  -- safeStorage로 암호화된 바이트. 복호화 키는 OS가 들고 있다.
  password_enc  BLOB,
  config_json   TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS qa_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id            TEXT NOT NULL,
  status            TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  run_dir           TEXT NOT NULL DEFAULT '',
  screens_explored  INTEGER NOT NULL DEFAULT 0,
  critical          INTEGER NOT NULL DEFAULT 0,
  high              INTEGER NOT NULL DEFAULT 0,
  medium            INTEGER NOT NULL DEFAULT 0,
  low               INTEGER NOT NULL DEFAULT 0,
  ai_status         TEXT NOT NULL DEFAULT 'not_used',
  summary_json      TEXT,
  -- 완주하지 못한 Run이 왜 끝났는지. 로그인 실패처럼 정상적인 판정도 여기 들어간다.
  fail_reason       TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_project ON qa_runs(project_id, started_at DESC);

CREATE TABLE IF NOT EXISTS qa_issues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_pk      INTEGER NOT NULL REFERENCES qa_runs(id) ON DELETE CASCADE,
  issue_id    TEXT NOT NULL,
  severity    TEXT NOT NULL,
  priority    TEXT NOT NULL,
  rule_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  issue_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issues_run ON qa_issues(run_pk);
`;

export class Store {
  private readonly db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * 이미 만들어진 DB에 컬럼을 더한다.
   * `CREATE TABLE IF NOT EXISTS` 는 기존 테이블을 건드리지 않으므로 따로 필요하다.
   */
  private migrate(): void {
    for (const [table, column, type] of [["qa_runs", "fail_reason", "TEXT"]] as const) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      } catch {
        // 이미 있으면 그대로 둔다.
      }
    }
  }

  close(): void {
    this.db.close();
  }

  // ── 프로젝트 ────────────────────────────────────────────────────────
  listProjects(): ProjectRow[] {
    const rows = this.db.all(
      `SELECT id, name, target_url, start_path, username,
              password_enc IS NOT NULL AS has_password, created_at, updated_at
       FROM projects ORDER BY updated_at DESC`,
    ) as Array<Record<string, unknown>>;
    return rows.map(toProjectRow);
  }

  getProject(id: number): ProjectRow | null {
    const row = this.db.get(
      `SELECT id, name, target_url, start_path, username,
              password_enc IS NOT NULL AS has_password, created_at, updated_at
       FROM projects WHERE id = ?`,
      [id],
    ) as Record<string, unknown> | undefined;
    return row ? toProjectRow(row) : null;
  }

  createProject(input: {
    name: string;
    targetUrl: string;
    startPath: string;
    username: string;
    passwordEnc: Uint8Array | null;
    config: Partial<RunConfig>;
  }): number {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO projects (name, target_url, start_path, username, password_enc, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.name,
        input.targetUrl,
        input.startPath,
        input.username,
        input.passwordEnc ?? null,
        JSON.stringify(input.config),
        now,
        now,
      ],
    );
    const row = this.db.get("SELECT last_insert_rowid() AS id") as { id: number };
    return row.id;
  }

  updateProject(
    id: number,
    input: {
      name: string;
      targetUrl: string;
      startPath: string;
      username: string;
      /** null이면 기존 자격증명을 그대로 둔다. 비우려면 빈 배열을 넘긴다. */
      passwordEnc: Uint8Array | null;
      config: Partial<RunConfig>;
    },
  ): void {
    const now = new Date().toISOString();
    if (input.passwordEnc === null) {
      this.db.run(
        `UPDATE projects SET name=?, target_url=?, start_path=?, username=?, config_json=?, updated_at=?
         WHERE id=?`,
        [input.name, input.targetUrl, input.startPath, input.username, JSON.stringify(input.config), now, id],
      );
    } else {
      this.db.run(
        `UPDATE projects SET name=?, target_url=?, start_path=?, username=?, password_enc=?, config_json=?, updated_at=?
         WHERE id=?`,
        [
          input.name,
          input.targetUrl,
          input.startPath,
          input.username,
          input.passwordEnc.length > 0 ? input.passwordEnc : null,
          JSON.stringify(input.config),
          now,
          id,
        ],
      );
    }
  }

  deleteProject(id: number): void {
    this.db.run("DELETE FROM projects WHERE id = ?", [id]);
  }

  /** 저장된 설정 조각. 화면이 마지막 설정을 복원하는 데 쓴다. */
  getProjectConfig(id: number): Partial<RunConfig> {
    const row = this.db.get("SELECT config_json FROM projects WHERE id = ?", [id]) as
      | { config_json: string }
      | undefined;
    if (!row) return {};
    try {
      return JSON.parse(row.config_json) as Partial<RunConfig>;
    } catch {
      return {};
    }
  }

  /**
   * 암호화된 자격증명을 꺼낸다.
   * **이 메서드의 반환값은 IPC로 렌더러에 나가면 안 된다.** main에서만 쓴다.
   */
  getPasswordEnc(id: number): Uint8Array | null {
    const row = this.db.get("SELECT password_enc FROM projects WHERE id = ?", [id]) as
      | { password_enc: Uint8Array | null }
      | undefined;
    return row?.password_enc ?? null;
  }

  // ── Run ─────────────────────────────────────────────────────────────
  startRun(projectId: number, runId: string, startedAt: string): number {
    this.db.run(
      `INSERT INTO qa_runs (project_id, run_id, status, started_at) VALUES (?, ?, 'RUNNING', ?)`,
      [projectId, runId, startedAt],
    );
    const row = this.db.get("SELECT last_insert_rowid() AS id") as { id: number };
    return row.id;
  }

  finishRun(runPk: number, summary: RunSummary, runDir: string, issues: Issue[]): void {
    this.db.run(
      `UPDATE qa_runs SET status=?, finished_at=?, run_dir=?, screens_explored=?,
              critical=?, high=?, medium=?, low=?, ai_status=?, summary_json=?
       WHERE id=?`,
      [
        summary.status,
        summary.finishedAt,
        runDir,
        summary.screensExplored,
        summary.issueCounts.critical,
        summary.issueCounts.high,
        summary.issueCounts.medium,
        summary.issueCounts.low,
        summary.aiStatus,
        JSON.stringify(summary),
        runPk,
      ],
    );

    this.db.run("DELETE FROM qa_issues WHERE run_pk = ?", [runPk]);
    for (const issue of issues) {
      this.db.run(
        `INSERT INTO qa_issues (run_pk, issue_id, severity, priority, rule_id, title, issue_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [runPk, issue.id, issue.severity, issue.priority, issue.ruleId, issue.title, JSON.stringify(issue)],
      );
    }
  }

  /**
   * 리포트를 만들지 못하고 끝난 Run.
   *
   * **증적은 대개 남아 있다.** 로그인 실패처럼 엔진이 스스로 판단해 멈춘 경우
   * 실패 화면 스크린샷과 `login.json` 이 그대로 있으므로, 사용자가 열어볼 수 있게
   * `run_id` 와 `run_dir` 을 반드시 저장한다. 사유도 함께 남긴다.
   */
  failRun(
    runPk: number,
    status: string,
    detail: { runId?: string; runDir?: string; reason?: string | null } = {},
  ): void {
    this.db.run(
      `UPDATE qa_runs
       SET status=?, finished_at=?,
           run_id = COALESCE(NULLIF(?, ''), run_id),
           run_dir = COALESCE(NULLIF(?, ''), run_dir),
           fail_reason = ?
       WHERE id=?`,
      [
        status,
        new Date().toISOString(),
        detail.runId ?? "",
        detail.runDir ?? "",
        detail.reason ?? null,
        runPk,
      ],
    );
  }

  /** 완주하지 못한 Run의 사유. 리포트가 없을 때 화면이 대신 보여준다. */
  getFailReason(runPk: number): string | null {
    const row = this.db.get("SELECT fail_reason FROM qa_runs WHERE id = ?", [runPk]) as
      | { fail_reason: string | null }
      | undefined;
    return row?.fail_reason ?? null;
  }

  listRuns(projectId?: number): RunRow[] {
    const rows = (
      projectId === undefined
        ? this.db.all(`SELECT * FROM qa_runs ORDER BY started_at DESC LIMIT 100`)
        : this.db.all(`SELECT * FROM qa_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 100`, [
            projectId,
          ])
    ) as Array<Record<string, unknown>>;
    return rows.map(toRunRow);
  }

  getRunSummary(runPk: number): RunSummary | null {
    const row = this.db.get("SELECT summary_json FROM qa_runs WHERE id = ?", [runPk]) as
      | { summary_json: string | null }
      | undefined;
    if (!row?.summary_json) return null;
    try {
      return JSON.parse(row.summary_json) as RunSummary;
    } catch {
      return null;
    }
  }

  listIssues(runPk: number): Issue[] {
    const rows = this.db.all(
      "SELECT issue_json FROM qa_issues WHERE run_pk = ? ORDER BY id",
      [runPk],
    ) as Array<{ issue_json: string }>;
    return rows.flatMap((r) => {
      try {
        return [JSON.parse(r.issue_json) as Issue];
      } catch {
        return [];
      }
    });
  }
}

function toProjectRow(row: Record<string, unknown>): ProjectRow {
  return {
    id: Number(row.id),
    name: String(row.name),
    targetUrl: String(row.target_url),
    startPath: String(row.start_path ?? "/"),
    username: String(row.username ?? ""),
    hasPassword: Number(row.has_password) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toRunRow(row: Record<string, unknown>): RunRow {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    runId: String(row.run_id),
    status: String(row.status),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    runDir: String(row.run_dir ?? ""),
    screensExplored: Number(row.screens_explored ?? 0),
    critical: Number(row.critical ?? 0),
    high: Number(row.high ?? 0),
    medium: Number(row.medium ?? 0),
    low: Number(row.low ?? 0),
    aiStatus: String(row.ai_status ?? "not_used"),
  };
}
