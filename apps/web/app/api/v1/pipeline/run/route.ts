import { PipelineRequestSchema } from "@curriculum/schemas";
import { runPipeline } from "@curriculum/api/src/pipeline/graph.js";
import { ZodError } from "zod";

export const config = {
  maxDuration: 90,
};

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const parsed = PipelineRequestSchema.safeParse(body);

    if (!parsed.success) {
      return Response.json(
        {
          error: "Invalid request",
          issues: parsed.error.issues,
        },
        { status: 400 }
      );
    }

    const result = await runPipeline(parsed.data.brief, parsed.data.options);
    return Response.json(result);
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json(
        {
          error: "Validation error",
          issues: error.issues,
        },
        { status: 400 }
      );
    }
    console.error("Pipeline error:", error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
