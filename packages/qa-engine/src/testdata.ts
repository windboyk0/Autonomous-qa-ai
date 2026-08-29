import type { FormField } from "./forms.js";

/**
 * Test Data Agent (`.claude/agents/15-test-data.md`).
 *
 * QA가 만든 데이터를 **끝까지 추적**한다.
 * 관리자 시스템에 정체불명의 데이터를 남기면 이 도구는 두 번 다시 쓰이지 않는다.
 */

/** 이 접두사가 **소유권 판정의 유일한 근거**다. */
export const AUTO_QA_PREFIX = "AUTO-QA";

/** `AUTO-QA-yyyyMMdd-HHmmss-SEQ` */
export function makeMarker(seq: number, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${AUTO_QA_PREFIX}-${stamp}-${String(seq).padStart(3, "0")}`;
}

export function isOwnedByQa(text: string): boolean {
  return text.includes(AUTO_QA_PREFIX);
}

/**
 * 필드 종류에 맞는 값을 만든다.
 *
 * 이메일은 `.invalid` 도메인을 쓴다 — 예약된 TLD라 실제로 메일이 나갈 수 없다.
 * 전화번호도 실제로 걸리지 않는 번호를 쓴다.
 */
export function valueFor(field: FormField, marker: string): string {
  switch (field.kind) {
    case "email":
      return `${marker.toLowerCase()}@example.invalid`;
    case "number":
      return "1";
    case "date":
      return new Date().toISOString().slice(0, 10);
    case "tel":
      return `010-0000-${marker.slice(-4)}`;
    case "url":
      return "https://example.invalid/auto-qa";
    case "select":
      return field.firstOption ?? "";
    case "textarea":
    case "text":
      return marker;
    default:
      return marker;
  }
}

/** 대장에 남기는 한 건. Run이 중간에 죽어도 이 기록으로 수동 정리가 가능해야 한다. */
export interface CreatedRecord {
  id: string;
  marker: string;
  /** 어떤 화면에서 만들었는가 */
  screen: string;
  createUrl: string;
  /** 만든 뒤 도달한 URL. 상세 화면이면 여기서 수정·삭제를 시도한다. */
  landedUrl: string | null;
  createdAt: string;
  cleaned: boolean;
  cleanupError: string | null;
}

/**
 * 생성 데이터 대장.
 *
 * **Update·Delete는 이 대장에 있는 것만 대상으로 한다.**
 * 목록의 "첫 번째 행"을 대상으로 삼는 코드는 절대 쓰지 않는다.
 */
export class TestDataLedger {
  private seq = 0;
  private readonly records: CreatedRecord[] = [];
  private readonly startedAt = new Date();

  nextMarker(): string {
    this.seq += 1;
    return makeMarker(this.seq, this.startedAt);
  }

  add(record: Omit<CreatedRecord, "id" | "cleaned" | "cleanupError">): CreatedRecord {
    const entry: CreatedRecord = {
      ...record,
      id: `data-${String(this.records.length + 1).padStart(3, "0")}`,
      cleaned: false,
      cleanupError: null,
    };
    this.records.push(entry);
    return entry;
  }

  markCleaned(id: string, error: string | null = null): void {
    const record = this.records.find((r) => r.id === id);
    if (!record) return;
    record.cleaned = error === null;
    record.cleanupError = error;
  }

  all(): readonly CreatedRecord[] {
    return this.records;
  }

  /** 아직 지우지 못한 것. 리포트에 식별자와 함께 그대로 나열한다. */
  leftovers(): CreatedRecord[] {
    return this.records.filter((r) => !r.cleaned);
  }
}
