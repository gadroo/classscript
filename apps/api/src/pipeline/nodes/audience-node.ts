import type { GraphNode } from "@langchain/langgraph";
import { AudienceStrategySchema } from "@curriculum/schemas";
import { buildAudienceStrategyPrompt, commonSystemRules } from "@curriculum/prompts";
import type { PipelineStateSchema } from "../state.js";
import { fallbackAudienceStrategy } from "../fallbacks.js";
import { generateStructuredObject } from "../llm/client.js";
import { buildNodeExecution, nowIso, shouldReuseStage, toTrace } from "../utils.js";

export const audienceNode: GraphNode<typeof PipelineStateSchema> = async (state) => {
  const startedAt = nowIso();
  const stage = "audience" as const;

  if (shouldReuseStage(state.options.regenerateStages, stage) && state.artifacts.audienceStrategy) {
    const execution = buildNodeExecution({
      node: stage,
      status: "skipped",
      startedAt,
      confidence: state.artifacts.audienceStrategy.confidence,
      logs: ["Reused audience strategy from prior state."],
      inputArtifacts: ["artifacts.decomposition"],
      outputArtifacts: ["artifacts.audienceStrategy"],
    });
    return { nodeExecutions: [execution], traces: [toTrace(execution)] };
  }

  if (!state.artifacts.decomposition) {
    const execution = buildNodeExecution({
      node: stage,
      status: "error",
      startedAt,
      errors: ["Topic decomposition artifact missing."],
    });
    return {
      escalations: ["Audience adaptation blocked because decomposition artifact is missing."],
      nodeExecutions: [execution],
      traces: [toTrace(execution)],
    };
  }

  let audienceStrategy = fallbackAudienceStrategy(state.brief, state.artifacts.decomposition);
  const warnings: string[] = [];
  let retries = 0;
  let model: string | undefined;
  let prompt = "";

  if (state.options.enableLlm) {
    try {
      prompt = buildAudienceStrategyPrompt(state.brief, state.artifacts.decomposition);
      const llm = await generateStructuredObject({
        schema: AudienceStrategySchema,
        schemaName: "AudienceStrategy",
        systemPrompt: `${commonSystemRules}\nYou specialize in mixed-audience pedagogy selection and instability handling.`,
        userPrompt: prompt,
        maxRetries: state.options.maxNodeRetries,
      });
      audienceStrategy = llm.output;
      retries = llm.attempts - 1;
      model = llm.model;
    } catch (error) {
      warnings.push(error instanceof Error ? `LLM audience strategy failed; fallback used: ${error.message}` : "LLM audience strategy failed; fallback used.");
    }
  } else {
    warnings.push("LLM disabled; deterministic audience strategy used.");
  }

  if (
    Math.abs(state.brief.audience.beginnerPercent - state.brief.audience.advancedPercent) <= 10
    && audienceStrategy.mode !== "balanced-layered"
    && audienceStrategy.mode !== "segmented"
  ) {
    audienceStrategy = {
      ...audienceStrategy,
      mode: "balanced-layered",
      instabilityScore: Math.max(audienceStrategy.instabilityScore, 0.72),
      rationale: `${audienceStrategy.rationale} Forced balanced-layered mode due to unstable near-50/50 audience split.`,
      confidence: Math.min(audienceStrategy.confidence, 0.84),
    };
    warnings.push("Unstable 50/50 band detected; audience mode forced to balanced-layered.");
  }

  const execution = buildNodeExecution({
    node: stage,
    status: warnings.length > 0 ? "warning" : "success",
    startedAt,
    retries,
    confidence: audienceStrategy.confidence,
    warnings,
    metrics: {
      divergenceScore: audienceStrategy.divergenceScore,
      instabilityScore: audienceStrategy.instabilityScore,
      beginnerWeight: audienceStrategy.beginnerWeight,
      advancedWeight: audienceStrategy.advancedWeight,
    },
    inputArtifacts: ["artifacts.decomposition"],
    outputArtifacts: ["artifacts.audienceStrategy"],
    validationTraces: [
      `mode=${audienceStrategy.mode}`,
      `divergence=${audienceStrategy.divergenceScore}`,
      `instability=${audienceStrategy.instabilityScore}`,
    ],
    model,
  });

  return {
    artifacts: {
      ...state.artifacts,
      audienceStrategy,
    },
    promptLog: prompt
      ? {
          ...state.promptLog,
          audience: prompt,
        }
      : state.promptLog,
    nodeExecutions: [execution],
    traces: [toTrace(execution)],
  };
};
