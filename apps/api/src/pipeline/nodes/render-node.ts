import type { GraphNode } from "@langchain/langgraph";
import { buildInstructorMarkdown, buildInstructorSummary } from "@curriculum/rendering";
import type { PipelineStateSchema } from "../state.js";
import { buildNodeExecution, nowIso, toTrace } from "../utils.js";

export const renderNode: GraphNode<typeof PipelineStateSchema> = async (state) => {
  const startedAt = nowIso();
  const stage = "rendering" as const;

  if (!state.plan || !state.generation || !state.validation) {
    const execution = buildNodeExecution({
      node: stage,
      status: "error",
      startedAt,
      errors: ["Missing artifacts for rendering."],
      inputArtifacts: ["plan", "generation", "validation"],
    });
    return {
      escalations: ["Rendering blocked because artifacts are incomplete."],
      nodeExecutions: [execution],
      traces: [toTrace(execution)],
    };
  }

  const markdown = buildInstructorMarkdown(state.brief, state.plan, state.generation, state.validation);
  const summary = buildInstructorSummary(state.brief, state.validation);
  const execution = buildNodeExecution({
    node: stage,
    status: "success",
    startedAt,
    confidence: state.validation.confidence,
    metrics: {
      markdownLength: markdown.length,
      summaryLength: summary.length,
    },
    inputArtifacts: ["plan", "generation", "validation"],
    outputArtifacts: ["previewMarkdown", "previewSummary"],
  });

  return {
    previewMarkdown: markdown,
    previewSummary: summary,
    nodeExecutions: [execution],
    traces: [toTrace(execution)],
  };
};
