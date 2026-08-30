import { spawnSync } from "node:child_process";
import type { IssueCandidate, RunConfig } from "@qa/shared";
import { log, scrub } from "../emitter.js";
import { sha1 } from "../normalize.js";
import type { ProjectScan } from "./scan.js";

/**
 * Build / Test Agent.
 *
 * **이 모듈이 이 도구에서 가장 위험하다.** 대상 프로젝트의 명령을 실행한다는 것은
 * 그 프로젝트의 임의 코드를 사용자 권한으로 돌린다는 뜻이다.
 * `package.json` 의 script 도, gradle 태스크도, 린터 설정 파일도 전부 실행 가능한 코드다.
 *
 * **Windows 에는 진짜 샌드박스가 없다.** 컨테이너 없이는 격리가 되지 않는다.
 * 그러므로 실제 통제 수단은 격리가 아니라 이 셋이다.
 *
 *   1. 동의 없이는 **아무것도** 실행하지 않는다 (기본값 전부 false)
 *   2. 실행할 명령을 **문자 그대로** 사용자에게 보여준다
 *   3. 허용된 **모양**의 명령만 실행한다 — 임의 문자열은 실행하지 않는다
 *
 * 그리고 의존성 설치는 동의가 있어도 하지 않는다. 설치는 실행보다 넓은 권한이고,
 * QA 도구가 남의 프로젝트에 파일을 쓸 이유가 없다.
 */

const TIMEOUT_MS = 5 * 60 * 1000;
/** 출력이 아무리 길어도 이만큼만 증적에 남긴다. */
const MAX_OUTPUT = 40_000;

export interface PlannedCommand {
  command: string;
  purpose: "build" | "test" | "lint";
  /** 어느 파일에서 찾았는가 */
  from: string;
  /** 실행 디렉터리 (프로젝트 루트 기준 상대) */
  cwd: string;
}

/**
 * 실행이 허용된 명령의 모양.
 *
 * 임의 문자열을 셸에 넘기지 않는다. 이 목록에 없는 모양은 발견되어도 실행하지 않는다.
 * 설치·배포·마이그레이션은 애초에 여기 없다.
 */
const ALLOWED: Array<{ re: RegExp; file: string; args: (m: RegExpMatchArray) => string[] }> = [
  {
    re: /^npm run (build|test|lint)$/,
    file: "npm",
    args: (m) => ["run", m[1]!, "--silent"],
  },
  {
    re: /^\.\/gradlew (build|test)$/,
    file: "gradlew",
    args: (m) => [m[1]!, "--console=plain"],
  },
  { re: /^mvn (test|verify)$/, file: "mvn", args: (m) => [m[1]!, "-B"] },
];

/**
 * 동의한 것만 남긴다.
 *
 * 스캔은 실행 가능한 명령을 **찾기만** 한다(Phase 9). 여기서 동의와 대조해
 * 실제로 돌릴 것을 고른다. 동의가 없으면 빈 배열이고, 그것이 정상 동작이다.
 */
export function plannedCommands(scan: ProjectScan, config: RunConfig): PlannedCommand[] {
  const out: PlannedCommand[] = [];
  for (const c of scan.runnableCommands) {
    if (c.purpose === "build" && !config.source.allowBuild) continue;
    if ((c.purpose === "test" || c.purpose === "lint") && !config.source.allowTest) continue;
    if (!ALLOWED.some((a) => a.re.test(c.command))) continue;

    const cwd = c.from.includes("/") ? c.from.slice(0, c.from.lastIndexOf("/")) : ".";
    out.push({ command: c.command, purpose: c.purpose, from: c.from, cwd });
  }
  // 같은 명령을 같은 디렉터리에서 두 번 돌리지 않는다.
  return [...new Map(out.map((c) => [`${c.cwd}|${c.command}`, c])).values()];
}

export interface CommandResult extends PlannedCommand {
  exitCode: number | null;
  durationMs: number;
  output: string;
  /** 실행 자체가 불가능했던 이유 (명령이 없음 등) */
  error: string | null;
}

/**
 * 명령 하나를 돌린다.
 *
 * **허용 목록에서 뽑아낸 것만 넘긴다.** 사용자가 준 문자열을 그대로 실행하는
 * 경로는 없다 — 아래에서 Windows 한정으로 cmd.exe 를 거치지만, 그때 넘기는
 * 문자열도 상수와 `build|test|lint` 세 낱말로만 조립된다.
 */
