import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeRef, IssueCandidate, RunConfig } from "@qa/shared";
import { emit, log } from "../emitter.js";
import { sha1 } from "../normalize.js";
import type { RunContext } from "../run-context.js";
import { scanProject, type ProjectScan } from "./scan.js";
import { isSecretKey, readYamlKeyPaths, readConfigKeys } from "./secrets.js";
import { extractSpringEndpoints, isMutating, unauthorizedEndpoints, type ExtractedEndpoint } from "./endpoints.js";
import { runFileRules, type SourceFinding } from "./rules.js";
import { runBuildAndTest, type CommandResult } from "./build-test.js";

/**
 * Source QA 오케스트레이터.
 *
 * 이 모듈이 만드는 것은 **`IssueCandidate[]` 하나뿐**이다.
 * 중복제거·심각도·우선순위·리포트는 1부에서 만든 judge 가 그대로 처리한다.
 * 새 파이프라인을 만들지 않는 것이 이 확장이 싸게 붙는 이유다.
 */

export interface SourceQaOutcome {
  scan: ProjectScan;
  endpoints: ExtractedEndpoint[];
  candidates: IssueCandidate[];
  /** 하지 않은 것. 조용히 끝내면 사용자는 전부 봤다고 착각한다. */
  unverified: string[];
  /** 실제로 실행한 명령. 동의가 없으면 빈 배열이다. */
  commands: CommandResult[];
}

let seq = 0;

function candidateOf(input: {
  ruleId: string;
  title: string;
  description: string;
  severity: IssueCandidate["suggestedSeverity"];
  screenName: string;
  codeRefs: CodeRef[];
  evidenceId: string;
}): IssueCandidate {
  seq += 1;
  const primary = input.codeRefs[0];
  return {
    id: `src-${String(seq).padStart(4, "0")}`,
    source: "source",
    // 소스에서 직접 찾은 결함이라 특정 요청에서 난 것이 아니다.
    apiRef: null,
    ruleId: input.ruleId,
    title: input.title,
    description: input.description,
    // 소스 결함에는 화면 상태가 없다. 파일·줄이 그 자리를 대신한다.
    stateKey: sha1(`${primary?.file ?? ""}|${primary?.line ?? 0}`),
    screenName: input.screenName,
    suggestedSeverity: input.severity,
    dedupKey: sha1(`source|${input.ruleId}|${primary?.file ?? ""}|${primary?.line ?? 0}`),
    evidenceIds: [input.evidenceId],
    codeRefs: input.codeRefs,
    aiRationale: null,
    detectedAt: new Date().toISOString(),
  };
}

function findingToCandidate(f: SourceFinding, evidenceId: string): IssueCandidate {
  return candidateOf({
    ruleId: f.ruleId,
    title: f.title,
    description: [f.description, "", `영향: ${f.impact}`, `권장: ${f.recommendation}`].join("\n"),
    severity: f.severity,
    screenName: f.file,
    codeRefs: [{ file: f.file, line: f.line, symbol: f.symbol, confidence: 1, reason: "룰이 직접 지목한 위치" }],
    evidenceId,
  });
}

/**
 * 설정 파일에서 평문 자격증명을 찾는다.
 *
 * **값을 읽지 않는다** (CLAUDE.md §16-1). 키 이름과 값의 *모양*만 본다.
 * `${DB_PASSWORD}` 처럼 환경변수를 참조하면 정상이므로 걸러진다.
 */
function configSecretFindings(rootDir: string, scan: ProjectScan): SourceFinding[] {
  const out: SourceFinding[] = [];

  for (const file of scan.files) {
    if (file.access !== "keys-only") continue;
    /*
     * 대상은 **일반 설정 파일**이다. `secrets.properties` 나 `.env` 처럼
     * 시크릿을 담으라고 만든 파일은 제외한다 — 거기 값이 있는 것은 그 파일의
     * 목적이고, 키마다 결함을 올리면 잡음만 늘어난다.
     */
    if (!/(^|\/)application(-[a-z0-9]+)?\.(ya?ml|properties)$/i.test(file.path)) continue;
    const isYaml = /\.ya?ml$/i.test(file.path);

    let text = "";
    try {
      text = readFileSync(join(rootDir, file.path), "utf8");
    } catch {
      continue;
    }

    const keys = isYaml ? readYamlKeyPaths(text) : readConfigKeys(text);
    for (const k of keys) {
      if (!isSecretKey(k.key) || k.valueShape !== "literal") continue;
      out.push({
        ruleId: "SRC-CONFIG-SECRET",
        title: `설정 파일에 자격증명이 평문으로 있습니다: ${k.key}`,
        description:
          `${file.path} 의 \`${k.key}\` 가 환경변수 참조가 아니라 값을 직접 담고 있습니다. ` +
          "값은 읽지 않았습니다 — 키 이름과 값의 모양만으로 판정했습니다.",
        severity: /prod|production|live/i.test(file.path) ? "HIGH" : "MEDIUM",
        file: file.path,
        line: k.line,
        symbol: k.key,
        impact: "저장소에 접근할 수 있는 모든 사람이 운영 자격증명을 갖게 됩니다.",
        recommendation:
          "환경변수나 비밀 저장소로 옮기고, 이미 커밋된 값은 폐기·재발급하세요.",
      });
    }
  }
  return out;
}

