import { claudeAuthStatus, resolveClaudeCli, runClaude, searchedLocations } from "./claude-cli.js";
import { z } from "zod";
import type {
  AiProvider,
  AiProviderConfig,
  FunctionalAnalysisInput,
  FunctionalAnalysisResult,
  IssueJudgeInput,
  IssueJudgeResult,
  PageAnalysisInput,
  PageAnalysisResult,
  ProviderStatus,
  ReportInput,
  VisualAnalysisInput,
  VisualAnalysisResult,
} from "@qa/shared";
import { parseJson, retryOnce } from "./guard.js";
import {
  FunctionalAnalysisSchema,
  IssueJudgeSchema,
  PageAnalysisSchema,
  SYSTEM_PROMPT,
  VisualAnalysisSchema,
  functionalAnalysisPrompt,
  issueJudgePrompt,
  pageAnalysisPrompt,
  reportSummaryPrompt,
  visualAnalysisPrompt,
  type Prompt,
} from "./prompts.js";

/**
 * Claude Provider (PoC: Claude Code CLI).
 *
 * 원칙 (CLAUDE.md §6):
 * - **사용자의 Claude 인증을 그대로 쓴다.** 앱에 API 키를 내장하지 않는다.
 * - 인증정보를 하드코딩하지 않는다.
 *
 * 그래서 이 Provider는 사용자 PC에 Claude Code가 설치·로그인되어 있어야 동작한다.
 * preflight에서 그걸 확인하고, 없으면 무엇을 해야 하는지 알려준다.
 *
 * 제품화 시에는 Claude Agent SDK로 바꾼다 — 프롬프트와 스키마는 그대로 쓸 수 있다.
 */

const CliJsonOutput = z.object({
  result: z.string(),
});

export class ClaudeProvider implements AiProvider {
  constructor(private readonly config: AiProviderConfig) {}

  async healthCheck(): Promise<ProviderStatus> {
    const base: ProviderStatus = {
      available: false,
      kind: "claude",
      model: this.config.model || "(Claude Code 기본 모델)",
      visionCapable: true, // Claude는 Vision을 지원한다
      detail: "",
      remediation: null,
    };

    /*
     * PATH 에 없어도 설치되어 있을 수 있다. Electron 앱은 로그인 셸을 거치지 않아
     * 사용자 터미널의 PATH 와 다르다 — 터미널에서는 되는데 앱에서는 안 되는 상황이
     * 정상적으로 생긴다(실측). 그래서 알려진 설치 위치까지 찾아본다.
     */
    const exe = resolveClaudeCli();
    if (!exe) {
      return {
        ...base,
        detail: "Claude Code CLI를 찾지 못했습니다.",
        remediation:
          "Claude Code를 설치하고 로그인하세요. 이미 설치했다면 실행 파일 경로를 " +
          "QA_CLAUDE_PATH 환경변수로 지정할 수 있습니다. 찾아본 곳: " +
          searchedLocations().join(", "),
      };
    }

    try {
      const { stdout } = await runClaude(exe, ["--version"], null, 20_000);
      const version = stdout.trim();

      /*
       * 설치 확인만으로는 부족하다. **로그인하지 않아도 `--version` 은 된다.**
       * 그 상태로 QA 를 시작하면 분석 요청이 전부 실패하고, 사용자는 이유를 모른 채
       * 룰 결과만 받는다. 여기서 걸러 무엇을 해야 하는지 알려준다.
       */
      const auth = await claudeAuthStatus(exe);
      if (auth.error !== null) {
        // 확인하지 못한 것을 "로그인 안 됨"으로 단정하지 않는다. 그대로 진행한다.
        return {
          ...base,
          available: true,
          detail: `Claude Code 연결됨 · ${version} (${exe}) · 로그인 상태는 확인하지 못했습니다`,
        };
      }
      if (!auth.loggedIn) {
        return {
          ...base,
          detail: "Claude Code 에 로그인되어 있지 않습니다.",
          remediation:
            "QA 설정 화면의 [Claude 로그인] 을 누르거나, 터미널에서 `claude auth login` 을 실행하세요.",
        };
      }

      const who = [auth.plan, auth.email].filter(Boolean).join(" · ");
      return {
        ...base,
        available: true,
        detail: `Claude Code 연결됨 · ${version}${who ? ` · ${who}` : ""}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      return {
        ...base,
        detail: `Claude Code 실행에 실패했습니다: ${message}`,
        remediation: `${exe} --version 이 동작하는지 확인하세요. 로그인이 필요할 수 있습니다.`,
      };
    }
  }

  private async ask<T>(prompt: Prompt, schema: z.ZodType<T>): Promise<T> {
    return retryOnce(async (hint) => {
      const text = [SYSTEM_PROMPT, "", prompt.user, hint ? `\n${hint}` : ""].join("\n");
      /*
       * 프롬프트는 **stdin** 으로 넘긴다. 인자로 넘기면 두 가지가 깨진다.
       *   - Windows 명령줄 상한(약 32KB). 화면 DOM 이 들어간 프롬프트는 쉽게 넘는다.
       *   - 프롬프트에는 대상 사이트에서 온 텍스트가 들어 있다. 따옴표 하나로
       *     인자 경계가 무너진다.
       */
      const args = ["-p", "--output-format", "json"];
      if (this.config.model) args.push("--model", this.config.model);

      const exe = resolveClaudeCli();
      if (!exe) throw new Error("Claude Code CLI를 찾지 못했습니다.");
      const { stdout } = await runClaude(exe, args, text, this.config.timeoutMs);

      // `--output-format json` 은 응답 텍스트를 result 필드에 담아 준다.
      // 그 안의 내용이 우리가 원하는 JSON이다.
      const envelope = CliJsonOutput.safeParse(JSON.parse(stdout));
      const payload = envelope.success ? envelope.data.result : stdout;
      return parseJson(schema, payload, prompt.label);
    }, prompt.label);
  }

  async analyzePage(input: PageAnalysisInput): Promise<PageAnalysisResult> {
    return this.ask(pageAnalysisPrompt(input), PageAnalysisSchema);
  }

  async analyzeFunction(input: FunctionalAnalysisInput): Promise<FunctionalAnalysisResult> {
    return this.ask(functionalAnalysisPrompt(input), FunctionalAnalysisSchema);
  }

  async analyzeScreenshot(input: VisualAnalysisInput): Promise<VisualAnalysisResult> {
    // CLI 경로로는 이미지를 넘길 수 없다. Agent SDK로 바꿀 때 열린다.
    throw new Error("CLI 모드에서는 스크린샷 분석을 지원하지 않습니다 (Agent SDK 필요)");
  }

  async judgeIssues(input: IssueJudgeInput): Promise<IssueJudgeResult> {
    return this.ask(issueJudgePrompt(input), IssueJudgeSchema);
  }

  async generateReport(input: ReportInput): Promise<string> {
    const result = await this.ask(reportSummaryPrompt(input), z.object({ summary: z.string() }));
    return result.summary;
  }
}
