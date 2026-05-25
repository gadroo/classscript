import type { GraphNode } from "@langchain/langgraph";
import { GenerationOutputSchema } from "@curriculum/schemas";
import { buildGenerationPrompt, commonSystemRules } from "@curriculum/prompts";
import type { PipelineStateSchema } from "../state.js";
import { fallbackGeneration } from "../fallbacks.js";
import { generateStructuredObject } from "../llm/client.js";
import { buildNodeExecution, clampUnit, nowIso, shouldReuseStage, toTrace } from "../utils.js";

function hasPlaceholder(text: string): boolean {
  return /(placeholder|tbd|todo|lorem ipsum|module\s*\d+)/i.test(text);
}

export const generateNode: GraphNode<typeof PipelineStateSchema> = async (state) => {
  const startedAt = nowIso();
  const stage = "generation" as const;

  if (shouldReuseStage(state.options.regenerateStages, stage) && state.generation) {
    const execution = buildNodeExecution({
      node: stage,
      status: "skipped",
      startedAt,
      confidence: state.generation.confidence,
      logs: ["Reused generation artifact from prior state."],
      inputArtifacts: ["plan", "artifacts.retrieval", "artifacts.decomposition", "artifacts.audienceStrategy"],
      outputArtifacts: ["generation"],
    });
    return { nodeExecutions: [execution], traces: [toTrace(execution)] };
  }

  if (!state.plan || !state.artifacts.retrieval || !state.artifacts.decomposition || !state.artifacts.audienceStrategy) {
    const execution = buildNodeExecution({
      node: stage,
      status: "error",
      startedAt,
      errors: ["Missing plan or required artifacts for generation."],
    });
    return {
      escalations: ["Generation blocked due to missing required artifacts."],
      nodeExecutions: [execution],
      traces: [toTrace(execution)],
    };
  }

  let generation = fallbackGeneration(
    state.brief,
    state.plan,
    state.artifacts.decomposition,
    state.artifacts.retrieval,
  );
  const warnings: string[] = [];
  let retries = 0;
  let model: string | undefined;
  let prompt = "";

  if (state.options.enableLlm) {
    try {
      prompt = buildGenerationPrompt(
        state.brief,
        state.plan,
        state.artifacts.decomposition,
        state.artifacts.audienceStrategy,
        state.artifacts.retrieval,
      );
      const llm = await generateStructuredObject({
        schema: GenerationOutputSchema,
        schemaName: "GenerationOutput",
        systemPrompt: `${commonSystemRules}\nYou generate instructional scripts, code, and exercises that are grounded and classroom-ready.`,
        userPrompt: prompt,
        maxRetries: state.options.maxNodeRetries,
      });
      generation = llm.output;
      retries = llm.attempts - 1;
      model = llm.model;
    } catch (error) {
      warnings.push(error instanceof Error ? `LLM generation failed; fallback used: ${error.message}` : "LLM generation failed; fallback used.");
    }
  } else {
    warnings.push("LLM disabled; deterministic generation used.");
  }

  const placeholderCount = generation.scriptSections.flatMap((section) => [
    section.narration,
    section.transition,
    section.interactionPrompt,
    section.beginnerLayer,
    section.advancedLayer,
    section.cognitiveBridge,
    section.abstractionShift,
    section.debugScenario.symptom,
    section.debugScenario.likelyRootCause,
  ]).filter((text) => hasPlaceholder(text)).length;

  if (placeholderCount > 0) {
    warnings.push(`Detected ${placeholderCount} placeholder-like fragments in generated script.`);
  }

  const moduleCount = Math.max(1, state.plan.modules.length);
  const implementationCoverage = generation.scriptSections.filter((section) => section.implementationArtifact.stackApis.length >= 2).length / moduleCount;
  const debugCoverage = generation.scriptSections.filter((section) => section.debugScenario.investigationSteps.length >= 2).length / moduleCount;
  const groundingCoverage = generation.scriptSections.filter((section) => section.groundedClaims.length > 0).length / moduleCount;
  if (implementationCoverage < 1) {
    warnings.push(`Implementation artifact coverage is ${Math.round(implementationCoverage * 100)}%; expected 100% across modules.`);
  }
  if (debugCoverage < 1) {
    warnings.push(`Debug scenario coverage is ${Math.round(debugCoverage * 100)}%; expected 100% across modules.`);
  }
  if (groundingCoverage < 1) {
    warnings.push(`Inline grounded-claim coverage is ${Math.round(groundingCoverage * 100)}%; expected 100% across modules.`);
  }

  if (state.brief.includeCheatSheet && generation.cheatSheet.length === 0) {
    generation = {
      ...generation,
      cheatSheet: [
        "Start from concrete scenario before abstractions.",
        "Use layered beginner and advanced transitions per module.",
        "Validate snippets before class and cite official docs.",
      ],
    };
    warnings.push("Cheat sheet was missing and has been backfilled.");
  }

  const groundedReferences = new Set([
    ...generation.references,
    ...state.artifacts.retrieval.sources.map((source) => source.url),
  ]);

  generation = {
    ...generation,
    references: Array.from(groundedReferences).slice(0, 8),
    confidence: clampUnit(
      generation.confidence
      - placeholderCount * 0.03
      + (state.artifacts.retrieval.confidence - 0.6) * 0.2
      + (implementationCoverage - 0.85) * 0.22
      + (debugCoverage - 0.85) * 0.18
      + (groundingCoverage - 0.85) * 0.18,
    ),
  };

  const execution = buildNodeExecution({
    node: stage,
    status: warnings.length > 0 ? "warning" : "success",
    startedAt,
    retries,
    confidence: generation.confidence,
    warnings,
    metrics: {
      sectionCount: generation.scriptSections.length,
      codeSnippetCount: generation.codeSnippets.length,
      exerciseCount: generation.exercises.length,
      referenceCount: generation.references.length,
      placeholderCount,
      implementationCoverage: Math.round(implementationCoverage * 100),
      debugCoverage: Math.round(debugCoverage * 100),
      groundingCoverage: Math.round(groundingCoverage * 100),
    },
    inputArtifacts: ["plan", "artifacts.retrieval", "artifacts.decomposition", "artifacts.audienceStrategy"],
    outputArtifacts: ["generation"],
    validationTraces: [
      `sections=${generation.scriptSections.length}`,
      `snippets=${generation.codeSnippets.length}`,
      `references=${generation.references.length}`,
    ],
    model,
  });

  return {
    generation,
    promptLog: prompt
      ? {
          ...state.promptLog,
          generator: prompt,
        }
      : state.promptLog,
    nodeExecutions: [execution],
    traces: [toTrace(execution)],
  };
};