/** 권한 검사가 빠진 엔드포인트를 후보로 바꾼다. */
function authzCandidates(open: ExtractedEndpoint[], evidenceId: string): IssueCandidate[] {
  return open.map((e) =>
    candidateOf({
      ruleId: "SRC-AUTHZ-MISSING",
      title: `권한 검사가 없는 엔드포인트: ${e.method} ${e.path}`,
      description:
        `${e.file} 의 \`${e.symbol}\` 에 권한 애너테이션이 없습니다. ` +
        "같은 컨트롤러의 다른 엔드포인트에는 있습니다 — 일괄 정책이 아니라 빠뜨린 것으로 보입니다.\n\n" +
        "영향: 인증만 통과하면 권한이 없는 사용자도 이 기능을 호출할 수 있습니다.\n" +
        "권장: 형제 엔드포인트와 같은 권한 애너테이션을 붙이고, 서비스 계층에서도 한 번 더 확인하세요.\n\n" +
        "이 결함은 실행 QA로는 찾을 수 없습니다. 위험 액션은 차단하는 것이 정답이라 실행되지 않기 때문입니다.",
      severity: isMutating(e.method) ? "CRITICAL" : "HIGH",
      screenName: e.file,
      codeRefs: [
        {
          file: e.file,
          line: e.line,
          symbol: e.symbol,
          confidence: 1,
          reason: "매핑 애너테이션에서 직접 확정한 핸들러",
        },
      ],
      evidenceId,
    }),
  );
}

export function runSourceQa(config: RunConfig, ctx: RunContext): SourceQaOutcome {
  const rootDir = config.source.rootDir;
  log("info", `소스 스캔 시작: ${rootDir}`);

  const scan = scanProject(rootDir, {
    maxFiles: config.source.maxFiles,
    maxFileBytes: config.source.maxFileBytes,
    maxTotalBytes: config.source.maxTotalBytes,
  });

  log(
    "info",
    `스캔 완료: 파일 ${scan.files.length}개 · ${Math.round(scan.totalBytes / 1024)}KB · ` +
      `스택 ${scan.stack.join(", ") || "판별 실패"}`,
  );
  for (const limit of scan.limits) log("warn", `스캔 제한: ${limit}`);

  const evidenceId = ctx.addEvidence({
    kind: "source",
    path: "source/scan.json",
    stateKey: sha1(rootDir),
    screenName: "소스 스캔",
    summary:
      `파일 ${scan.files.length}개 · 스택 ${scan.stack.join(", ") || "판별 실패"} · ` +
      `열지 않은 파일 ${scan.files.filter((f) => f.access !== "read").length}개`,
  }).id;
  ctx.writeJson("source", "scan.json", {
    // 절대 경로는 남기지 않는다. 사용자 폴더 구조가 리포트로 나가면 안 된다.
    fileCount: scan.files.length,
    totalBytes: scan.totalBytes,
    stack: scan.stack,
    limits: scan.limits,
    runnableCommands: scan.runnableCommands,
    files: scan.files.map((f) => ({ path: f.path, lang: f.lang, access: f.access, bytes: f.bytes })),
  });

  const findings: SourceFinding[] = [];
  const endpoints: ExtractedEndpoint[] = [];

  for (const file of scan.files) {
    // 열지 않는 파일. 존재만 안다.
    if (file.access === "presence-only") continue;

    if (file.access === "keys-only") continue; // 아래 configSecretFindings 가 키만 본다

    let text = "";
    try {
      text = readFileSync(join(rootDir, file.path), "utf8");
    } catch {
      continue;
    }

    findings.push(...runFileRules(file.path, text));
    if (file.lang === "java") endpoints.push(...extractSpringEndpoints(file.path, text));
  }

  findings.push(...configSecretFindings(rootDir, scan));

  /*
   * 빌드·테스트 실행. **동의가 없으면 아무것도 돌지 않는다.**
   * 정적 분석이 끝난 뒤에 돈다 — 명령이 프로젝트 파일을 바꿀 수 있고,
   * 그러면 앞서 본 것과 결과가 어긋난다.
   */
  const build = runBuildAndTest(config, scan, evidenceId);

  const open = unauthorizedEndpoints(endpoints);
  const candidates = [
    ...authzCandidates(open, evidenceId),
    ...findings.map((f) => findingToCandidate(f, evidenceId)),
    ...build.candidates,
  ];

  ctx.writeJson("source", "endpoints.json", endpoints);

  /*
   * 하지 않은 것을 반드시 적는다.
   * 소스 QA 는 "결함 0건"이 쉽게 나오는 영역이라, 무엇을 안 봤는지 적지 않으면
   * 리포트가 거짓 안심을 준다.
   */
  const unverified: string[] = [...build.notRun];
  unverified.push(
    "의존성 취약점 점검을 하지 않았습니다. `npm audit` 등 외부 도구 실행에는 동의가 필요합니다.",
  );
  const presenceOnly = scan.files.filter((f) => f.access === "presence-only");
  if (presenceOnly.length > 0) {
    unverified.push(
      `키·인증서 파일 ${presenceOnly.length}건은 열지 않았습니다: ${presenceOnly.map((f) => f.path).join(", ")}`,
    );
  }
  for (const limit of scan.limits) unverified.push(`스캔 제한: ${limit}`);

  emit({
    type: "run:progress",
    at: new Date().toISOString(),
    screensExplored: scan.files.length,
    screensQueued: 0,
    actionsExecuted: 0,
    currentTask: "소스 분석",
    currentScreen: scan.stack.join(", ") || rootDir,
  });

  log("info", `소스 결함 후보 ${candidates.length}건 (엔드포인트 ${endpoints.length}개 중 권한 누락 ${open.length}건)`);

  if (build.results.length > 0) {
    ctx.writeJson("source", "commands.json", build.results);
  }

  return { scan, endpoints, candidates, unverified, commands: build.results };
}