export function runCommand(rootDir: string, planned: PlannedCommand): CommandResult {
  const allowed = ALLOWED.find((a) => a.re.test(planned.command));
  const match = planned.command.match(allowed?.re ?? /$^/);
  if (!allowed || !match) {
    return { ...planned, exitCode: null, durationMs: 0, output: "", error: "허용되지 않은 명령 모양입니다." };
  }

  const cwd = planned.cwd === "." ? rootDir : `${rootDir}/${planned.cwd}`;
  const isWin = process.platform === "win32";
  const args = allowed.args(match);

  /*
   * Windows 에서 npm·mvn 은 `.cmd` 래퍼이고, Node 20+ 는 보안 수정 이후
   * `.cmd` 를 직접 spawn 하지 못한다(EINVAL). 그래서 cmd.exe 를 거친다.
   *
   * 셸을 거치는 것은 위험한 일이지만, 여기서 넘기는 문자열에는 **사용자 입력이
   * 한 글자도 없다.** 도구 이름은 상수이고 인자는 허용 목록의 정규식이 잡아낸
   * `build|test|lint` 세 낱말뿐이다. 위험한 것은 셸 자체가 아니라 신뢰할 수 없는
   * 문자열을 셸에 넘기는 것이며, 그 경로는 여기 없다.
   */
  const gradle = allowed.file === "gradlew";
  const file = gradle
    ? isWin
      ? `${cwd}/gradlew.bat`
      : `${cwd}/gradlew`
    : isWin
      ? (process.env.ComSpec ?? "cmd.exe")
      : allowed.file;
  const argv =
    !gradle && isWin ? ["/d", "/s", "/c", [allowed.file, ...args].join(" ")] : args;

  const startedAt = Date.now();
  const res = spawnSync(file, argv, {
    cwd,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    windowsHide: true,
    // 환경변수를 그대로 물려주되, 우리 비밀번호가 섞여 있으면 안 된다.
    env: { ...process.env, QA_PASSWORD: undefined } as NodeJS.ProcessEnv,
  });

  const output = scrub(`${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim()).slice(0, MAX_OUTPUT);

  return {
    ...planned,
    exitCode: res.status,
    durationMs: Date.now() - startedAt,
    output,
    error: res.error ? String(res.error.message ?? res.error) : null,
  };
}

let seq = 0;

/** 실패한 명령을 결함 후보로 바꾼다. 성공은 후보를 만들지 않는다. */
export function commandCandidates(results: CommandResult[], evidenceId: string): IssueCandidate[] {
  const out: IssueCandidate[] = [];
  for (const r of results) {
    if (r.error === null && r.exitCode === 0) continue;
    seq += 1;

    const ruleId =
      r.error !== null
        ? "BUILD-NOT-RUNNABLE"
        : r.purpose === "test"
          ? "BUILD-TEST-FAILED"
          : r.purpose === "lint"
            ? "BUILD-LINT-FAILED"
            : "BUILD-FAILED";

    const tail = r.output.split(/\r?\n/).slice(-25).join("\n");

    out.push({
      id: `bt-${String(seq).padStart(4, "0")}`,
      source: "source",
      apiRef: null,
      ruleId,
      title:
        r.error !== null
          ? `명령을 실행하지 못했습니다: ${r.command}`
          : `${r.purpose === "test" ? "테스트" : r.purpose === "lint" ? "린트" : "빌드"} 실패: ${r.command}`,
      description:
        `\`${r.cwd}\` 에서 \`${r.command}\` 를 실행했습니다 (동의함). ` +
        (r.error !== null
          ? `실행 자체가 되지 않았습니다: ${r.error}`
          : `종료 코드 ${r.exitCode}, ${Math.round(r.durationMs / 1000)}초.`) +
        (tail ? `\n\n마지막 출력:\n${tail}` : ""),
      stateKey: sha1(`${r.cwd}|${r.command}`),
      screenName: r.from,
      suggestedSeverity: r.error !== null ? "LOW" : r.purpose === "lint" ? "LOW" : "HIGH",
      dedupKey: sha1(`build|${ruleId}|${r.cwd}|${r.command}`),
      evidenceIds: [evidenceId],
      codeRefs: [{ file: r.from, line: null, symbol: null, confidence: 1, reason: "이 명령이 정의된 파일" }],
      aiRationale: null,
      detectedAt: new Date().toISOString(),
    });
  }
  return out;
}

export interface BuildTestOutcome {
  results: CommandResult[];
  candidates: IssueCandidate[];
  /** 동의가 없어 실행하지 않은 것. 반드시 리포트에 남는다. */
  notRun: string[];
}

export function runBuildAndTest(
  config: RunConfig,
  scan: ProjectScan,
  evidenceId: string,
): BuildTestOutcome {
  const planned = plannedCommands(scan, config);
  const all = [...new Set(scan.runnableCommands.map((c) => c.command))];
  const willRun = new Set(planned.map((p) => p.command));
  const notRun = all
    .filter((c) => !willRun.has(c))
    .map((c) => `\`${c}\` — 동의하지 않아 실행하지 않았습니다.`);

  if (planned.length === 0) return { results: [], candidates: [], notRun };

  const results: CommandResult[] = [];
  for (const p of planned) {
    // 무엇을 돌리는지 로그에 그대로 남긴다. 나중에 "왜 이게 돌았지"가 없어야 한다.
    log("warn", `동의한 명령을 실행합니다: ${p.cwd} $ ${p.command}`);
    const r = runCommand(config.source.rootDir, p);
    log(
      r.exitCode === 0 ? "info" : "warn",
      `${p.command} → ${r.error ?? `종료 코드 ${r.exitCode}`} (${Math.round(r.durationMs / 1000)}초)`,
    );
    results.push(r);
  }

  return { results, candidates: commandCandidates(results, evidenceId), notRun };
}
