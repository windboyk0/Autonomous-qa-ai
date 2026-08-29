import {
  FunctionalAnalysisResult,
  IssueJudgeResult,
  PageAnalysisResult,
  VisualAnalysisResult,
  type FunctionalAnalysisInput,
  type IssueJudgeInput,
  type PageAnalysisInput,
  type ReportInput,
  type VisualAnalysisInput,
} from "@qa/shared";
import { scrub } from "../emitter.js";

/**
 * 프롬프트 정의.
 *
 * Provider 구현체가 공유한다 — Ollama와 Claude에 같은 질문을 던져야
 * 리포트 목차가 같아진다.
 *
 * **모든 프롬프트는 scrub()을 거친다.** 비밀번호나 토큰이 DOM·네트워크 요약에
 * 섞여 들어가 외부 모델로 나가면 안 된다.
 */

export const SYSTEM_PROMPT = [
  "당신은 관리자웹 QA 결과를 검토하는 한국어 QA 엔지니어입니다.",
  "",
  "규칙:",
  "1. 주어진 관측 사실만 사용하세요. 보지 않은 것을 지어내지 마세요.",
  "2. PASS/FAIL 판정을 뒤집지 마세요. 이미 정해진 판정의 원인과 개선안만 쓰세요.",
  "3. 설명이나 코드블록 없이 JSON 객체 하나만 출력하세요.",
  "4. 모든 문장은 한국어로 쓰세요.",
].join("\n");

