import { describe, expect, it } from "vitest";
import { consoleSignature, endpointTemplate, pathTemplate, queryKeys } from "./normalize.js";

describe("pathTemplate", () => {
  it.each([
    ["/users/1234", "/users/:id"],
    ["/users/1/orders/99", "/users/:id/orders/:id"],
    ["/surveys/550e8400-e29b-41d4-a716-446655440000", "/surveys/:id"],
    ["/items/507f1f77bcf86cd799439011", "/items/:id"],
    // 접으면 안 되는 것들
    ["/users", "/users"],
    ["/users/new", "/users/new"],
    ["/settings", "/settings"],
    ["/v2/users", "/v2/users"],
  ])("%s -> %s", (input, expected) => {
    expect(pathTemplate(input)).toBe(expected);
  });

  /**
   * fixture의 사용자 47명이 47개 상태가 되면 탐색이 끝나지 않는다.
   * 이 테스트가 Phase 2 결정성 DoD의 1차 방어선이다.
   */
  it("id만 다른 경로는 전부 같은 템플릿이 된다", () => {
    const templates = new Set(
      Array.from({ length: 47 }, (_, i) => pathTemplate(`/users/${i + 1}`)),
    );
    expect(templates.size).toBe(1);
  });
});

describe("endpointTemplate", () => {
  it.each([
    ["http://x/api/users/1234?page=2", "/api/users/:id"],
    ["http://x/api/notice/badge", "/api/notice/badge"],
    ["http://x/api/stats/export?from=2026-01", "/api/stats/export"],
  ])("%s -> %s", (input, expected) => {
    expect(endpointTemplate(input)).toBe(expected);
  });

  it("URL이 아니어도 죽지 않는다", () => {
    expect(endpointTemplate("not-a-url?x=1")).toBe("not-a-url");
  });
});

describe("queryKeys", () => {
  it("키만 정렬해 남기고 값은 버린다", () => {
    expect(queryKeys("?page=3&keyword=abc&sort=name")).toEqual(["keyword", "page", "sort"]);
  });

  it("값만 다른 쿼리는 같은 결과가 된다", () => {
    expect(queryKeys("?page=1&sort=id")).toEqual(queryKeys("?page=99&sort=name"));
  });

  it("빈 쿼리는 빈 배열", () => {
    expect(queryKeys("")).toEqual([]);
  });
});

describe("consoleSignature", () => {
  it("행 번호만 다른 같은 오류를 하나로 묶는다", () => {
    const a = consoleSignature("Cannot read properties of undefined (reading 'length') at row 42");
    const b = consoleSignature("Cannot read properties of undefined (reading 'length') at row 87");
    expect(a).toBe(b);
  });

  it("URL만 다른 같은 오류를 하나로 묶는다", () => {
    const a = consoleSignature("failed at http://localhost:3100/users");
    const b = consoleSignature("failed at http://localhost:3100/surveys");
    expect(a).toBe(b);
  });

  it("서로 다른 오류는 구별한다", () => {
    expect(consoleSignature("TypeError: x is undefined")).not.toBe(
      consoleSignature("ReferenceError: y is not defined"),
    );
  });
});
