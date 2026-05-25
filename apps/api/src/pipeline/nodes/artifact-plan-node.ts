import type { GraphNode } from "@langchain/langgraph";
import { ArtifactPlanSchema } from "@curriculum/schemas";
import { buildArtifactPlanPrompt, commonSystemRules } from "@curriculum/prompts";
import type { PipelineStateSchema } from "../state.js";
import { fallbackArtifactPlan } from "../fallbacks.js";
import { selectPedagogicalStrategy } from "../strategy-selection.js";
import { generateStructuredObject } from "../llm/client.js";
import { buildNodeExecution, clampUnit, nowIso, shouldReuseStage, toTrace } from "../utils.js";

export const artifactPlanNode: GraphNode<typeof PipelineStateSchema> = async (state) => {
  const startedAt = nowIso();
  const stage = "artifact_planning" as const;

  if (shouldReuseStage(state.options.regenerateStages, stage) && state.artifacts.artifactPlan) {
    const execution = buildNodeExecution({
      node: stage,
      status: "skipped",
      startedAt,
      confidence: state.artifacts.artifactPlan.confidence,
      logs: ["Reused artifact plan from prior state."],
      inputArtifacts: ["artifacts.audienceStrategy", "artifacts.decomposition", "artifacts.strategySelection"],
      outputArtifacts: ["artifacts.artifactPlan", "artifacts.strategySelection"],
    });
    return { nodeExecutions: [execution], traces: [toTrace(execution)] };
  }

  if (!state.artifacts.audienceStrategy || !state.artifacts.decomposition) {
    const execution = buildNodeExecution({
      node: stage,
      status: "error",
      startedAt,
      errors: ["Missing audience strategy or decomposition artifact."],
    });
    return {
      escalations: ["Artifact planning blocked because upstream artifacts are missing."],
      nodeExecutions: [execution],
      traces: [toTrace(execution)],
    };
  }

  const strategySelection = selectPedagogicalStrategy(
    state.brief,
    state.artifacts.decomposition,
    state.artifacts.audienceStrategy,
  );
  let artifactPlan = fallbackArtifactPlan(state.brief, state.artifacts.audienceStrategy, strategySelection);
  const warnings: string[] = [];
  let retries = 0;
  let model: string | undefined;
  let prompt = "";

  if (state.options.enableLlm) {
    try {
      prompt = buildArtifactPlanPrompt(state.brief, state.artifacts.decomposition, state.artifacts.audienceStrategy);
      const llm = await generateStructuredObject({
        schema: ArtifactPlanSchema,
        schemaName: "ArtifactPlan",
        systemPrompt: `${commonSystemRules}\nYou enforce educational artifact requirements and output density policy.`,
        userPrompt: prompt,
        maxRetries: state.options.maxNodeRetries,
      });
      artifactPlan = llm.output;
      retries = llm.attempts - 1;
      model = llm.model;
    } catch (error) {
      warnings.push(error instanceof Error ? `LLM artifact planning failed; fallback used: ${error.message}` : "LLM artifact planning failed; fallback used.");
    }
  } else {
    warnings.push("LLM disabled; deterministic artifact planning used.");
  }

  artifactPlan = {
    ...artifactPlan,
    codeDensityTarget: state.brief.includeCode
      ? clampUnit((artifactPlan.codeDensityTarget + strategySelection.targetDensities.code) / 2)
      : 0,
    diagramDensityTarget: state.brief.includeFlowcharts
      ? clampUnit((artifactPlan.diagramDensityTarget + strategySelection.targetDensities.diagram) / 2)
      : 0,
    exerciseDensityTarget: state.brief.includeExercises
      ? clampUnit((artifactPlan.exerciseDensityTarget + strategySelection.targetDensities.exercise) / 2)
      : 0,
    confidence: clampUnit((artifactPlan.confidence + strategySelection.confidence) / 2),
    enforcementRules: [
      ...artifactPlan.enforcementRules,
      `Golden strategy examples: ${strategySelection.selectedExampleIds.join(", ")}.`,
      `Recommended mode: ${strategySelection.recommendedMode}.`,
      `Recommended teaching style: ${strategySelection.teachingStyle}.`,
    ],
  };

  if (strategySelection.warnings.length > 0) {
    warnings.push(...strategySelection.warnings);
  }

  if (state.brief.includeCode && !artifactPlan.requireCode) {
    artifactPlan = { ...artifactPlan, requireCode: true };
    warnings.push("Artifact plan adjusted to enforce includeCode=true.");
  }
  if (state.brief.includeFlowcharts && !artifactPlan.requireDiagrams) {
    artifactPlan = { ...artifactPlan, requireDiagrams: true };
    warnings.push("Artifact plan adjusted to enforce includeFlowcharts=true.");
  }

  const execution = buildNodeExecution({
    node: stage,
    status: warnings.length > 0 ? "warning" : "success",
    startedAt,
    retries,
    confidence: artifactPlan.confidence,
    warnings,
    metrics: {
      requireCode: artifactPlan.requireCode ? 1 : 0,
      requireDiagrams: artifactPlan.requireDiagrams ? 1 : 0,
      requireExercises: artifactPlan.requireExercises ? 1 : 0,
      codeDensityTarget: artifactPlan.codeDensityTarget,
      diagramDensityTarget: artifactPlan.diagramDensityTarget,
      strategyConfidence: strategySelection.confidence,
      strategyExampleCount: strategySelection.selectedExampleIds.length,
    },
    inputArtifacts: ["artifacts.decomposition", "artifacts.audienceStrategy"],
    outputArtifacts: ["artifacts.artifactPlan", "artifacts.strategySelection"],
    validationTraces: [
      ...artifactPlan.enforcementRules,
      `strategy_mode=${strategySelection.recommendedMode}`,
      `strategy_style=${strategySelection.teachingStyle}`,
      `strategy_confidence=${strategySelection.confidence}`,
    ],
    model,
  });

  return {
    artifacts: {
      ...state.artifacts,
      artifactPlan,
      strategySelection,
    },
    promptLog: prompt
      ? {
          ...state.promptLog,
          artifactPlanner: prompt,
        }
      : state.promptLog,
    nodeExecutions: [execution],
    traces: [toTrace(execution)],
  };
};
