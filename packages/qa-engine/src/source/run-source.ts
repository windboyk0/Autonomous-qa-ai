import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeRef, IssueCandidate, RunConfig } from "@qa/shared";
import { emit, log } from "../emitter.js";
import { sha1 } from "../normalize.js";
import type { RunContext } from "../run-context.js";
import { scanProject, type ProjectScan } from "./scan.js";
import { isSecretKey, readYamlKeyPaths, readConfigKeys } from "./secrets.js";
import {
  extractSpringEndpoints,
  isMutating,
  unauthorizedEndpoints,
  type AuthzGap,
  type ExtractedEndpoint,
} from "./endpoints.js";
import { readSecurityConfig, type SecurityRules } from "./security-config.js";
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
/** `src/test/` 아래인가. 테스트 설정은 운영 설정과 무게가 다르다. */
function isTestScope(path: string): boolean {
  return /(^|\/)(src\/test|test|tests|__tests__|spec)\//i.test(path);
}

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
        /*
         * 테스트 설정의 더미 값을 운영 자격증명과 같은 무게로 올리면 안 된다.
         * `src/test/` 아래는 CI 에서 쓰는 고정값인 것이 보통이다(실측에서 여기서 3건).
         */
        severity: isTestScope(file.path)
          ? "LOW"
          : /prod|production|live/i.test(file.path)
            ? "HIGH"
            : "MEDIUM",
        file: file.path,
        line: k.line,
        symbol: k.key,
        impact: isTestScope(file.path)
          ? "테스트 전용 설정입니다. 값이 운영과 같다면 그때는 실제 위험이 됩니다."
          : "저장소에 접근할 수 있는 모든 사람이 운영 자격증명을 갖게 됩니다.",
        recommendation:
          "환경변수나 비밀 저장소로 옮기고, 이미 커밋된 값은 폐기·재발급하세요.",
      });
    }
  }
  return out;
}

/**
 * 권한 검사가 빠진 엔드포인트를 후보로 바꾼다.
 *
 * **빠졌다는 사실과 그것이 뜻하는 바는 다르다.**
 * 전역으로 인증이 강제되는 프로젝트에서 애너테이션이 없다는 것은
 * "아무나 호출 가능"이 아니라 "로그인한 누구나 호출 가능"이다.
 * 둘을 같은 CRITICAL 로 올렸더니 실측에서 28건 대부분이 과장이었다.
 */
function authzCandidates(
  gaps: Array<{ endpoint: ExtractedEndpoint; gap: AuthzGap }>,
  rules: SecurityRules,
  evidenceId: string,
): IssueCandidate[] {
  return gaps.map(({ endpoint: e, gap }) => {
    const open = gap === "open";
    const where = rules.file ? ` (${rules.file})` : "";

    return candidateOf({
      ruleId: open ? "SRC-AUTHZ-MISSING" : "SRC-AUTHZ-NO-ROLE",
      title: open
        ? `권한 검사가 없는 엔드포인트: ${e.method} ${e.path}`
        : `역할 제한이 없는 엔드포인트: ${e.method} ${e.path}`,
      description:
        `${e.file} 의 \`${e.symbol}\` 에 권한 애너테이션이 없습니다. ` +
        "같은 컨트롤러의 다른 엔드포인트에는 있습니다 — 일괄 정책이 아니라 빠뜨린 것으로 보입니다.\n\n" +
        (open
          ? "영향: 인증 여부도 확인되지 않아 누구든 이 기능을 호출할 수 있습니다.\n"
          : `영향: 인증은 전역 설정으로 강제되므로${where} 로그인하지 않은 사람은 막힙니다. ` +
            "다만 역할 제한이 없어 로그인한 사용자라면 누구나 호출할 수 있습니다. " +
            "본인 자원만 다루는 엔드포인트라면 의도된 것일 수 있으니 확인이 필요합니다.\n") +
        "권장: 형제 엔드포인트와 같은 권한 애너테이션을 붙이거나, 의도한 것이라면 " +
        "isAuthenticated() 로 명시해 다음 사람이 헷갈리지 않게 하세요.\n\n" +
        "이 결함은 실행 QA로는 찾을 수 없습니다. 위험 액션은 차단하는 것이 정답이라 실행되지 않기 때문입니다.",
      severity: open
        ? isMutating(e.method)
          ? "CRITICAL"
          : "HIGH"
        : isMutating(e.method)
          ? "HIGH"
          : "MEDIUM",
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
    });
  });
}

export function runSourceQa(
  config: RunConfig,
  ctx: RunContext,
  /**
   * 통합 모드에서 이미 탐색한 화면 수.
   *
   * 이것을 넘기지 않으면 소스 스캔이 진행 표시를 덮어써서, 화면 27개를 탐색해
   * 놓고도 Monitor 에 "505 화면"(= 스캔한 파일 수)이 뜬다. 실측에서 그랬다.
   */
  progress: { screensExplored?: number } = {},
): SourceQaOutcome {
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

  /*
   * 애너테이션만 보고 판단하면 안 된다. SecurityConfig 가 전역 규칙을 정하고 있고,
   * permitAll 로 열어 둔 경로는 의도적인 공개다.
   */
  const rules = readSecurityConfig(rootDir, scan);
  if (rules.found) {
    log(
      "info",
      "보안 설정: " + rules.file + " · 기본 " +
        (rules.authenticatedByDefault ? "인증 필요" : "규칙 없음") +
        " · 공개 경로 " + rules.publicMatchers.length + "개",
    );
  }

  const open = unauthorizedEndpoints(endpoints, rules);
  const candidates = [
    ...authzCandidates(open, rules, evidenceId),
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
    // 파일 수는 화면 수가 아니다. 탐색 결과를 덮어쓰지 않는다.
    screensExplored: progress.screensExplored ?? 0,
    screensQueued: 0,
    actionsExecuted: 0,
    currentTask: "소스 분석",
    currentScreen: `파일 ${scan.files.length}개${scan.stack.length > 0 ? ` · ${scan.stack.join(", ")}` : ""}`,
  });

  log("info", `소스 결함 후보 ${candidates.length}건 (엔드포인트 ${endpoints.length}개 중 권한 누락 ${open.length}건)`);

  if (build.results.length > 0) {
    ctx.writeJson("source", "commands.json", build.results);
  }

  return { scan, endpoints, candidates, unverified, commands: build.results };
}
