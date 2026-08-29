import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Evidence, EvidenceKind } from "@qa/shared";
import { scrub } from "./emitter.js";

const SUBDIRS = ["screenshots", "dom", "aria", "network", "console", "visual", "actions"] as const;

/**
 * Run 1회의 출력 상태를 들고 있는 객체.
 *
 * 증적 파일 경로 생성과 Evidence 레코드 발급을 한 곳으로 모은다.
 * 파일을 직접 쓰는 코드는 여기 말고 아무 데도 없어야 한다 —
 * 마스킹(`scrub`)을 우회하는 경로가 생기면 비밀번호가 새어나간다.
 */
export class RunContext {
  readonly runId: string;
  readonly runDir: string;

  private seq = 0;
  private evidenceSeq = 0;
  private readonly evidences: Evidence[] = [];

  constructor(runId: string, outDir: string, baseDir: string) {
    this.runId = runId;
    this.runDir = resolve(baseDir, outDir, runId);
    for (const sub of SUBDIRS) mkdirSync(join(this.runDir, sub), { recursive: true });
  }

  /** 화면 방문 순서 번호. 파일명 접두사로 쓰여 정렬하면 탐색 순서가 재생된다. */
  nextSeq(): string {
    this.seq += 1;
    return String(this.seq).padStart(4, "0");
  }

  /** 파일명에 쓸 수 있게 화면 이름을 정리한다. */
  static slug(name: string): string {
    const s = name
      .trim()
      .replace(/[\\/:*?"<>|\s]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    return s || "screen";
  }

  /** 텍스트 증적을 저장하고 runDir 기준 상대경로를 돌려준다. */
  writeText(sub: (typeof SUBDIRS)[number], filename: string, content: string): string {
    const rel = `${sub}/${filename}`;
    writeFileSync(join(this.runDir, sub, filename), scrub(content), "utf8");
    return rel;
  }

  writeJson(sub: (typeof SUBDIRS)[number], filename: string, value: unknown): string {
    return this.writeText(sub, filename, JSON.stringify(value, null, 2));
  }

  writeBinary(sub: (typeof SUBDIRS)[number], filename: string, data: Buffer): string {
    const rel = `${sub}/${filename}`;
    writeFileSync(join(this.runDir, sub, filename), data);
    return rel;
  }

  addEvidence(input: {
    kind: EvidenceKind;
    stateKey: string;
    screenName: string;
    path: string | null;
    summary: string;
    pairedWithId?: string | null;
  }): Evidence {
    this.evidenceSeq += 1;
    const ev: Evidence = {
      id: `ev-${String(this.evidenceSeq).padStart(4, "0")}`,
      kind: input.kind,
      stateKey: input.stateKey,
      screenName: input.screenName,
      path: input.path,
      summary: scrub(input.summary),
      at: new Date().toISOString(),
      pairedWithId: input.pairedWithId ?? null,
    };
    this.evidences.push(ev);
    return ev;
  }

  listEvidences(): readonly Evidence[] {
    return this.evidences;
  }

  /** 최종 산출물 1: 사람이 읽는 리포트. */
  writeReport(markdown: string): string {
    const rel = "report.md";
    writeFileSync(join(this.runDir, rel), scrub(markdown), "utf8");
    return rel;
  }

  /** 최종 산출물 2: 기계가 읽는 이슈 목록. */
  writeIssues(file: unknown): string {
    const rel = "issues.json";
    writeFileSync(join(this.runDir, rel), scrub(JSON.stringify(file, null, 2)), "utf8");
    return rel;
  }

  /** Run 종료 시 증적 색인을 남긴다. Issue의 evidenceId를 파일로 되짚는 데 쓴다. */
  saveEvidenceIndex(): string {
    const rel = "evidence.json";
    writeFileSync(
      join(this.runDir, rel),
      scrub(JSON.stringify({ schemaVersion: 1, evidences: this.evidences }, null, 2)),
      "utf8",
    );
    return rel;
  }
}

/** Run 디렉터리 이름. 정렬 가능하고 파일시스템에 안전한 형태. */
export function makeRunId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}
