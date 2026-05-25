import { z } from "zod";
import type { GraphNode } from "@langchain/langgraph";
import { CriticReviewSchema, type CriticReview } from "@curriculum/schemas";
import { buildCriticPrompt, commonSystemRules } from "@curriculum/prompts";
import type { PipelineState, PipelineStateSchema } from "../state.js";
import { generateStructuredObject } from "../llm/client.js";
import { buildNodeExecution, clampUnit, nowIso, shouldReuseStage, toTrace } from "../utils.js";

const CriticBundleSchema = z.object({
  criticReviews: z.array(CriticReviewSchema).min(3),
});

function fallbackCritics(state: PipelineState): CriticReview[] {
  if (!state.plan || !state.generation || !state.artifacts.retrieval) {
    return [];
  }

  const referenceCoverage = Math.min(1, state.generation.references.length / 4);
  const timingDelta = Math.abs(
    state.brief.durationMinutes - state.plan.modules.reduce((sum, module) => sum + module.estimatedMinutes, 0),
  );
  const timingConfidence = clampUnit(1 - timingDelta / Math.max(10, state.brief.durationMinutes));
  const diagramCount = state.generation.codeSnippets.filter((snippet) => snippet.language === "text").length;
  const scriptCoverage = Math.min(1, state.generation.scriptSections.length / Math.max(1, state.plan.modules.length));
  const implementationCoverage = state.generation.scriptSections.length === 0
    ? 0
    : state.generation.scriptSections.filter((section) => section.implementationArtifact.stackApis.length >= 2).length / state.generation.scriptSections.length;
  const debugCoverage = state.generation.scriptSections.length === 0
    ? 0
    : state.generation.scriptSections.filter((section) => section.debugScenario.investigationSteps.length >= 2).length / state.generation.scriptSections.length;
  const groundingCoverage = state.generation.scriptSections.length === 0
    ? 0
    : state.generation.scriptSections.filter((section) => section.groundedClaims.length > 0).length / state.generation.scriptSections.length;
  const cognitiveCoverage = state.generation.scriptSections.length === 0
    ? 0
    : state.generation.scriptSections.filter((section) => section.cognitiveBridge.length > 80 && section.abstractionShift.length > 50).length / state.generation.scriptSections.length;

  return [
    {
      critic: "technical" as const,
      verdict: (
        (state.generation.codeSnippets.length > 0 || !state.brief.includeCode)
        && implementationCoverage >= 0.95
        && debugCoverage >= 0.9
        ? "pass"
        : "warn"
      ) as CriticReview["verdict"],
      findings: [
        ...(state.generation.codeSnippets.length > 0 || !state.brief.includeCode ? [] : ["Requested code artifact is missing."]),
        ...(implementationCoverage >= 0.95 ? [] : ["Implementation artifacts are not consistently stack-specific."]),
        ...(debugCoverage >= 0.9 ? [] : ["Debug scenarios are too shallow or incomplete in multiple modules."]),
      ],
      suggestedFixes: [
        "Ensure each module has a runnable snippet aligned to target stack APIs.",
        "Require investigation and verification steps in every debug scenario.",
      ],
      confidence: Math.min(0.92, 0.7 + implementationCoverage * 0.12 + debugCoverage * 0.1),
    },
    {
      critic: "pedagogical" as const,
      verdict: (scriptCoverage >= 1 && cognitiveCoverage >= 0.85 ? "pass" : "warn") as CriticReview["verdict"],
      findings: [
        ...(scriptCoverage >= 1 ? [] : ["Not all modules have script coverage."]),
        ...(cognitiveCoverage >= 0.85 ? [] : ["Beginner-to-advanced transitions are not cognitively explicit enough."]),
      ],
      suggestedFixes: [
        "Add one script section per module with layered adaptations.",
        "Force explicit cognitiveBridge and abstractionShift from concrete behavior to system constraints.",
      ],
      confidence: Math.min(0.9, 0.62 + scriptCoverage * 0.16 + cognitiveCoverage * 0.12),
    },
    {
      critic: "timing" as const,
      verdict: (timingDelta <= Math.max(10, state.brief.durationMinutes * 0.2) ? "pass" : "warn") as CriticReview["verdict"],
      findings: timingDelta <= Math.max(10, state.brief.durationMinutes * 0.2) ? [] : [`Pacing delta is ${Math.round(timingDelta)} minutes.`],
      suggestedFixes: ["Rebalance module minutes to fit requested duration."],
      confidence: timingConfidence,
    },
    {
      critic: "consistency" as const,
      verdict: (referenceCoverage >= 0.5 && groundingCoverage >= 0.9 ? "pass" : "warn") as CriticReview["verdict"],
      findings: [
        ...(referenceCoverage >= 0.5 ? [] : ["Reference coverage is sparse."]),
        ...(groundingCoverage >= 0.9 ? [] : ["Inline grounded claims are missing from one or more modules."]),
      ],
      suggestedFixes: ["Add citations from official sources in retrieval bundle and bind each technical claim to one source URL."],
      confidence: clampUnit(referenceCoverage * 0.6 + groundingCoverage * 0.4 + 0.12),
    },
    {
      critic: "diagram" as const,
      verdict: (!state.brief.includeFlowcharts || diagramCount > 0 ? "pass" : "warn") as CriticReview["verdict"],
      findings: !state.brief.includeFlowcharts || diagramCount > 0 ? [] : ["Flowchart requirement not satisfied."],
      suggestedFixes: ["Add a Mermaid diagram snippet for concept flow."],
      confidence: diagramCount > 0 ? 0.82 : 0.58,
    },
    {
      critic: "retrieval" as const,
      verdict: (state.artifacts.retrieval.confidence >= 0.65 && groundingCoverage >= 0.9 ? "pass" : "warn") as CriticReview["verdict"],
      findings: [
        ...(state.artifacts.retrieval.confidence >= 0.65 ? [] : ["Retrieval grounding confidence is low."]),
        ...(groundingCoverage >= 0.9 ? [] : ["Retrieved evidence is not traceably used inside module-level claims."]),
      ],
      suggestedFixes: ["Refresh source fetch, verify official documentation links, and require traceable claim-to-source mapping per module."],
      confidence: clampUnit(state.artifacts.retrieval.confidence * 0.7 + groundingCoverage * 0.3),
    },
  ];
}