export interface Prompt {
  label: string;
  user: string;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(이하 생략)`;
}

// ── analyzePage ───────────────────────────────────────────────────────
export const PageAnalysisSchema = PageAnalysisResult;

export function pageAnalysisPrompt(input: PageAnalysisInput): Prompt {
  return {
    label: "analyzePage",
    user: scrub(
      [
        `화면 이름: ${input.state.screenName}`,
        `경로: ${input.state.signals.pathTemplate}`,
        "",
        "화면에 보이는 텍스트:",
        truncate(input.visibleText, 1500),
        "",
        "DOM 개요:",
        truncate(input.domOutline, 1500),
        "",
        "이 화면이 어떤 업무를 위한 화면인지 한 줄로 쓰고,",
        "관리자 업무 흐름상 당연히 있어야 하는데 보이지 않는 기능이 있으면 후보로 적으세요.",
        "확신이 없으면 빈 배열로 두세요. 추측으로 채우지 마세요.",
        "",
        'JSON 형식: {"screenPurpose": string, "missingFeatureCandidates": string[], "notes": string[]}',
      ].join("\n"),
    ),
  };
}

// ── analyzeFunction ───────────────────────────────────────────────────
export const FunctionalAnalysisSchema = FunctionalAnalysisResult;

export function functionalAnalysisPrompt(input: FunctionalAnalysisInput): Prompt {
  const net = input.networkEntries
    .slice(0, 12)
    .map((n) => `- ${n.method} ${n.endpointTemplate} → ${n.status ?? n.failureText} (${n.durationMs}ms)`)
    .join("\n");
  const con = input.consoleEntries
    .slice(0, 8)
    .map((c) => `- [${c.level}] ${c.text.slice(0, 200)}`)
    .join("\n");

  const f = input.finding;

  return {
    label: "analyzeFunction",
    user: scrub(
      [
        "다음 결함에 대해 설명하세요.",
        "",
        `결함: ${f.title}`,
        `종류: ${f.ruleId}`,
        `상세: ${truncate(f.description, 800)}`,
        `발생: ${f.occurrenceCount}회 / 화면 ${f.screens.length}개 (${f.screens.slice(0, 5).join(", ")})`,
        `룰 판정: ${input.ruleVerdict} (관측된 사실이며 바꿀 수 없습니다)`,
        "",
        input.action
          ? `직접 관련된 동작: "${input.action.action.label}" (${input.action.action.type}) — ${input.action.action.screenName}`
          : "특정 동작에 귀속되지 않는 결함입니다. 위 사실만으로 설명하세요.",
        "",
        net ? `네트워크:\n${net}` : "",
        con ? `콘솔:\n${con}` : "",
        "",
        "위 사실의 원인, 사용자 업무에 미치는 영향, 개발자가 취할 조치를 각각 한두 문장으로 쓰세요.",
        "**위에 없는 화면이나 기능을 언급하지 마세요.** 모르면 확신도를 낮게 주세요.",
        "확신 정도를 0~1 사이 숫자로 함께 적으세요.",
        "",
        'JSON 형식: {"rootCause": string, "impact": string, "recommendation": string, "confidence": number}',
      ]
        .filter((line) => line !== "")
        .join("\n"),
    ),
  };
}

// ── analyzeScreenshot ─────────────────────────────────────────────────
export const VisualAnalysisSchema = VisualAnalysisResult;

export function visualAnalysisPrompt(input: VisualAnalysisInput): Prompt {
  const m = input.metrics;
  return {
    label: "analyzeScreenshot",
    user: scrub(
      [
        `화면: ${input.screenName}`,
        "",
        "룰 검출기가 이미 측정한 값 (이 위에 얹어서만 이야기하세요):",
        `- 가로 오버플로: ${m.hasHorizontalOverflow} (콘텐츠 ${m.scrollWidth}px / 뷰포트 ${m.viewportWidth}px)`,
        `- 겹침 ${m.overlappingPairs.length}건, 잘림 ${m.truncatedTexts.length}건, 가려진 버튼 ${m.obscuredCtas.length}건`,
        `- 빈 영역 비율 ${m.emptyAreaRatio.toFixed(2)}`,
        "",
        "관리자 업무 화면으로서 읽기 어려운 점, 정보 밀도, 정렬, 여백, 표 가독성을 검토하세요.",
        "이미 위에 적힌 사실을 그대로 반복하지 말고, 화면을 보고 판단한 것만 적으세요.",
        "",
        'JSON 형식: {"findings": [{"title": string, "severity": "CRITICAL"|"HIGH"|"MEDIUM"|"LOW", "area": string, "description": string, "recommendation": string}], "overallImpression": string}',
      ].join("\n"),
    ),
  };
}

// ── judgeIssues ───────────────────────────────────────────────────────
export const IssueJudgeSchema = IssueJudgeResult;

export function issueJudgePrompt(input: IssueJudgeInput): Prompt {
  const list = input.candidates
    .map(
      (c) =>
        `- id=${c.id} 룰=${c.ruleId} 심각도=${c.suggestedSeverity} 화면="${c.screenName}" 제목="${c.title.slice(0, 90)}"`,
    )
    .join("\n");

  return {
    label: "judgeIssues",
    user: scrub(
      [
        "아래는 룰 기반 중복 제거를 이미 마친 Issue 목록입니다.",
        "",
        list,
        "",
        "할 일:",
        "1. 서로 다른 항목이지만 같은 근본 원인으로 보이면 mergeGroups로 묶으세요.",
        "   룰이 이미 묶은 것을 쪼갤 수는 없습니다. 추가 병합만 제안할 수 있습니다.",
        "2. 명백히 결함이 아닌 것(정상 동작, 의도된 빈 상태 등)은 falsePositiveIds에 넣으세요.",
        "   확신이 없으면 넣지 마세요. 실제 결함을 지우는 쪽이 훨씬 큰 손해입니다.",
        "3. 심각도가 명백히 잘못된 것만 severityOverrides에 사유와 함께 적으세요.",
        "",
        "고칠 것이 없으면 세 배열을 모두 비워서 반환하세요.",
        "",
        'JSON 형식: {"mergeGroups": [{"groupId": string, "candidateIds": string[]}], "falsePositiveIds": string[], "severityOverrides": [{"candidateId": string, "severity": string, "reason": string}]}',
      ].join("\n"),
    ),
  };
}

// ── generateReport ────────────────────────────────────────────────────
export function reportSummaryPrompt(input: ReportInput): Prompt {
  const top = input.issues
    .slice(0, 10)
    .map((i) => `- ${i.id} [${i.severity}/${i.priority}] ${i.title} (${i.screens.length}개 화면)`)
    .join("\n");
  const c = input.summary.issueCounts;

  return {
    label: "generateReport",
    user: scrub(
      [
        `대상: ${input.summary.config.projectName} (${input.summary.config.targetUrl})`,
        `탐색 화면 ${input.summary.screensExplored}개, 실행 액션 ${input.summary.actionsExecuted}건`,
        `Issue: Critical ${c.critical} · High ${c.high} · Medium ${c.medium} · Low ${c.low}`,
        "",
        top || "발견된 Issue 없음",
        "",
        "위 결과를 담당자에게 보고하는 요약을 3~5문장으로 쓰세요.",
        "가장 급한 것을 첫 문장에 두고, 숫자를 지어내지 마세요.",
        "",
        'JSON 형식: {"summary": string}',
      ].join("\n"),
    ),
  };
}
