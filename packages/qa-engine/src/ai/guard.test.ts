import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AiGuard, mapLimited, parseJson, retryOnce, withTimeout } from "./guard.js";

const Schema = z.object({ a: z.string(), b: z.number() });

describe("parseJson", () => {
  it("순수 JSON을 파싱한다", () => {
    expect(parseJson(Schema, '{"a":"x","b":1}', "t")).toEqual({ a: "x", b: 1 });
  });

  /** 로컬 모델은 JSON만 내놓으라고 해도 앞뒤에 설명을 붙이는 일이 잦다. */
  it("앞뒤에 설명이 붙어도 JSON을 꺼낸다", () => {
    const raw = '알겠습니다. 결과는 다음과 같습니다:\n```json\n{"a":"x","b":1}\n```\n도움이 되었길 바랍니다.';
    expect(parseJson(Schema, raw, "t")).toEqual({ a: "x", b: 1 });
  });

  it("JSON이 아예 없으면 던진다", () => {
    expect(() => parseJson(Schema, "죄송하지만 답변할 수 없습니다.", "t")).toThrow(/JSON을 찾지 못했/);
  });

  it("스키마가 안 맞으면 어느 필드인지 알려준다", () => {
    expect(() => parseJson(Schema, '{"a":"x","b":"틀림"}', "t")).toThrow(/스키마 불일치.*b/s);
  });

  it("깨진 JSON은 파싱 실패로 던진다", () => {
    expect(() => parseJson(Schema, '{"a":"x", b}', "t")).toThrow(/파싱 실패/);
  });
});

/**
 * 작은 로컬 모델은 배열 자리에 문자열 하나를 넣는 습관이 있고, 재시도해도 반복한다.
 * 계약(스키마)은 그대로 두고 어댑터가 흡수한다.
 */
describe("parseJson — 모델 버릇 흡수", () => {
  const ListSchema = z.object({
    notes: z.array(z.string()),
    ids: z.array(z.string()),
  });

  it("배열 자리의 문자열 하나를 배열로 감싼다", () => {
    expect(parseJson(ListSchema, '{"notes":"특이사항 없음","ids":[]}', "t")).toEqual({
      notes: ["특이사항 없음"],
      ids: [],
    });
  });

  it("배열 자리의 빈 문자열과 null은 빈 배열로 본다", () => {
    expect(parseJson(ListSchema, '{"notes":"","ids":null}', "t")).toEqual({ notes: [], ids: [] });
  });

  it("중첩된 객체 배열 안까지 고친다", () => {
    const Nested = z.object({
      groups: z.array(z.object({ id: z.string(), members: z.array(z.string()) })),
    });
    expect(parseJson(Nested, '{"groups":[{"id":"g1","members":"a"}]}', "t")).toEqual({
      groups: [{ id: "g1", members: ["a"] }],
    });
  });

  it("이미 올바른 값은 건드리지 않는다", () => {
    expect(parseJson(ListSchema, '{"notes":["a","b"],"ids":["x"]}', "t")).toEqual({
      notes: ["a", "b"],
      ids: ["x"],
    });
  });

  it("타입이 근본적으로 틀리면 여전히 던진다", () => {
    expect(() => parseJson(ListSchema, '{"notes":123,"ids":[]}', "t")).toThrow(/스키마 불일치/);
  });
});

describe("retryOnce", () => {
  it("성공하면 재시도하지 않는다", async () => {
    const attempt = vi.fn().mockResolvedValue("ok");
    await expect(retryOnce(attempt, "t")).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("실패하면 형식 강조 힌트와 함께 한 번만 재시도한다", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error("스키마 불일치"))
      .mockResolvedValueOnce("ok");
    await expect(retryOnce(attempt, "t")).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt.mock.calls[0]![0]).toBeNull();
    expect(attempt.mock.calls[1]![0]).toContain("JSON 객체 하나만");
  });

  /** 무한 재시도는 로컬 모델에서 Run 전체를 멈춘다. */
  it("두 번째도 실패하면 포기한다", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("계속 실패"));
    await expect(retryOnce(attempt, "t")).rejects.toThrow("계속 실패");
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

describe("withTimeout", () => {
  it("제한 안에 끝나면 결과를 준다", async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, "t")).resolves.toBe(7);
  });

  it("제한을 넘기면 던진다", async () => {
    const never = new Promise<number>(() => undefined);
    await expect(withTimeout(never, 30, "느린호출")).rejects.toThrow(/느린호출 타임아웃/);
  });
});

describe("mapLimited", () => {
  it("순서를 보존한다", async () => {
    const out = await mapLimited([1, 2, 3, 4, 5], 2, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  /** 로컬 모델에 병렬 요청을 쏟아부으면 PC가 멈춘다. */
  it("동시 실행 수를 넘지 않는다", async () => {
    let active = 0;
    let peak = 0;
    await mapLimited(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("빈 입력에도 멈추지 않는다", async () => {
    await expect(mapLimited([], 4, async () => 1)).resolves.toEqual([]);
  });
});

describe("AiGuard", () => {
  it("아무 호출도 없으면 not_used", () => {
    expect(new AiGuard(1000).status()).toBe("not_used");
  });

  it("전부 성공하면 ok", async () => {
    const g = new AiGuard(1000);
    await g.run("a", async () => 1);
    await g.run("b", async () => 2);
    expect(g.status()).toBe("ok");
    expect(g.failureReason()).toBeNull();
  });

  /** 이 테스트가 Phase 4의 전부다 — AI 실패가 절대 위로 전파되면 안 된다. */
  it("실패해도 던지지 않고 null을 준다", async () => {
    const g = new AiGuard(1000);
    const result = await g.run("터지는호출", async () => {
      throw new Error("모델 폭발");
    });
    expect(result).toBeNull();
    expect(g.status()).toBe("failed");
    expect(g.failureReason()).toContain("모델 폭발");
  });

  it("일부만 실패하면 degraded", async () => {
    const g = new AiGuard(1000);
    await g.run("ok", async () => 1);
    await g.run("bad", async () => {
      throw new Error("실패");
    });
    expect(g.status()).toBe("degraded");
    expect(g.counts()).toEqual({ ok: 1, failed: 1 });
  });

  it("느린 호출을 타임아웃으로 끊는다", async () => {
    const g = new AiGuard(30);
    const result = await g.run("무한", () => new Promise(() => undefined));
    expect(result).toBeNull();
    expect(g.failureReason()).toContain("타임아웃");
  });

  it("실패 사유가 많으면 요약한다", async () => {
    const g = new AiGuard(1000);
    for (let i = 0; i < 5; i++) {
      await g.run(`call${i}`, async () => {
        throw new Error(`e${i}`);
      });
    }
    expect(g.failureReason()).toContain("외 2건");
  });
});
