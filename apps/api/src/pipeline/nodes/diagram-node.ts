import { z } from "zod";
import type { GraphNode } from "@langchain/langgraph";
import { CodeSnippetSchema, type CodeSnippet } from "@curriculum/schemas";
import { buildDiagramPrompt, commonSystemRules } from "@curriculum/prompts";
import type { PipelineStateSchema } from "../state.js";
import { generateStructuredObject } from "../llm/client.js";
import { buildNodeExecution, nowIso, shouldReuseStage, toTrace } from "../utils.js";

const DiagramSnippetListSchema = z.object({
  diagramSnippets: z.array(CodeSnippetSchema).max(4),
});

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
}

function expectedDiagramCount(beginnerPercent: number, advancedPercent: number): number {
  return Math.min(beginnerPercent, advancedPercent) >= 30 ? 2 : 1;
}

function buildTopicTokenSet(topic: string, moduleTitles: string[]): Set<string> {
  const topicTokens = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  const tokens = new Set<string>(topicTokens);
  for (const title of moduleTitles) {
    for (const token of tokenize(title)) {
      tokens.add(token);
    }
  }
  return tokens;
}

function diagramLooksMeaningful(code: string, topicTokens: Set<string>): boolean {
  const normalized = code.toLowerCase();
  const edgeCount = (normalized.match(/-->|==>|-\.->|---/g) ?? []).length;
  const hasFlowSignature = /^(flowchart|graph)\s+(td|lr|rl|bt)\b/m.test(normalized);
  const genericOnly = [
    "core concept",
    "beginner anchor",
    "advanced extension",
    "practice exercise",
    "checkpoint review",
    "teaching flow",
  ].filter((token) => normalized.includes(token)).length >= 2;
  const overlapHits = Array.from(topicTokens).filter((token) => normalized.includes(token)).length;
  return hasFlowSignature && edgeCount >= 3 && overlapHits >= 2 && !genericOnly;
}

function fallbackDiagramSnippets(topic: string, beginnerPercent: number, advancedPercent: number): CodeSnippet[] {
  const base: CodeSnippet[] = [
    {
      id: "diagram-topic-lifecycle",
      title: `${topic} Core Lifecycle`,
      language: "text" as const,
      description: `Operational flow of ${topic} from setup through validation.`,
      dependencies: [],
      code: [
        "flowchart TD",
        `  A[Define ${topic} objective] --> B[Prepare inputs and prerequisites]`,
        `  B --> C[Apply core ${topic} mechanism]`,
        "  C --> D{Expected outcome achieved?}",
        "  D -- No --> E[Debug root cause and adjust implementation]",
        "  E --> C",
        "  D -- Yes --> F[Run guided practice and verify results]",
        "  F --> G[Document constraints and next-step transition]",
      ].join("\n"),
    },
  ];
  if (expectedDiagramCount(beginnerPercent, advancedPercent) >= 2) {
    base.push({
      id: "diagram-production-decision-flow",
      title: `${topic} Production Trade-off Flow`,
      language: "text" as const,
      description: "Decision flow for choosing production constraints and mitigation paths.",
      dependencies: [],
      code: [
        "flowchart LR",
        "  A[Production requirement] --> B{Primary constraint}",
        "  B -- Latency --> C[Choose low-latency path]",
        "  B -- Reliability --> D[Choose containment and fallback path]",
        "  C --> E[Measure throughput and p95 latency]",
        "  D --> E",
        "  E --> F{SLO target met?}",
        "  F -- No --> G[Adjust architecture and retry]",
        "  G --> B",
        "  F -- Yes --> H[Ship with observability guardrails]",
      ].join("\n"),
    });
  }
  return base;
}

