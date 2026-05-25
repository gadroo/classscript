import type { GraphNode } from "@langchain/langgraph";
import { TopicDecompositionSchema } from "@curriculum/schemas";
import { buildDecompositionPrompt, commonSystemRules } from "@curriculum/prompts";
import type { PipelineStateSchema } from "../state.js";
import { fallbackDecomposition } from "../fallbacks.js";
import { generateStructuredObject } from "../llm/client.js";
import { buildNodeExecution, nowIso, shouldReuseStage, toTrace } from "../utils.js";

export const decompositionNode: GraphNode<typeof PipelineStateSchema> = async (state) => {
  const startedAt = nowIso();
  const stage = "decomposition" as const;

  if (shouldReuseStage(state.options.regenerateStages, stage) && state.artifacts.decomposition) {
    const execution = buildNodeExecution({
      node: stage,
      status: "skipped",
      startedAt,
      confidence: state.artifacts.decomposition.confidence,
      logs: ["Reused topic decomposition from prior state."],
      inputArtifacts: ["artifacts.retrieval"],
      outputArtifacts: ["artifacts.decomposition"],
    });
    return {
      nodeExecutions: [execution],
      traces: [toTrace(execution)],
    };
  }

  if (!state.artifacts.retrieval) {
    const execution = buildNodeExecution({
      node: stage,
      status: "error",
      startedAt,
      errors: ["Retrieval artifact missing."],
      inputArtifacts: ["artifacts.retrieval"],
    });
    return {
      escalations: ["Topic decomposition blocked because retrieval artifact is missing."],
      nodeExecutions: [execution],
      traces: [toTrace(execution)],
    };
  }

  let decomposition = fallbackDecomposition(state.brief);
  const warnings: string[] = [];
  let model: string | undefined;

  if (state.options.enableLlm) {
    try {
      const prompt = buildDecompositionPrompt(state.brief, state.artifacts.retrieval);
      const llm = await generateStructuredObject({
        schema: TopicDecompositionSchema,
        schemaName: "TopicDecomposition",
        systemPrompt: `${commonSystemRules}\nYou are a curriculum decomposition specialist.`,
        userPrompt: prompt,
        maxRetries: state.options.maxNodeRetries,
      });
      decomposition = llm.output;
      model = llm.model;
      warnings.push(...(llm.attempts > 1 ? [`LLM decomposition succeeded after ${llm.attempts} attempts.`] : []));
      const execution = buildNodeExecution({
        node: stage,
        status: warnings.length > 0 ? "warning" : "success",
        startedAt,
        retries: llm.attempts - 1,
        confidence: decomposition.confidence,
        warnings,
        metrics: {
          conceptCount: decomposition.concepts.length,
          avgDifficulty: decomposition.concepts.reduce((sum, concept) => sum + concept.difficulty, 0) / decomposition.concepts.length,
        },
        inputArtifacts: ["artifacts.retrieval"],
        outputArtifacts: ["artifacts.decomposition"],
        validationTraces: decomposition.concepts.map((concept) => `${concept.id}:${concept.prerequisites.length}`),
        model,
      });

      return {
        artifacts: {
          ...state.artifacts,
          decomposition,
        },
        promptLog: {
          ...state.promptLog,
          decomposition: prompt,
        },
        nodeExecutions: [execution],
        traces: [toTrace(execution)],
      };
    } catch (error) {
      warnings.push(error instanceof Error ? `LLM decomposition failed; fallback used: ${error.message}` : "LLM decomposition failed; fallback used.");
    }
  } else {
    warnings.push("LLM disabled; deterministic fallback decomposition used.");
  }

  const execution = buildNodeExecution({
    node: stage,
    status: "warning",
    startedAt,
    confidence: decomposition.confidence,
    warnings,
    metrics: {
      conceptCount: decomposition.concepts.length,
      avgDifficulty: decomposition.concepts.reduce((sum, concept) => sum + concept.difficulty, 0) / decomposition.concepts.length,
    },
    inputArtifacts: ["artifacts.retrieval"],
    outputArtifacts: ["artifacts.decomposition"],
  });

  return {
    artifacts: {
      ...state.artifacts,
      decomposition,
    },
    nodeExecutions: [execution],
    traces: [toTrace(execution)],
  };
};
