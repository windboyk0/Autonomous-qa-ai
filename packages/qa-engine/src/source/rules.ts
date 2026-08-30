/**
 * 소스 결함 룰.
 *
 * **일반 린터를 만들지 않는다.** ESLint·SpotBugs·Semgrep 이 하는 일을 다시 만들면
 * 오탐이 쏟아지고, 오탐이 쏟아지면 리포트를 아무도 보지 않는다.
 * 그러나 그 도구들은 대상 프로젝트의 설정 파일(그 자체가 실행 가능한 코드다)을
 * 읽어야 돌아가고, 그것은 §9 의 "동의 없이 실행하지 않는다" 와 충돌한다.
 *
 * 그래서 Phase 9 는 **좁고 정밀한 룰만** 둔다. 판단 기준은 하나다 —
 * **fixture 에서 오탐 0 을 낼 만큼 모양이 분명한가.** 아니면 넣지 않는다.
 */

import { stripComments } from "./strip.js";

export interface SourceFinding {
  ruleId: string;
  title: string;
  description: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  file: string;
  line: number;
  symbol: string | null;
  impact: string;
  recommendation: string;
}

/** 줄 번호(1부터)를 찾는다. */
function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

function* matches(text: string, re: RegExp): Generator<RegExpExecArray> {
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    yield m;
    if (m[0] === "") rx.lastIndex += 1;
  }
}

// ── SQL 조립 ──────────────────────────────────────────────────────────
/**
 * SQL 문자열에 변수를 이어 붙이는 모양만 잡는다.
 * 리터럴이 SQL 키워드로 시작하고 `+` 뒤에 식별자가 오는 경우로 한정한다.
 */
/**
 * SQL 키워드로 **시작만** 하는 문자열은 SQL 이 아니다.
 * 실측에서 `log("warn", "UPDATE 건너뜀 — " + record.marker)` 가 걸렸다.
 * 진짜 SQL 은 FROM·INTO·SET·WHERE 같은 절이 함께 온다.
 */
const SQL_CONCAT = /"(?:\s*)(SELECT|INSERT|UPDATE|DELETE)\b[^"]*\b(FROM|INTO|SET|WHERE|VALUES|JOIN)\b[^"]*"\s*\+\s*[A-Za-z_$]/i;

export function findSqlConcat(file: string, text: string): SourceFinding[] {
  const out: SourceFinding[] = [];
  for (const m of matches(text, SQL_CONCAT)) {
    out.push({
      ruleId: "SRC-SQL-CONCAT",
      title: "사용자 입력을 이어 붙여 SQL을 만듭니다",
      description:
        `${file} 에서 SQL 문자열에 변수를 그대로 이어 붙입니다. ` +
        "값이 따옴표를 포함하면 쿼리 구조 자체가 바뀝니다.",
      severity: "CRITICAL",
      file,
      line: lineAt(text, m.index),
      symbol: null,
      impact: "인증 우회, 전체 데이터 열람·삭제가 가능해집니다.",
      recommendation:
        "바인딩 파라미터(`?` 또는 `:name`)를 쓰세요. LIKE 검색도 파라미터로 넘길 수 있습니다.",
    });
  }
  return out;
}

// ── 빈 catch ──────────────────────────────────────────────────────────
/** `catch (...) { }` 안에 주석·공백만 있는 경우. */
const EMPTY_CATCH = /catch\s*\([^)]*\)\s*\{(\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)?\s*)\}/;

export function findEmptyCatch(file: string, text: string): SourceFinding[] {
  const out: SourceFinding[] = [];
  for (const m of matches(text, EMPTY_CATCH)) {
    out.push({
      ruleId: "SRC-EMPTY-CATCH",
      title: "예외를 삼킵니다",
      description: `${file} 의 catch 블록이 비어 있습니다. 실패가 아무 데도 남지 않습니다.`,
      severity: "MEDIUM",
      file,
      line: lineAt(text, m.index),
      symbol: null,
      impact: "실패가 조용히 묻혀 사용자도 운영자도 문제를 인지하지 못합니다.",
      recommendation: "최소한 로그를 남기고, 호출자가 실패를 알 수 있게 되던지거나 결과로 표현하세요.",
    });
  }
  return out;
}

// ── Optional 무검사 ───────────────────────────────────────────────────
/** `findXxx(...).get()` — 존재 확인 없이 꺼내는 모양. */
const OPTIONAL_GET = /\b(find\w*|getOptional\w*)\s*\([^;\n]*?\)\s*\.\s*get\s*\(\s*\)/;

export function findOptionalGet(file: string, text: string): SourceFinding[] {
  const out: SourceFinding[] = [];
  for (const m of matches(text, OPTIONAL_GET)) {
    out.push({
      ruleId: "SRC-OPTIONAL-GET",
      title: "Optional을 확인 없이 꺼냅니다",
      description:
        `${file} 에서 \`${m[1]}(...).get()\` 을 존재 확인 없이 호출합니다. ` +
        "값이 없으면 NoSuchElementException 이 그대로 500 이 됩니다.",
      severity: "MEDIUM",
      file,
      line: lineAt(text, m.index),
      symbol: m[1] ?? null,
      impact: "없는 데이터를 조회하거나 참조가 비면 화면에 500만 보입니다.",
      recommendation:
        "`orElseThrow(() -> new NotFoundException(...))` 처럼 의미 있는 예외로 바꾸거나 " +
        "`orElse` 로 기본값을 주세요.",
    });
  }
  return out;
}