export const diagramNode: GraphNode<typeof PipelineStateSchema> = async (state) => {
  const startedAt = nowIso();
  const stage = "diagram" as const;

  if (shouldReuseStage(state.options.regenerateStages, stage) && state.artifacts.diagramSnippets.length > 0) {
    const execution = buildNodeExecution({
      node: stage,
      status: "skipped",
      startedAt,
      confidence: 0.9,
      logs: ["Reused diagram snippets from prior state."],
      inputArtifacts: ["generation", "plan"],
      outputArtifacts: ["artifacts.diagramSnippets", "generation"],
    });
    return { nodeExecutions: [execution], traces: [toTrace(execution)] };
  }

  if (!state.plan || !state.generation) {
    const execution = buildNodeExecution({
      node: stage,
      status: "error",
      startedAt,
      errors: ["Missing plan or generation artifact."],
    });
    return {
      escalations: ["Diagram generation blocked because plan or generation artifact is missing."],
      nodeExecutions: [execution],
      traces: [toTrace(execution)],
    };
  }

  const requireDiagrams = state.artifacts.artifactPlan?.requireDiagrams ?? state.brief.includeFlowcharts;
  if (!requireDiagrams) {
    const execution = buildNodeExecution({
      node: stage,
      status: "skipped",
      startedAt,
      confidence: 1,
      logs: ["Diagram requirements disabled for this brief."],
      inputArtifacts: ["generation", "plan"],
    });
    return { nodeExecutions: [execution], traces: [toTrace(execution)] };
  }

  const moduleTitles = state.plan.modules.map((module) => module.title);
  const topicTokens = buildTopicTokenSet(state.brief.topic, moduleTitles);
  const requiredDiagramCount = expectedDiagramCount(
    state.brief.audience.beginnerPercent,
    state.brief.audience.advancedPercent,
  );
  let diagramSnippets: CodeSnippet[] = fallbackDiagramSnippets(
    state.brief.topic,
    state.brief.audience.beginnerPercent,
    state.brief.audience.advancedPercent,
  );
  const warnings: string[] = [];
  let retries = 0;
  let model: string | undefined;
  let prompt = "";

  if (state.options.enableLlm) {
    try {
      prompt = buildDiagramPrompt(state.brief, state.plan, state.generation);
      const llm = await generateStructuredObject({
        schema: DiagramSnippetListSchema,
        schemaName: "DiagramSnippetList",
        systemPrompt: `${commonSystemRules}\nYou are a diagram generation engine. Emit Mermaid in code fields with language='text'.`,
        userPrompt: prompt,
        maxRetries: state.options.maxNodeRetries,
      });
      const rawDiagrams = llm.output.diagramSnippets.filter((snippet): snippet is CodeSnippet => snippet.language === "text");
      const meaningfulDiagrams = rawDiagrams.filter((snippet) => diagramLooksMeaningful(snippet.code, topicTokens));
      if (meaningfulDiagrams.length < requiredDiagramCount) {
        warnings.push(
          `Generated diagrams were not sufficiently topic-specific/flow-oriented (${meaningfulDiagrams.length}/${requiredDiagramCount}); fallback diagrams added.`,
        );
      }
      const fallbackDiagrams = fallbackDiagramSnippets(
        state.brief.topic,
        state.brief.audience.beginnerPercent,
        state.brief.audience.advancedPercent,
      );
      diagramSnippets = [...meaningfulDiagrams, ...fallbackDiagrams].slice(0, requiredDiagramCount);
      retries = llm.attempts - 1;
      model = llm.model;
    } catch (error) {
      warnings.push(error instanceof Error ? `LLM diagram generation failed; fallback used: ${error.message}` : "LLM diagram generation failed; fallback used.");
    }
  } else {
    warnings.push("LLM disabled; deterministic diagram fallback used.");
  }

  const mergedSnippets = [
    ...state.generation.codeSnippets.filter((snippet) => snippet.language !== "text"),
    ...diagramSnippets,
  ];

  const execution = buildNodeExecution({
    node: stage,
    status: warnings.length > 0 ? "warning" : "success",
    startedAt,
    retries,
    confidence: 0.85,
    warnings,
    metrics: {
      diagramSnippetCount: diagramSnippets.length,
    },
    inputArtifacts: ["generation", "plan"],
    outputArtifacts: ["artifacts.diagramSnippets", "generation"],
    validationTraces: diagramSnippets.map((snippet) => `${snippet.id}:${snippet.code.split("\n")[0] ?? ""}`),
    model,
  });

  return {
    generation: {
      ...state.generation,
      codeSnippets: mergedSnippets,
    },
    artifacts: {
      ...state.artifacts,
      diagramSnippets,
    },
    promptLog: prompt
      ? {
          ...state.promptLog,
          diagrammer: prompt,
        }
      : state.promptLog,
    nodeExecutions: [execution],
    traces: [toTrace(execution)],
  };
};
