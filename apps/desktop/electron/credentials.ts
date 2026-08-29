import { safeStorage } from "electron";

/**
 * 자격증명 보호 (CLAUDE.md §20, `.claude/agents/13-security-safety.md`).
 *
 * 비밀번호는 **OS가 관리하는 키로 암호화된 바이트로만** 디스크에 남는다.
 * 복호화한 평문은 main 프로세스 안에서만 존재하고, 엔진에는 환경변수로 넘긴다.
 *
 * **렌더러로는 어떤 경로로도 나가지 않는다.** IPC 응답에 담기지 않고,
 * 저장된 값이 "있다/없다"만 알려준다.
 */

export interface CredentialStatus {
  available: boolean;
  /** 암호화를 쓸 수 없을 때 사용자에게 보여줄 설명. */
  reason: string | null;
}

export function credentialStatus(): CredentialStatus {
  if (safeStorage.isEncryptionAvailable()) return { available: true, reason: null };
  return {
    available: false,
    reason:
      "OS 자격증명 저장소를 사용할 수 없습니다. 비밀번호를 저장하지 않고 실행할 때마다 입력해야 합니다.",
  };
}

/**
 * 저장용으로 암호화한다.
 *
 * 암호화를 쓸 수 없으면 **평문으로 저장하지 않고 저장 자체를 포기한다.**
 * 편의를 위해 평문을 남기는 순간 이 도구가 사고의 원인이 된다.
 */
export function encryptPassword(plain: string): Uint8Array | null {
  if (!plain) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  return new Uint8Array(safeStorage.encryptString(plain));
}

/** 실행 직전 main에서만 부른다. 결과를 로그·IPC·파일 어디에도 남기지 않는다. */
export function decryptPassword(encrypted: Uint8Array | null): string {
  if (!encrypted || encrypted.length === 0) return "";
  if (!safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(encrypted));
  } catch {
    // 다른 PC에서 복사해 온 DB이거나 OS 키가 바뀐 경우다.
    return "";
  }
}
