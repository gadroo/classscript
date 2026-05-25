import type { GraphNode } from "@langchain/langgraph";
import type { PipelineStateSchema } from "../state.js";
import { retrieveGrounding } from "../retrieval.js";
import { buildNodeExecution, nowIso, runWithRetry, shouldReuseStage, toTrace } from "../utils.js";

export const retrievalNode: GraphNode<typeof PipelineStateSchema> = async (state) => {
  const startedAt = nowIso();
  const stage = "retrieval" as const;

  if (shouldReuseStage(state.options.regenerateStages, stage) && state.artifacts.retrieval) {
    const execution = buildNodeExecution({
      node: stage,
      status: "skipped",
      startedAt,
      confidence: state.artifacts.retrieval.confidence,
      logs: ["Reused retrieval artifact from prior state."],
      outputArtifacts: ["artifacts.retrieval"],
    });
    return {
      nodeExecutions: [execution],
      traces: [toTrace(execution)],
    };
  }

  try {
    const { value, attempts } = await runWithRetry(
      async () => retrieveGrounding(state.brief),
      state.options.maxNodeRetries,
    );

    const warnings = value.confidence < 0.65
      ? ["Low retrieval confidence; official-source grounding may be incomplete."]
      : [];

    const execution = buildNodeExecution({
      node: stage,
      status: warnings.length > 0 ? "warning" : "success",
      startedAt,
      retries: attempts - 1,
      confidence: value.confidence,
      warnings,
      metrics: {
        sourceCount: value.sources.length,
        fetchedSourceCount: value.sources.filter((source) => source.status === "fetched").length,
        officialSourceCount: value.sources.filter((source) => source.official).length,
      },
      outputArtifacts: ["artifacts.retrieval"],
      validationTraces: value.sources.map((source) => `${source.id}:${source.status}`),
    });

    return {
      artifacts: {
        ...state.artifacts,
        retrieval: value,
      },
      nodeExecutions: [execution],
      traces: [toTrace(execution)],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "retrieval failed";
    const execution = buildNodeExecution({
      node: stage,
      status: "error",
      startedAt,
      errors: [message],
      retries: state.options.maxNodeRetries,
      outputArtifacts: [],
    });

    return {
      escalations: ["Retrieval grounding failed. Human review required for source validation."],
      nodeExecutions: [execution],
      traces: [toTrace(execution)],
    };
  }
};
