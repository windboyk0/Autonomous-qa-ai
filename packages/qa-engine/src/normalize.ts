import { createHash } from "node:crypto";

/**
 * 정규화 유틸. 중복 제거(dedup)와 상태 지문이 전부 여기에 의존한다.
 *
 * 규칙이 한 곳에 모여 있어야 Explorer / Network Reviewer / Console Reviewer가
 * 같은 기준으로 같은 것을 "같다"고 판단한다.
 */

export function sha1(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX24 = /^[0-9a-f]{24,}$/i;

/** 경로 세그먼트가 식별자인가. 숫자 · UUID · 긴 hex 는 :id 로 접는다. */
function isIdSegment(seg: string): boolean {
  if (seg === "") return false;
  if (/^\d+$/.test(seg)) return true;
  if (UUID.test(seg)) return true;
  if (HEX24.test(seg)) return true;
  return false;
}

/**
 * `/users/1234` → `/users/:id`
 *
 * 이 정규화가 없으면 사용자 47명이 47개 상태가 되고 탐색이 끝나지 않는다.
 */
export function pathTemplate(pathname: string): string {
  const parts = pathname.split("/");
  return parts.map((seg) => (isIdSegment(seg) ? ":id" : seg)).join("/") || "/";
}

/**
 * `/api/users/1234?page=2` → `/api/users/:id`
 *
 * 네트워크 dedup 키의 핵심. 쿼리를 버리고 id를 접는다.
 */
export function endpointTemplate(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return pathTemplate(u.pathname);
  } catch {
    return rawUrl.split("?")[0] ?? rawUrl;
  }
}

/** 쿼리 키만 정렬해 돌려준다. 값은 버린다 (페이징·정렬 조합으로 상태가 폭발하는 것을 막는다). */
export function queryKeys(search: string): string[] {
  const params = new URLSearchParams(search);
  return [...new Set([...params.keys()])].sort();
}

/**
 * 콘솔 오류 시그니처.
 *
 * 같은 원인의 오류가 행 번호나 URL만 달라 수십 건으로 쏟아지는 것을 하나로 묶는다.
 * 숫자 · URL · 긴 hex · 따옴표 안의 값을 지운 뒤 해싱한다.
 */
export function consoleSignature(text: string): string {
  const normalized = text
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hash>")
    .replace(/['"][^'"]*['"]/g, "<v>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  return sha1(normalized);
}
