import type { FastifyInstance } from "fastify";
import { InstructorPreviewEvaluationRequestSchema, PipelineRequestSchema } from "@curriculum/schemas";
import { runPipeline } from "../pipeline/graph.js";
import { evaluateInstructorPreview } from "../pipeline/preview-evaluator.js";

export async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/pipeline/run", async (request, reply) => {
    const parsed = PipelineRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request",
        issues: parsed.error.issues,
      });
    }

    const result = await runPipeline(parsed.data.brief, parsed.data.options);
    return reply.send(result);
  });

  app.post("/v1/pipeline/evaluate-preview", async (request, reply) => {
    const parsed = InstructorPreviewEvaluationRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request",
        issues: parsed.error.issues,
      });
    }

    const evaluation = await evaluateInstructorPreview({
      brief: parsed.data.brief,
      preview: parsed.data.preview,
    });
    return reply.send(evaluation);
  });
}
