import { ReducedValue, StateSchema } from "@langchain/langgraph";
import {
  BriefInputSchema,
  CurriculumPlanSchema,
  GenerationOutputSchema,
  IntermediateArtifactsSchema,
  NodeExecutionSchema,
  PipelineRunOptionsSchema,
  TraceEventSchema,
  ValidationReportSchema,
} from "@curriculum/schemas";
import { z } from "zod";

export const PipelineStateSchema = new StateSchema({
  requestId: z.string(),
  brief: BriefInputSchema,
  options: PipelineRunOptionsSchema,
  plan: CurriculumPlanSchema.nullable().default(null),
  generation: GenerationOutputSchema.nullable().default(null),
  validation: ValidationReportSchema.nullable().default(null),
  previewMarkdown: z.string().nullable().default(null),
  previewSummary: z.string().nullable().default(null),
  artifacts: IntermediateArtifactsSchema.default({
    diagramSnippets: [],
    criticReviews: [],
    validationTraces: [],
  }),
  promptLog: z.record(z.string(), z.string()).default({}),
  nodeExecutions: new ReducedValue(z.array(NodeExecutionSchema).default([]), {
    reducer: (current, next) => current.concat(next),
  }),
  traces: new ReducedValue(z.array(TraceEventSchema).default([]), {
    reducer: (current, next) => current.concat(next),
  }),
  escalations: new ReducedValue(z.array(z.string()).default([]), {
    reducer: (current, next) => current.concat(next),
  }),
});

export type PipelineState = typeof PipelineStateSchema.State;
