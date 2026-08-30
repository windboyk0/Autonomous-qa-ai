/**
 * 시크릿 취급 정책 (CLAUDE.md §16-1).
 *
 * 소스 QA는 이 도구의 성격을 바꾼다. 지금까지는 화면 DOM만 밖으로 나갔지만
 * 소스 QA는 **회사 코드베이스를 읽는 도구**다. 그래서 읽는 규칙을 코드로 못박는다.
 *
 * 핵심은 하나다. **값을 읽을 이유가 없다.**
 * "운영 설정에 평문 비밀번호가 있다"는 키 이름만으로 보고할 수 있고,
 * 값을 증적에 남기는 순간 이 도구가 새로운 유출 경로가 된다.
 */

/** 파일을 어떻게 다룰 것인가. */
export type FileAccess =
  /** 내용을 읽어도 된다 (일반 소스) */
  | "read"
  /** 키 이름만 본다. 값은 읽는 즉시 버린다 */
  | "keys-only"
  /** 존재만 본다. 열지 않는다 */
  | "presence-only";

/** 열지 않는다. 바이너리 키·인증서 종류다. */
const PRESENCE_ONLY = [
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.keystore$/i,
  /\.jks$/i,
  /(^|\/)id_rsa/i,
];

/** 키 이름까지만 본다. 값은 버린다. */
const KEYS_ONLY = [
  /(^|\/)\.env($|\.)/i,
  /(^|\/)secrets?\.[a-z]+$/i,
  /(^|\/)credentials?\.[a-z]+$/i,
  /(^|\/)application(-[a-z0-9]+)?\.(ya?ml|properties)$/i,
];

/** 값을 절대 기록하면 안 되는 키 이름. */
const SECRET_KEY = /(password|passwd|pwd|secret|token|apikey|api[_-]?key|accesskey|access[_-]?key|credential|private[_-]?key)/i;

export function accessOf(relativePath: string): FileAccess {
  const p = relativePath.replace(/\\/g, "/");
  if (PRESENCE_ONLY.some((re) => re.test(p))) return "presence-only";
  if (KEYS_ONLY.some((re) => re.test(p))) return "keys-only";
  return "read";
}

/**
 * 이름에 token·secret 이 들어가도 자격증명이 아닌 키들.
 *
 * 실측에서 `jwt.access-token-expire-seconds`, `jwt.refresh-token-expire-days` 가
 * "평문 자격증명"으로 보고됐다. 숫자로 된 유효기간 설정이다.
 * 이런 것을 결함이라고 하면 진짜 결함이 묻힌다.
 */
const NOT_A_SECRET =
  /(expire|expiry|expiration|ttl|timeout|duration|seconds|minutes|hours|days|size|length|count|enabled|disabled|header|prefix|issuer|audience|algorithm|type|url|uri|endpoint|path|name|rotation|interval)/i;

export function isSecretKey(key: string): boolean {
  if (!SECRET_KEY.test(key)) return false;
  // 마지막 마디가 설정값이면 자격증명이 아니다. `jwt.secret` 은 남고
  // `jwt.secret-rotation-days` 는 걸러진다.
  const last = key.split(".").pop() ?? key;
  return !NOT_A_SECRET.test(last);
}

/** 설정 파일에서 뽑아낸 키 하나. **값은 담지 않는다.** */
export interface ConfigKey {
  key: string;
  line: number;
  /**
   * 값의 **모양**만 기록한다. 내용은 담지 않는다.
   * - `env-ref`: `${DB_PASSWORD}` 처럼 환경변수를 참조한다 (정상)
   * - `literal`: 값이 그 자리에 박혀 있다 (평문)
   * - `empty`: 비어 있다
   */
  valueShape: "env-ref" | "literal" | "empty";
}

/**
 * yml / properties 에서 키 이름과 값의 **모양**만 뽑는다.
 *
 * 값 문자열은 이 함수 밖으로 나가지 않는다. 반환 타입에 값이 없다는 것이
 * 그 보장의 전부이며, 테스트가 이를 확인한다.
 */
export function readConfigKeys(text: string): ConfigKey[] {
  const out: ConfigKey[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("//")) continue;

    const m = /^([A-Za-z0-9_.\-[\]]+)\s*[:=]\s*(.*)$/.exec(line);
    if (!m) continue;

    const key = m[1]!;
    const value = m[2]!.trim();

    let shape: ConfigKey["valueShape"] = "literal";
    if (value === "" || value === "|" || value === ">") shape = "empty";
    else if (/^["']?\$\{[^}]*\}["']?$/.test(value) || /^["']?\$[A-Z_]+["']?$/.test(value))
      shape = "env-ref";

    out.push({ key, line: i + 1, valueShape: shape });
  }
  return out;
}

/**
 * yml 은 들여쓰기로 계층을 만든다. `spring.datasource.password` 를 알아야
 * 키 이름만으로 판정할 수 있으므로 경로를 이어 붙인다.
 */
export function readYamlKeyPaths(text: string): ConfigKey[] {
  const out: ConfigKey[] = [];
  const stack: Array<{ indent: number; key: string }> = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;

    const m = /^(\s*)([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/.exec(raw);
    if (!m) continue;

    const indent = m[1]!.length;
    const key = m[2]!;
    const value = m[3]!.trim();

    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();

    if (value === "") {
      stack.push({ indent, key });
      continue;
    }

    let shape: ConfigKey["valueShape"] = "literal";
    if (/^["']?\$\{[^}]*\}["']?$/.test(value)) shape = "env-ref";

    out.push({
      key: [...stack.map((s) => s.key), key].join("."),
      line: i + 1,
      valueShape: shape,
    });
  }
  return out;
}
