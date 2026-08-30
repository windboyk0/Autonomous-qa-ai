import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 소스 QA 채점용 fixture 프로젝트.
 *
 * `fixture-admin` 이 실행 QA 의 정답지였던 것처럼, 이 패키지는 소스 QA 의 정답지다.
 * 정답지가 없으면 탐지율도 오탐률도 잴 수 없고, 잴 수 없으면 회귀도 없다.
 *
 * **이 프로젝트는 빌드하지도 실행하지도 않는다.** 읽히기만 한다.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** fixture 프로젝트의 루트 절대 경로. 스캐너에 이 경로를 준다. */
export const FIXTURE_SRC_ROOT = resolve(here, "..", "project");

export * from "./known-bugs.js";
export * from "./known-endpoints.js";

/**
 * 앵커가 있는 줄 번호를 찾는다(1부터).
 *
 * 정답지에 줄 번호를 손으로 적지 않기 위한 장치다. 앵커가 정확히 한 줄에만
 * 있어야 하며, 0줄이거나 2줄 이상이면 정답지가 낡은 것이므로 던진다.
 */
export function lineOfAnchor(relativeFile: string, anchor: string): number {
  const text = readFileSync(join(FIXTURE_SRC_ROOT, relativeFile), "utf8");
  const lines = text.split(/\r?\n/);
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.includes(anchor)) hits.push(i + 1);
  }
  if (hits.length === 0) {
    throw new Error(`${relativeFile} 에 앵커가 없습니다: ${anchor}`);
  }
  if (hits.length > 1) {
    throw new Error(`${relativeFile} 에 앵커가 ${hits.length}줄에 있습니다(고유해야 함): ${anchor}`);
  }
  return hits[0]!;
}
