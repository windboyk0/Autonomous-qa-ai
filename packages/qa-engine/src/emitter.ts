import { EngineEvent } from "@qa/shared";

/**
 * 엔진의 유일한 출력 통로.
 *
 * stdout에 JSON Lines로 흘린다. CLI도 Electron Main도 이 스트림만 읽는다.
 * `console.log`를 엔진 코드 안에서 직접 쓰지 말 것 — 스트림이 오염되면 Phase 5의 UI가 깨진다.
 * 사람이 읽을 로그는 `emit({type:"log", ...})` 로 보낸다.
 */

const MASK = "***REDACTED***";

/** 이벤트에 실려나가면 안 되는 값들. 런타임에 등록한다. */
const secrets = new Set<string>();

export function registerSecret(value: string): void {
  if (value && value.length >= 3) secrets.add(value);
}

/** 어떤 문자열이든 이 함수를 통과한 뒤에야 밖으로 나간다. */
export function scrub(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join(MASK);
  return out;
}

export function emit(event: EngineEvent): void {
  const line = scrub(JSON.stringify(event));
  process.stdout.write(line + "\n");
}

export function log(level: "debug" | "info" | "warn" | "error", message: string): void {
  emit({ type: "log", at: new Date().toISOString(), level, message: scrub(message) });
}
