import type {
  AiProvider,
  FunctionalAnalysisResult,
  IssueJudgeResult,
  PageAnalysisResult,
  ProviderStatus,
  VisualAnalysisResult,
} from "@qa/shared";

/**
 * 아무것도 하지 않는 Provider.
 *
 * 룰 기반 경로의 기준선이자 테스트용이다. `--provider none` 의 실체이며,
 * 이 Provider로 나온 리포트가 **모든 Provider에서 보장되는 최소치**다.
 * 다른 구현체를 만들 때는 항상 이것과 목차가 같은지 비교한다.
 */
export class NoneProvider implements AiProvider {
  async healthCheck(): Promise<ProviderStatus> {
    return {
      available: false,
      kind: "none",
      model: "",
      visionCapable: false,
      detail: "AI Provider를 사용하지 않습니다. 룰 기반 판정만 수행합니다.",
      remediation: null,
    };
  }

  async analyzePage(): Promise<PageAnalysisResult> {
    return { screenPurpose: "", missingFeatureCandidates: [], notes: [] };
  }

  async analyzeFunction(): Promise<FunctionalAnalysisResult> {
    return { rootCause: "", impact: "", recommendation: "", confidence: 0 };
  }

  async analyzeScreenshot(): Promise<VisualAnalysisResult> {
    return { findings: [], overallImpression: "" };
  }

  async judgeIssues(): Promise<IssueJudgeResult> {
    return { mergeGroups: [], falsePositiveIds: [], severityOverrides: [] };
  }

  async generateReport(): Promise<string> {
    return "";
  }
}