// ── 소스에 박힌 시크릿 ────────────────────────────────────────────────
/**
 * **시크릿 파일이 아니라 일반 소스 안의 시크릿**이다(§16-1 의 경계 사례).
 * 값은 절대 결과에 담지 않는다 — 담으면 이 도구가 새 유출 경로가 된다.
 */
const HARDCODED_SECRET =
  /\b(?:const|let|var|static\s+final\s+String|String|val)\s+([A-Za-z_$][\w$]*(?:TOKEN|SECRET|APIKEY|API_KEY|PASSWORD|CREDENTIAL)[\w$]*)\s*(?::[^=]+)?=\s*["']([^"']{8,})["']/i;

/** 자리표시자는 시크릿이 아니다. */
const PLACEHOLDER = /^(x{3,}|\.{3,}|<[^>]+>|\$\{[^}]*\}|change[_-]?me|your[_-]|todo|placeholder|example|dummy)/i;

export function findHardcodedSecret(file: string, text: string): SourceFinding[] {
  const out: SourceFinding[] = [];
  for (const m of matches(text, HARDCODED_SECRET)) {
    const name = m[1]!;
    const value = m[2]!;
    if (PLACEHOLDER.test(value)) continue;
    out.push({
      ruleId: "SRC-HARDCODED-SECRET",
      title: `자격증명이 소스에 박혀 있습니다: ${name}`,
      description:
        `${file} 의 \`${name}\` 에 값이 그 자리에 있습니다. ` +
        "값은 여기에 옮기지 않습니다 — 리포트가 또 하나의 유출 경로가 되면 안 됩니다.",
      severity: "CRITICAL",
      file,
      line: lineAt(text, m.index),
      symbol: name,
      impact:
        "프런트엔드면 번들에 그대로 실려 누구나 볼 수 있고, 저장소 이력에도 영구히 남습니다.",
      recommendation:
        "환경변수나 비밀 저장소로 옮기고, **이미 노출된 값은 폐기·재발급**하세요. " +
        "코드에서 지우는 것만으로는 이력에 남은 값이 사라지지 않습니다.",
    });
  }
  return out;
}

// ── 비밀번호 평문 저장 ────────────────────────────────────────────────
/**
 * 요청에서 받은 비밀번호를 그대로 저장하는 모양.
 *
 * **파일 어디에도 인코더가 없을 때만** 보고한다. 인코더를 쓰면서 다른 경로로
 * 원문을 넘기는 경우까지 잡으려 들면 오탐이 난다.
 */