export const criticNode: GraphNode<typeof PipelineStateSchema> = async (state) => {
  const startedAt = nowIso();
  const stage = "critique" as const;

  if (shouldReuseStage(state.options.regenerateStages, stage) && state.artifacts.criticReviews.length > 0) {
    const execution = buildNodeExecution({
      node: stage,
      status: "skipped",
      startedAt,
      confidence: clampUnit(state.artifacts.criticReviews.reduce((sum, review) => sum + review.confidence, 0) / state.artifacts.criticReviews.length),
      logs: ["Reused critic reviews from prior state."],
      inputArtifacts: ["plan", "generation", "artifacts.retrieval"],
      outputArtifacts: ["artifacts.criticReviews"],
    });
    return { nodeExecutions: [execution], traces: [toTrace(execution)] };
  }

  if (!state.plan || !state.generation || !state.artifacts.retrieval) {
    const execution = buildNodeExecution({
      node: stage,
      status: "error",
      startedAt,
      errors: ["Missing artifacts required for critic stage."],
    });
    return {
      escalations: ["Critic stage blocked by missing artifacts."],
      nodeExecutions: [execution],
      traces: [toTrace(execution)],
    };
  }

  let criticReviews = fallbackCritics(state);
  const warnings: string[] = [];
  let retries = 0;
  let model: string | undefined;
  let prompt = "";

  if (state.options.enableLlm) {
    try {
      prompt = buildCriticPrompt(state.brief, state.plan, state.generation, state.artifacts.retrieval);
      const llm = await generateStructuredObject({
        schema: CriticBundleSchema,
        schemaName: "CriticBundle",
        systemPrompt: `${commonSystemRules}\nYou are a red-team reviewer. Find educational and technical failure modes with concrete fixes.`,
        userPrompt: prompt,
        maxRetries: state.options.maxNodeRetries,
      });
      criticReviews = llm.output.criticReviews;
      retries = llm.attempts - 1;
      model = llm.model;
    } catch (error) {
      warnings.push(error instanceof Error ? `LLM critic pass failed; fallback critics used: ${error.message}` : "LLM critic pass failed; fallback critics used.");
    }
  } else {
    warnings.push("LLM disabled; deterministic critic rules used.");
  }

  const failCount = criticReviews.filter((review) => review.verdict === "fail").length;
  const warnCount = criticReviews.filter((review) => review.verdict === "warn").length;
  if (failCount > 0) {
    warnings.push(`${failCount} critic(s) issued fail verdicts.`);
  }

  const avgConfidence = clampUnit(
    criticReviews.reduce((sum, review) => sum + review.confidence, 0) / Math.max(1, criticReviews.length),
  );

  const execution = buildNodeExecution({
    node: stage,
    status: failCount > 0 ? "error" : warnings.length > 0 || warnCount > 0 ? "warning" : "success",
    startedAt,
    retries,
    confidence: avgConfidence,
    warnings,
    metrics: {
      reviewCount: criticReviews.length,
      failCount,
      warnCount,
      avgConfidence,
    },
    inputArtifacts: ["plan", "generation", "artifacts.retrieval"],
    outputArtifacts: ["artifacts.criticReviews"],
    validationTraces: criticReviews.map((review) => `${review.critic}:${review.verdict}`),
    model,
  });

  return {
    artifacts: {
      ...state.artifacts,
      criticReviews,
    },
    promptLog: prompt
      ? {
          ...state.promptLog,
          critic: prompt,
        }
      : state.promptLog,
    nodeExecutions: [execution],
    traces: [toTrace(execution)],
  };
};
