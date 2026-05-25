import type { GraphNode } from "@langchain/langgraph";
import { CurriculumPlanSchema } from "@curriculum/schemas";
import { buildCurriculumPlanPrompt, commonSystemRules } from "@curriculum/prompts";
import type { PipelineStateSchema } from "../state.js";
import { fallbackCurriculumPlan } from "../fallbacks.js";
import { generateStructuredObject } from "../llm/client.js";
import { buildNodeExecution, clampUnit, nowIso, shouldReuseStage, toTrace } from "../utils.js";

function prerequisiteOrderCoverage(moduleIds: string[], decompositionIds: string[]): number {
  const positions = new Map<string, number>(moduleIds.map((id, index) => [id, index]));
  let valid = 0;
  let total = 0;

  for (let index = 0; index < decompositionIds.length; index += 1) {
    const current = decompositionIds[index];
    const currentPos = positions.get(current);
    if (currentPos === undefined) {
      continue;
    }
    total += 1;
    if (currentPos >= index - 1) {
      valid += 1;
    }
  }

  return total === 0 ? 1 : valid / total;
}

export const planNode: GraphNode<typeof PipelineStateSchema> = async (state) => {
  const startedAt = nowIso();
  const stage = "planning" as const;

  if (shouldReuseStage(state.options.regenerateStages, stage) && state.plan) {
    const execution = buildNodeExecution({
      node: stage,
      status: "skipped",
      startedAt,
      confidence: state.plan.confidence,
      logs: ["Reused curriculum plan from prior state."],
      inputArtifacts: ["artifacts.decomposition", "artifacts.audienceStrategy", "artifacts.artifactPlan", "artifacts.strategySelection"],
      outputArtifacts: ["plan"],
    });
    return { nodeExecutions: [execution], traces: [toTrace(execution)] };
  }

  if (!state.artifacts.decomposition || !state.artifacts.audienceStrategy || !state.artifacts.artifactPlan) {
    const execution = buildNodeExecution({
      node: stage,
      status: "error",
      startedAt,
      errors: ["Missing decomposition, audience strategy, or artifact plan."],
    });
    return {
      escalations: ["Planning blocked because required upstream artifacts are missing."],
      nodeExecutions: [execution],
      traces: [toTrace(execution)],
    };
  }

  let plan = fallbackCurriculumPlan(
    state.brief,
    state.artifacts.decomposition,
    state.artifacts.audienceStrategy,
    state.artifacts.strategySelection,
  );
  const warnings: string[] = [];
  let retries = 0;
  let model: string | undefined;
  let prompt = "";

  if (state.options.enableLlm) {
    try {
      prompt = buildCurriculumPlanPrompt(
        state.brief,
        state.artifacts.decomposition,
        state.artifacts.audienceStrategy,
        state.artifacts.artifactPlan,
      );
      const llm = await generateStructuredObject({
        schema: CurriculumPlanSchema,
        schemaName: "CurriculumPlan",
        systemPrompt: `${commonSystemRules}\nYou create prerequisite-ordered curriculum plans with explicit pacing realism.`,
        userPrompt: prompt,
        maxRetries: state.options.maxNodeRetries,
      });
      plan = llm.output;
      retries = llm.attempts - 1;
      model = llm.model;
    } catch (error) {
      warnings.push(error instanceof Error ? `LLM planning failed; fallback used: ${error.message}` : "LLM planning failed; fallback used.");
    }
  } else {
    warnings.push("LLM disabled; deterministic curriculum planning used.");
  }

  const decompositionIds = state.artifacts.decomposition.concepts.map((concept) => concept.id);
  const moduleIdTokens = plan.modules.map((module) => module.id);
  const orderCoverage = prerequisiteOrderCoverage(moduleIdTokens, decompositionIds);

  if (orderCoverage < 0.75) {
    warnings.push("Potential prerequisite drift detected between concept graph and planned module order.");
  }

  const timingDelta = Math.abs(
    state.brief.durationMinutes - plan.modules.reduce((sum, module) => sum + module.estimatedMinutes, 0),
  );

  const confidence = clampUnit((plan.confidence + orderCoverage) / 2 - Math.min(0.2, timingDelta / Math.max(1, state.brief.durationMinutes * 2)));
  plan = {
    ...plan,
    confidence,
    warnings: [...new Set([...plan.warnings, ...warnings])],
  };

  const execution = buildNodeExecution({
    node: stage,
    status: warnings.length > 0 ? "warning" : "success",
    startedAt,
    retries,
    confidence,
    warnings,
    metrics: {
      moduleCount: plan.modules.length,
      learningObjectiveCount: plan.learningObjectives.length,
      orderCoverage,
      timingDelta,
    },
    inputArtifacts: ["artifacts.decomposition", "artifacts.audienceStrategy", "artifacts.artifactPlan", "artifacts.strategySelection"],
    outputArtifacts: ["plan"],
    validationTraces: [
      `module_minutes=${plan.modules.reduce((sum, module) => sum + module.estimatedMinutes, 0)}`,
      `order_coverage=${orderCoverage}`,
      `timing_delta=${timingDelta}`,
      ...(state.artifacts.strategySelection ? [`strategy_mode=${state.artifacts.strategySelection.recommendedMode}`] : []),
    ],
    model,
  });

  return {
    plan,
    promptLog: prompt
      ? {
          ...state.promptLog,
          planner: prompt,
        }
      : state.promptLog,
    nodeExecutions: [execution],
    traces: [toTrace(execution)],
  };
};
