import { z } from "zod";
import { log, scrub } from "../emitter.js";

/**
 * AI 호출의 안전망.
 *
 * **AI 실패가 위로 전파되면 안 된다.** Playwright가 모은 증적과 룰 판정은
 * Provider가 죽든 말든 그대로 살아남아야 하고, 리포트도 나와야 한다.
 * 그래서 모든 AI 호출은 여기를 통과한다.
 */

export type AiStatus = "not_used" | "ok" | "degraded" | "failed";

export class AiGuard {
  private ok = 0;
  private failed = 0;
  private readonly reasons: string[] = [];

  constructor(private readonly timeoutMs: number) {}

  /**
   * 호출 1건을 감싼다. 무슨 일이 있어도 던지지 않고 null을 돌려준다.
   * 타임아웃도 여기서 건다 — 로컬 모델이 멈추면 Run 전체가 멈춘다.
   */
  async run<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      const result = await withTimeout(fn(), this.timeoutMs, label);
      this.ok += 1;
      return result;
    } catch (err) {
      this.failed += 1;
      const reason = `${label}: ${err instanceof Error ? err.message : String(err)}`;
      this.reasons.push(reason);
      log("warn", `AI 호출 실패 (룰 결과는 유지됩니다) — ${scrub(reason)}`);
      return null;
    }
  }

  /**
   * 최종 상태.
   * - 한 번도 성공 못 했으면 failed
   * - 일부만 실패했으면 degraded — 리포트에 그 사실을 남긴다
   */
  status(): AiStatus {
    if (this.ok === 0 && this.failed === 0) return "not_used";
    if (this.ok === 0) return "failed";
    return this.failed > 0 ? "degraded" : "ok";
  }

  failureReason(): string | null {
    if (this.reasons.length === 0) return null;
    const head = this.reasons.slice(0, 3).join(" / ");
    return this.reasons.length > 3 ? `${head} 외 ${this.reasons.length - 3}건` : head;
  }

  counts(): { ok: number; failed: number } {
    return { ok: this.ok, failed: this.failed };
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 타임아웃 (${ms}ms)`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 모델이 흔히 틀리는 모양을 스키마에 맞게 고쳐준다.
 *
 * **스키마(계약)는 느슨하게 두지 않는다.** 대신 어댑터인 여기서 흡수한다.
 * 실측: exaone 2.4B는 배열 자리에 문자열 하나를 넣는 습관이 있고
 * ("notes": "특이사항 없음"), 재시도해도 같은 실수를 반복한다.
 * 작은 로컬 모델을 쓰겠다고 정한 이상 이런 버릇은 우리가 흡수해야 한다.
 */
function coerceShape(schema: z.ZodTypeAny, value: unknown): unknown {
  const def = schema._def as { typeName?: string; type?: z.ZodTypeAny; innerType?: z.ZodTypeAny };

  // optional/nullable/default 등의 껍질을 벗긴다
  if (def.innerType) return coerceShape(def.innerType, value);

  if (schema instanceof z.ZodArray) {
    if (Array.isArray(value)) return value.map((v) => coerceShape(schema.element, v));
    if (value === null || value === undefined) return [];
    if (typeof value === "string") return value.trim() === "" ? [] : [value];
    return value;
  }

  if (schema instanceof z.ZodObject && value !== null && typeof value === "object") {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [key, child] of Object.entries(shape)) {
      if (key in out) out[key] = coerceShape(child, out[key]);
    }
    return out;
  }

  return value;
}

/**
 * 모델 응답에서 JSON을 꺼내 스키마로 검증한다.
 *
 * 로컬 모델은 JSON만 내놓으라고 해도 앞뒤에 설명을 붙이는 일이 잦다.
 * 그래서 첫 `{`부터 마지막 `}`까지를 잘라 쓴다.
 */
export function parseJson<T>(schema: z.ZodType<T>, raw: string, label: string): T {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`${label}: 응답에서 JSON을 찾지 못했습니다 (${raw.slice(0, 120)})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    throw new Error(`${label}: JSON 파싱 실패 — ${String(err)}`);
  }

  const result = schema.safeParse(coerceShape(schema as z.ZodTypeAny, parsed));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`${label}: 스키마 불일치 — ${issues}`);
  }
  return result.data;
}

/**
 * 1회만 재시도한다.
 *
 * 스키마가 안 맞으면 "JSON만 출력하라"는 지시를 덧붙여 한 번 더 물어보고,
 * 그래도 안 되면 그 호출은 폐기한다. 무한 재시도는 로컬 모델에서 Run을 멈춘다.
 */
export async function retryOnce<T>(
  attempt: (hint: string | null) => Promise<T>,
  label: string,
): Promise<T> {
  try {
    return await attempt(null);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log("info", `${label} 1차 실패, 형식을 강조해 재시도합니다: ${scrub(reason)}`);
    return attempt(
      "이전 응답이 형식에 맞지 않았습니다. 설명이나 코드블록 없이 JSON 객체 하나만 출력하세요.",
    );
  }
}

/** 동시 실행 상한. 로컬 모델에 병렬 요청을 쏟아부으면 PC가 멈춘다. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
}
