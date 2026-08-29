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
import { parseJson, retryOnce, withTimeout } from "./guard.js";
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
 * Ollama Provider.
 *
 * **가장 먼저 만드는 구현체다.** 로컬이라 무료이고 반복 실행에 제약이 없어서
 * 개발 중 튜닝을 여기서 한다. Claude를 먼저 붙이면 반복마다 비용과 대기가 붙는다.
 */

const TagsResponse = z.object({
  models: z.array(z.object({ name: z.string() })),
});

const ChatResponse = z.object({
  message: z.object({ content: z.string() }),
});

export class OllamaProvider implements AiProvider {
  constructor(private readonly config: AiProviderConfig) {}

  private url(path: string): string {
    return new URL(path, this.config.baseUrl).toString();
  }

  async healthCheck(): Promise<ProviderStatus> {
    const base: ProviderStatus = {
      available: false,
      kind: "ollama",
      model: this.config.model,
      visionCapable: this.config.visionCapable,
      detail: "",
      remediation: null,
    };

    let models: string[];
    try {
      const res = await withTimeout(fetch(this.url("/api/tags")), 5000, "Ollama 조회");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      models = TagsResponse.parse(await res.json()).models.map((m) => m.name);
    } catch (err) {
      return {
        ...base,
        detail: `Ollama에 연결할 수 없습니다: ${err instanceof Error ? err.message : String(err)}`,
        remediation: `Ollama가 실행 중인지 확인하세요 (${this.config.baseUrl}).`,
      };
    }

    if (!this.config.model) {
      return {
        ...base,
        detail: `모델이 지정되지 않았습니다. 설치된 모델: ${models.join(", ")}`,
        remediation: "--model 로 사용할 모델을 지정하세요.",
      };
    }

    if (!models.includes(this.config.model)) {
      return {
        ...base,
        detail: `모델 ${this.config.model} 이 설치되어 있지 않습니다. 설치된 모델: ${models.join(", ")}`,
        remediation: `ollama pull ${this.config.model}`,
      };
    }

    return {
      ...base,
      available: true,
      detail: `Ollama 연결됨 · 모델 ${this.config.model}`,
    };
  }

  /**
   * 한 번 물어보고 스키마로 검증한다. 실패하면 형식을 강조해 1회만 재시도한다.
   *
   * `temperature: 0` 과 `format: "json"` 을 같이 쓴다 — 결정성을 최대한 확보해야
   * 같은 Run을 두 번 돌렸을 때 리포트가 크게 달라지지 않는다.
   */
  private async ask<T>(prompt: Prompt, schema: z.ZodType<T>): Promise<T> {
    return retryOnce(async (hint) => {
      const res = await fetch(this.url("/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          stream: false,
          format: "json",
          options: { temperature: 0 },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: hint ? `${prompt.user}\n\n${hint}` : prompt.user },
          ],
        }),
      });

      if (!res.ok) {
        throw new Error(`${prompt.label}: Ollama HTTP ${res.status} ${await res.text()}`);
      }

      const body = ChatResponse.parse(await res.json());
      return parseJson(schema, body.message.content, prompt.label);
    }, prompt.label);
  }

  async analyzePage(input: PageAnalysisInput): Promise<PageAnalysisResult> {
    return this.ask(pageAnalysisPrompt(input), PageAnalysisSchema);
  }

  async analyzeFunction(input: FunctionalAnalysisInput): Promise<FunctionalAnalysisResult> {
    return this.ask(functionalAnalysisPrompt(input), FunctionalAnalysisSchema);
  }

  async analyzeScreenshot(input: VisualAnalysisInput): Promise<VisualAnalysisResult> {
    // Vision 미지원 모델에 이미지를 보내면 조용히 헛소리를 한다. 아예 거부한다.
    if (!this.config.visionCapable) {
      throw new Error("이 모델은 Vision을 지원하지 않습니다 (ai.visionCapable=false)");
    }
    return this.ask(visualAnalysisPrompt(input), VisualAnalysisSchema);
  }

  async judgeIssues(input: IssueJudgeInput): Promise<IssueJudgeResult> {
    return this.ask(issueJudgePrompt(input), IssueJudgeSchema);
  }

  async generateReport(input: ReportInput): Promise<string> {
    const result = await this.ask(reportSummaryPrompt(input), z.object({ summary: z.string() }));
    return result.summary;
  }
}
