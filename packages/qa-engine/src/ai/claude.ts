import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const run = promisify(execFile);

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

    try {
      const { stdout } = await run("claude", ["--version"], {
        timeout: 15_000,
        windowsHide: true,
      });
      return {
        ...base,
        available: true,
        detail: `Claude Code 연결됨 · ${stdout.trim()}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const notFound = /ENOENT|not recognized|찾을 수 없습니다|command not found/i.test(message);
      return {
        ...base,
        detail: notFound
          ? "Claude Code CLI를 찾을 수 없습니다."
          : `Claude Code 실행에 실패했습니다: ${message}`,
        remediation: notFound
          ? "Claude Code를 설치하고 로그인한 뒤 다시 시도하세요."
          : "터미널에서 `claude --version` 이 동작하는지 확인하세요.",
      };
    }
  }

  private async ask<T>(prompt: Prompt, schema: z.ZodType<T>): Promise<T> {
    return retryOnce(async (hint) => {
      const text = [SYSTEM_PROMPT, "", prompt.user, hint ? `\n${hint}` : ""].join("\n");
      const args = ["-p", text, "--output-format", "json"];
      if (this.config.model) args.push("--model", this.config.model);

      const { stdout } = await run("claude", args, {
        timeout: this.config.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });

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
