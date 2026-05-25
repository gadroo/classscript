import { InstructorPreviewEvaluationRequestSchema } from "@curriculum/schemas";
import { evaluateInstructorPreview } from "@curriculum/api/src/pipeline/preview-evaluator.js";
import { ZodError } from "zod";

export const config = {
  maxDuration: 90,
};

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const parsed = InstructorPreviewEvaluationRequestSchema.safeParse(body);

    if (!parsed.success) {
      return Response.json(
        {
          error: "Invalid request",
          issues: parsed.error.issues,
        },
        { status: 400 }
      );
    }

    const evaluation = await evaluateInstructorPreview({
      brief: parsed.data.brief,
      preview: parsed.data.preview,
    });
    return Response.json(evaluation);
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
    console.error("Evaluation error:", error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
