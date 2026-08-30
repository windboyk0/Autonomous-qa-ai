import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_SRC_ROOT,
  KNOWN_CALL_SITES,
  KNOWN_ENDPOINTS,
  KNOWN_SOURCE_BUGS,
  SOURCE_ONLY_BUGS,
  lineOfAnchor,
} from "./index.js";

/**
 * Phase 8 DoD.
 *
 *   정답지의 **모든 항목이 실제 파일의 정확히 한 줄로 특정된다.**
 *
 * 이 테스트가 없으면 정답지는 시간이 지나며 조용히 낡는다. fixture를 한 줄 고쳤을 때
 * 여기서 깨져야 다음 Phase 의 채점이 거짓말을 하지 않는다.
 */

const DOC = resolve(FIXTURE_SRC_ROOT, "..", "KNOWN_SOURCE_BUGS.md");

describe("Phase 8 — fixture 프로젝트", () => {
  it("프로젝트 루트가 존재한다", () => {
    expect(existsSync(FIXTURE_SRC_ROOT)).toBe(true);
    expect(existsSync(join(FIXTURE_SRC_ROOT, "backend"))).toBe(true);
    expect(existsSync(join(FIXTURE_SRC_ROOT, "frontend"))).toBe(true);
  });

  it("빌드 산출물이나 의존성 폴더가 섞여 있지 않다", () => {
    // 스캐너가 읽을 대상이므로 node_modules 가 들어오면 채점이 무의미해진다.
    expect(existsSync(join(FIXTURE_SRC_ROOT, "frontend", "node_modules"))).toBe(false);
    expect(existsSync(join(FIXTURE_SRC_ROOT, "backend", "build"))).toBe(false);
  });
});

describe("Phase 8 — 결함 정답지", () => {
  it("결함이 12건이다", () => {
    expect(KNOWN_SOURCE_BUGS.length).toBe(12);
  });

  it("id 가 중복되지 않는다", () => {
    const ids = KNOWN_SOURCE_BUGS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(KNOWN_SOURCE_BUGS.map((b) => [b.id, b] as const))(
    "%s 가 실제 파일의 정확히 한 줄로 특정된다",
    (_id, bug) => {
      expect(existsSync(join(FIXTURE_SRC_ROOT, bug.file)), `${bug.file} 없음`).toBe(true);
      const line = lineOfAnchor(bug.file, bug.anchor);
      expect(line).toBeGreaterThan(0);
    },
  );

  /**
   * 소스 QA 를 따로 만드는 근거 자체를 테스트로 못박는다.
   * 실행 QA 로 잡히는 것만 모아 놓았다면 모드를 나눌 이유가 없다.
   */
  it("실행 QA 가 원리적으로 못 찾는 결함이 과반이다", () => {
    expect(SOURCE_ONLY_BUGS.length).toBeGreaterThan(KNOWN_SOURCE_BUGS.length / 2);
  });

  it("권한 검사 누락이 정확히 1건 있고 CRITICAL 이다", () => {
    const authz = KNOWN_SOURCE_BUGS.filter((b) => b.category === "authz");
    expect(authz.length).toBe(1);
    expect(authz[0]!.severity).toBe("CRITICAL");
    expect(authz[0]!.runtimeCanFind).toBe(false);
  });

  it("문서 정답지와 개수가 어긋나지 않는다", () => {
    const doc = readFileSync(DOC, "utf8");
    for (const bug of KNOWN_SOURCE_BUGS) {
      expect(doc, `${bug.id} 가 문서에 없다`).toContain(bug.id);
    }
    // 문서에만 있는 SRC-xx 가 있으면 옮겨 적지 않은 것이다.
    const inDoc = new Set(doc.match(/SRC-\d{2}/g) ?? []);
    expect(inDoc.size).toBe(KNOWN_SOURCE_BUGS.length);
  });
});

describe("Phase 8 — 엔드포인트 정답지", () => {
  it.each(KNOWN_ENDPOINTS.map((e) => [`${e.method} ${e.path}`, e] as const))(
    "%s 가 컨트롤러의 한 줄로 특정된다",
    (_name, ep) => {
      expect(lineOfAnchor(ep.file, ep.anchor)).toBeGreaterThan(0);
    },
  );

  it("권한 검사가 없는 엔드포인트가 정확히 1개다 (SRC-01 과 짝)", () => {
    const open = KNOWN_ENDPOINTS.filter((e) => !e.authorized);
    expect(open.length).toBe(1);
    expect(open[0]!.method).toBe("DELETE");
  });

  it.each(KNOWN_CALL_SITES.map((c) => [c.anchor, c] as const))(
    "호출 지점 %s 가 한 줄로 특정된다",
    (_name, site) => {
      expect(lineOfAnchor(site.file, site.anchor)).toBeGreaterThan(0);
      for (const screen of site.screenFiles) {
        expect(existsSync(join(FIXTURE_SRC_ROOT, screen)), `${screen} 없음`).toBe(true);
      }
    },
  );
});