const SET_PASSWORD_RAW = /\.\s*setPassword\s*\(\s*\w+\s*\.\s*get\w*\s*\(\s*\)\s*\)/;
const ENCODER = /PasswordEncoder|\.encode\s*\(|BCrypt|Argon2|scrypt|pbkdf2/i;

export function findPlainPassword(file: string, text: string): SourceFinding[] {
  if (ENCODER.test(text)) return [];
  const out: SourceFinding[] = [];
  for (const m of matches(text, SET_PASSWORD_RAW)) {
    out.push({
      ruleId: "SRC-PLAIN-PASSWORD",
      title: "비밀번호를 인코딩 없이 저장합니다",
      description:
        file + " 에서 요청으로 받은 비밀번호를 그대로 저장합니다. 이 파일에는 인코더 사용 흔적이 없습니다.",
      severity: "CRITICAL",
      file,
      line: lineAt(text, m.index),
      symbol: null,
      impact: "DB가 한 번 유출되면 전 계정이 즉시 뚫립니다. 다른 서비스의 계정까지 위험해집니다.",
      recommendation: "PasswordEncoder(BCrypt 등)로 해시해 저장하고, 기존 데이터는 재설정 절차를 두세요.",
    });
  }
  return out;
}

// ── XSS ───────────────────────────────────────────────────────────────
/** 리터럴이 아닌 값을 그대로 HTML 로 넣는 모양. */
const RAW_HTML = /dangerouslySetInnerHTML\s*=\s*\{\{\s*__html\s*:\s*(?!["'])/;
const INNER_HTML = /\.innerHTML\s*=\s*(?!["'])/;

export function findRawHtml(file: string, text: string): SourceFinding[] {
  const out: SourceFinding[] = [];
  for (const re of [RAW_HTML, INNER_HTML]) {
    for (const m of matches(text, re)) {
      out.push({
        ruleId: "SRC-RAW-HTML",
        title: "외부에서 온 값을 그대로 HTML로 넣습니다",
        description: `${file} 에서 이스케이프 없이 HTML 을 주입합니다.`,
        severity: "HIGH",
        file,
        line: lineAt(text, m.index),
        symbol: null,
        impact:
          "저장형 XSS 경로입니다. 관리자 화면에서 실행되면 관리자 세션이 그대로 탈취됩니다.",
        recommendation:
          "텍스트로 렌더링하세요. HTML 이 꼭 필요하면 서버·클라이언트 양쪽에서 새니타이즈하세요.",
      });
    }
  }
  return out;
}

// ── fetch 오류 처리 ───────────────────────────────────────────────────
/**
 * 함수 단위로 본다. 파일 전체에서 `.ok` 를 찾으면 다른 함수의 검사를
 * 이 함수의 것으로 착각한다.
 */
function functionBodies(text: string): Array<{ name: string; body: string; offset: number }> {
  const out: Array<{ name: string; body: string; offset: number }> = [];
  const head = /(?:export\s+)?(?:async\s+)?function\s+(\w+)[^{]*\{|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(text)) !== null) {
    const start = text.indexOf("{", m.index + m[0].length - 1);
    if (start < 0) continue;
    let depth = 0;
    let end = start;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    out.push({ name: m[1] ?? m[2] ?? "", body: text.slice(start, end + 1), offset: start });
  }
  return out;
}

export function findFetchIssues(file: string, text: string): SourceFinding[] {
  const out: SourceFinding[] = [];

  for (const fn of functionBodies(text)) {
    if (!/\bfetch\s*\(/.test(fn.body)) continue;

    // 1) 응답을 파싱하면서 상태를 확인하지 않는다.
    if (/\.\s*json\s*\(\s*\)/.test(fn.body) && !/\.\s*ok\b|\bstatus\s*[=!<>]/.test(fn.body)) {
      const at = fn.body.search(/\.\s*json\s*\(\s*\)/);
      out.push({
        ruleId: "SRC-FETCH-NO-CHECK",
        title: `응답 상태를 확인하지 않습니다: ${fn.name}`,
        description:
          `${file} 의 \`${fn.name}\` 이 \`res.ok\` 확인 없이 본문을 파싱합니다. ` +
          "4xx·5xx 응답도 정상 데이터처럼 흘러갑니다.",
        severity: "MEDIUM",
        file,
        line: lineAt(text, fn.offset + at),
        symbol: fn.name,
        impact: "서버 오류가 화면에서는 '빈 목록'처럼 보여 사용자가 문제를 인지하지 못합니다.",
        recommendation: "`if (!res.ok) throw ...` 로 실패를 드러내고 화면에 안내하세요.",
      });
    }

    // 2) 결과를 아무도 받지 않는 fetch. await 도 return 도 catch 도 없다.
    for (const m of matches(fn.body, /(^|[\s;{])fetch\s*\(/)) {
      const before = fn.body.slice(Math.max(0, m.index - 40), m.index + m[0].length);
      if (/(await|return|=|\.then|\bof\b)\s*$/.test(before.replace(/fetch\s*\($/, ""))) continue;
      const after = fn.body.slice(m.index, m.index + 400);
      if (/\.\s*catch\s*\(/.test(after)) continue;
      out.push({
        ruleId: "SRC-FETCH-UNHANDLED",
        title: `실패를 처리하지 않는 요청입니다: ${fn.name}`,
        description:
          `${file} 의 \`${fn.name}\` 이 응답을 기다리지도 실패를 잡지도 않습니다.`,
        severity: "MEDIUM",
        file,
        line: lineAt(text, fn.offset + m.index),
        symbol: fn.name,
        impact: "저장·삭제가 실패해도 화면은 성공한 것처럼 넘어갑니다.",
        recommendation: "`await` 로 결과를 확인하거나 최소한 `.catch()` 로 실패를 처리하세요.",
      });
    }
  }
  return out;
}

/**
 * 파일 하나에 대한 전체 룰. 언어에 맞는 것만 돌린다.
 *
 * **주석을 지운 뒤에 돌린다.** 주석이 판정을 바꾸면 채점이 거짓말이 된다.
 * 줄 번호는 유지되므로 결과의 위치는 원문 기준 그대로다.
 */
export function runFileRules(file: string, raw: string): SourceFinding[] {
  const text = stripComments(raw);
  const p = file.toLowerCase();
  const isJvm = p.endsWith(".java") || p.endsWith(".kt");
  const isWeb = /\.(ts|tsx|js|jsx|mjs|cjs|vue)$/.test(p);

  const out: SourceFinding[] = [];
  if (isJvm) {
    out.push(...findSqlConcat(file, text));
    out.push(...findEmptyCatch(file, text));
    out.push(...findOptionalGet(file, text));
    out.push(...findHardcodedSecret(file, text));
    out.push(...findPlainPassword(file, text));
  }
  if (isWeb) {
    out.push(...findSqlConcat(file, text));
    out.push(...findHardcodedSecret(file, text));
    out.push(...findRawHtml(file, text));
    out.push(...findFetchIssues(file, text));
  }
  return out;
}
