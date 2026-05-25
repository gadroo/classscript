import { END, START, StateGraph } from "@langchain/langgraph";
import {
  IntermediateArtifactsSchema,
  PipelineResultSchema,
  PipelineRunOptionsSchema,
  type BriefInput,
  type PipelineResult,
  type PipelineRunOptions,
} from "@curriculum/schemas";
import { nanoid } from "nanoid";
import { retrievalNode } from "./nodes/retrieval-node.js";
import { decompositionNode } from "./nodes/decomposition-node.js";
import { audienceNode } from "./nodes/audience-node.js";
import { artifactPlanNode } from "./nodes/artifact-plan-node.js";
import { planNode } from "./nodes/plan-node.js";
import { generateNode } from "./nodes/generate-node.js";
import { diagramNode } from "./nodes/diagram-node.js";
import { criticNode } from "./nodes/critic-node.js";
import { validateNode } from "./nodes/validate-node.js";
import { renderNode } from "./nodes/render-node.js";
import { PipelineStateSchema } from "./state.js";

const graph = new StateGraph(PipelineStateSchema)
  .addNode("retrieval_stage", retrievalNode)
  .addNode("decomposition_stage", decompositionNode)
  .addNode("audience_stage", audienceNode)
  .addNode("artifact_planning_stage", artifactPlanNode)
  .addNode("planning_stage", planNode)
  .addNode("generation_stage", generateNode)
  .addNode("diagram_stage", diagramNode)
  .addNode("critique_stage", criticNode)
  .addNode("validation_stage", validateNode)
  .addNode("rendering_stage", renderNode)
  .addEdge(START, "retrieval_stage")
  .addEdge("retrieval_stage", "decomposition_stage")
  .addEdge("decomposition_stage", "audience_stage")
  .addEdge("audience_stage", "artifact_planning_stage")
  .addEdge("artifact_planning_stage", "planning_stage")
  .addEdge("planning_stage", "generation_stage")
  .addEdge("generation_stage", "diagram_stage")
  .addEdge("diagram_stage", "critique_stage")
  .addEdge("critique_stage", "validation_stage")
  .addEdge("validation_stage", "rendering_stage")
  .addEdge("rendering_stage", END)
  .compile();

export async function runPipeline(brief: BriefInput, rawOptions?: PipelineRunOptions): Promise<PipelineResult> {
  const requestId = `cls_${nanoid(10)}`;
  const options = PipelineRunOptionsSchema.parse(rawOptions ?? {});
  const reusedArtifacts = options.reuseArtifacts ? IntermediateArtifactsSchema.partial().parse(options.reuseArtifacts) : undefined;

  const finalState = await graph.invoke({
    requestId,
    brief,
    options,
    plan: null,
    generation: null,
    validation: null,
    previewMarkdown: null,
    previewSummary: null,
    promptLog: {},
    traces: [],
    nodeExecutions: [],
    escalations: [],
    artifacts: {
      diagramSnippets: reusedArtifacts?.diagramSnippets ?? [],
      criticReviews: reusedArtifacts?.criticReviews ?? [],
      validationTraces: reusedArtifacts?.validationTraces ?? [],
      retrieval: reusedArtifacts?.retrieval,
      decomposition: reusedArtifacts?.decomposition,
      audienceStrategy: reusedArtifacts?.audienceStrategy,
      strategySelection: reusedArtifacts?.strategySelection,
      artifactPlan: reusedArtifacts?.artifactPlan,
    },
  });

  if (!finalState.plan || !finalState.generation || !finalState.validation || !finalState.previewMarkdown || !finalState.previewSummary) {
    throw new Error("Pipeline completed without all required artifacts.");
  }

  return PipelineResultSchema.parse({
    requestId,
    brief,
    plan: finalState.plan,
    generation: finalState.generation,
    validation: finalState.validation,
    preview: {
      title: `${brief.topic} — Instructor Preview`,
      summary: finalState.previewSummary,
      markdown: finalState.previewMarkdown,
    },
    traces: finalState.traces,
    nodeExecutions: finalState.nodeExecutions,
    artifacts: finalState.artifacts,
    escalations: finalState.escalations,
    createdAt: new Date().toISOString(),
  });
}
