import {
  ArtifactPlanSchema,
  AudienceStrategySchema,
  CurriculumPlanSchema,
  GenerationOutputSchema,
  TopicDecompositionSchema,
  type ArtifactPlan,
  type AudienceStrategy,
  type BriefInput,
  type CurriculumPlan,
  type GenerationOutput,
  type RetrievalArtifact,
  type TopicDecomposition,
  type PedagogicalStrategySelection,
} from "@curriculum/schemas";
import {
  allocateModuleMinutes,
  averagePrerequisiteDepth,
  buildTopicProfile,
  selectConceptsForBrief,
  type TopicConcept,
} from "./topic-intelligence.js";
import { clampUnit, normalizeTopic, round } from "./utils.js";

function slugify(value: string): string {
  return normalizeTopic(value).replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function fallbackDecomposition(brief: BriefInput): TopicDecomposition {
  const profile = buildTopicProfile(brief.topic);
  const targetCount = Math.max(3, Math.min(8, Math.round(brief.durationMinutes / 20)));
  const concepts = selectConceptsForBrief(brief.topic, targetCount);

  return TopicDecompositionSchema.parse({
    canonicalTopic: profile.canonicalTopic,
    progressionRationale: "Concept sequence follows prerequisite depth and increasing implementation complexity.",
    concepts: concepts.map((concept) => ({
      id: concept.id,
      title: concept.title,
      summary: concept.summary,
      learningObjective: concept.objective,
      difficulty: round(concept.difficulty),
      prerequisites: concept.prerequisites,
      commonMisconceptions: [concept.failureCase],
      assessmentPrompt: concept.interactionPrompt,
    })),
    confidence: clampUnit(0.68 + averagePrerequisiteDepth(concepts) * 0.16),
  });
}

export function fallbackAudienceStrategy(brief: BriefInput, decomposition: TopicDecomposition): AudienceStrategy {
  const beginner = brief.audience.beginnerPercent / 100;
  const advanced = brief.audience.advancedPercent / 100;
  const spread = Math.abs(beginner - advanced);
  const complexity = decomposition.concepts.reduce((sum, concept) => sum + concept.difficulty, 0) / decomposition.concepts.length;
  const instabilityScore = clampUnit((1 - spread) * 0.65 + complexity * 0.35);

  let mode: AudienceStrategy["mode"] = "balanced-layered";
  if (beginner >= 0.7) {
    mode = "beginner-dominant";
  } else if (advanced >= 0.7) {
    mode = "advanced-dominant";
  } else if (instabilityScore > 0.86 || brief.teachingMode === "segmented") {
    mode = "segmented";
  }

  return AudienceStrategySchema.parse({
    mode,
    divergenceScore: clampUnit(instabilityScore),
    instabilityScore,
    beginnerWeight: beginner,
    advancedWeight: advanced,
    rationale: mode === "balanced-layered"
      ? "Audience is in the unstable mixed band; layered teaching is enforced."
      : `Mode selected from audience distribution and concept complexity: ${mode}.`,
    recommendedInterventions: mode === "segmented"
      ? [
          "Split class into two tracks for prerequisites and advanced applications.",
          "Run separate exercises per track and a shared synthesis checkpoint.",
        ]
      : [
          "Keep a shared core flow and inject role-specific support layers.",
          "Use explicit transitions before switching depth level.",
        ],
    confidence: clampUnit(0.74 + (1 - instabilityScore) * 0.2),
  });
}

export function fallbackArtifactPlan(
  brief: BriefInput,
  audience: AudienceStrategy,
  strategy?: PedagogicalStrategySelection,
): ArtifactPlan {
  const durationFactor = clampUnit(brief.durationMinutes / 180);
  const instabilityLift = audience.mode === "balanced-layered" ? 0.12 : audience.mode === "segmented" ? 0.18 : 0.06;

  const defaultCodeDensity = brief.includeCode ? clampUnit(0.24 + durationFactor * 0.2) : 0;
  const defaultDiagramDensity = brief.includeFlowcharts ? clampUnit(0.15 + instabilityLift) : 0;
  const defaultExerciseDensity = brief.includeExercises ? clampUnit(0.22 + instabilityLift * 0.5) : 0;

  return ArtifactPlanSchema.parse({
    requireCode: brief.includeCode,
    requireDiagrams: brief.includeFlowcharts,
    requireExercises: brief.includeExercises,
    requireCheatSheet: brief.includeCheatSheet,
    requireQuiz: true,
    requireGlossary: audience.mode !== "advanced-dominant",
    codeDensityTarget: brief.includeCode
      ? strategy ? clampUnit((defaultCodeDensity + strategy.targetDensities.code) / 2) : defaultCodeDensity
      : 0,
    diagramDensityTarget: brief.includeFlowcharts
      ? strategy ? clampUnit((defaultDiagramDensity + strategy.targetDensities.diagram) / 2) : defaultDiagramDensity
      : 0,
    exerciseDensityTarget: brief.includeExercises
      ? strategy ? clampUnit((defaultExerciseDensity + strategy.targetDensities.exercise) / 2) : defaultExerciseDensity
      : 0,
    enforcementRules: [
      "At least one script section per planned module.",
      "Every module must include a beginner and advanced layer.",
      "Every module must include explicit cognitive bridge and abstraction shift text.",
      "Every module must include one implementation artifact with stack-specific APIs.",
      "Every module must include one realistic debugging scenario and fix verification path.",
      "Every module must include inline grounded claims that map to retrieved sources.",
      "Each generated code snippet must compile and execute in target runtime.",
      "If diagrams are required, include at least one Mermaid flow diagram.",
      ...(strategy ? [`Align artifact mix with golden strategy profile: ${strategy.selectedExampleIds.join(", ")}.`] : []),
    ],
    confidence: strategy ? clampUnit((0.82 + strategy.confidence) / 2) : 0.82,
  });
}

function conceptForModule(moduleId: string, moduleTitle: string, decomposition: TopicDecomposition, index: number): TopicConcept | null {
  const profile = buildTopicProfile(decomposition.canonicalTopic);
  const concepts = profile.concepts;
  const byId = concepts.find((concept) => moduleId.includes(concept.id));
  if (byId) {
    return byId;
  }
  const byTitle = concepts.find((concept) => concept.title === moduleTitle);
  if (byTitle) {
    return byTitle;
  }
  return concepts[index] ?? concepts[concepts.length - 1] ?? null;
}

function buildStackApiList(brief: BriefInput): string[] {
  const stack = [
    brief.targetStack.language.toLowerCase(),
    brief.targetStack.runtime.toLowerCase(),
    ...brief.targetStack.frameworks.map((framework) => framework.toLowerCase()),
  ];

  const apis = new Set<string>([
    "StateGraph.addNode",
    "StateGraph.addEdge",
    "RunnableSequence.invoke",
    "AbortController",
    "Map<string, MemoryRecord>",
  ]);

  if (stack.some((value) => value.includes("langgraph"))) {
    apis.add("StateGraph.compile");
  }
  if (stack.some((value) => value.includes("langchain"))) {
    apis.add("MemoryVectorStore.similaritySearch");
  }
  if (stack.some((value) => value.includes("openai"))) {
    apis.add("client.embeddings.create");
  }
  if (stack.some((value) => value.includes("pinecone") || value.includes("qdrant") || value.includes("weaviate"))) {
    apis.add("vectorIndex.upsert");
    apis.add("vectorIndex.query");
  }

  return Array.from(apis).slice(0, 5);
}

function buildModuleArtifactType(index: number): "langgraph-workflow" | "langchain-retriever" | "vector-index-policy" | "memory-policy" | "evaluation-harness" | "deterministic-agent-runner" | "observability" {
  const sequence: Array<
    "langgraph-workflow"
    | "langchain-retriever"
    | "vector-index-policy"
    | "memory-policy"
    | "evaluation-harness"
    | "deterministic-agent-runner"
    | "observability"
  > = [
    "memory-policy",
    "langchain-retriever",
    "vector-index-policy",
    "langgraph-workflow",
    "deterministic-agent-runner",
    "evaluation-harness",
    "observability",
  ];
  return sequence[index % sequence.length];
}

export function fallbackCurriculumPlan(
  brief: BriefInput,
  decomposition: TopicDecomposition,
  audience: AudienceStrategy,
  strategy?: PedagogicalStrategySelection,
): CurriculumPlan {
  const moduleCount = Math.max(3, Math.min(8, Math.round(brief.durationMinutes / 24)));
  const selected = decomposition.concepts.slice(0, moduleCount);
  const minutePlan = allocateModuleMinutes(
    selected.map((concept) => ({
      id: concept.id,
      title: concept.title,
      objective: concept.learningObjective,
      summary: concept.summary,
      beginnerAnalogy: "",
      beginnerDefinition: "",
      advancedTradeoff: "",
      failureCase: concept.commonMisconceptions[0] ?? "",
      interactionPrompt: concept.assessmentPrompt,
      transitionQuestion: "",
      implementationTask: "",
      difficulty: concept.difficulty,
      prerequisites: concept.prerequisites,
    })),
    brief.durationMinutes,
  );

  const warnings: string[] = [];
  if (audience.mode === "balanced-layered" || audience.mode === "segmented") {
    warnings.push("Audience divergence is high; enforce layered transitions and checkpoint cadence.");
  }
  warnings.push("Self-critique: watch for abstraction jumps when moving from mechanism to system constraints.");
  warnings.push("Self-critique: preflight hidden prerequisites at module openings to prevent beginner confusion.");

  return CurriculumPlanSchema.parse({
    learningObjectives: selected.slice(0, 5).map((concept) => concept.learningObjective),
    modules: selected.map((concept, index) => ({
      id: `module-${index + 1}-${slugify(concept.id)}`,
      title: concept.title,
      objective: concept.learningObjective,
      estimatedMinutes: minutePlan[index] ?? Math.max(10, Math.floor(brief.durationMinutes / selected.length)),
      difficulty: concept.difficulty,
      beginnerSupport: [
        `Assumptions to state first: ${concept.prerequisites.join(", ") || "No prerequisite assumptions; define all core terms before use."}`,
        `Beginner flow: Concrete Example -> Mental Model -> Simplified Mechanism -> Failure Mode -> Production Constraint -> Abstraction for ${concept.title}.`,
        `Likely confusion point: ${concept.commonMisconceptions[0] ?? "Learners may overgeneralize a single successful run."}`,
      ],
      advancedExtensions: [
        `Trade-offs for ${concept.title}: cost vs latency vs reliability under production load.`,
        `Operational concerns: scaling limits, observability signal design, and rollback/failure containment for ${concept.title}.`,
        `Architecture implication prompt using prerequisite chain: ${concept.prerequisites.join(" -> ") || "none"}.`,
      ],
    })),
    pacingNotes: [
      "Time model per module: teaching 45%, learner processing 20%, practice 20%, debugging walkthrough 10%, Q&A + transition 5%.",
      "Insert recap checkpoints every 20 minutes and reduce new terminology in the final third.",
      "Reserve 10% of total duration for synthesis and transfer reflection.",
      "Use transition questions before depth escalation to preserve prerequisite transfer.",
      ...(strategy ? [`Teaching style guidance from golden strategy: ${strategy.teachingStyle}.`] : []),
    ],
    warnings,
    confidence: clampUnit(0.78 + (1 - audience.instabilityScore) * 0.1),
  });
}

export function fallbackGeneration(
  brief: BriefInput,
  plan: CurriculumPlan,
  decomposition: TopicDecomposition,
  retrieval: RetrievalArtifact,
): GenerationOutput {
  const practiceFormats = ["prediction", "implementation", "diagnosis", "critique"] as const;
  const bridgePatterns = [
    "Contrast a successful local run with a failing production run to expose missing assumptions.",
    "Ask learners which beginner simplification no longer holds when data volume grows.",
    "Use a before/after architecture sketch to map concept shifts from single-run logic to system behavior.",
    "Compare two fixes and justify why one is safer under incident pressure.",
  ] as const;
  const debugTemplates = [
    {
      symptom: "Retrieved memories are stale, causing responses to ignore the latest user preference.",
      reproductionSteps: [
        "Replay two sessions with contradictory preferences under one user id.",
        "Run retrieval before invalidation to capture stale top-k hits.",
        "Submit a query that should favor the newest preference and record mismatch.",
      ],
      likelyRootCause: "Invalidation policy is missing version pinning, so stale embeddings outrank newer facts.",
      investigationSteps: [
        "Inspect write timestamps and version metadata for conflicting memory keys.",
        "Compare retrieval score distribution before and after re-embedding recent facts.",
        "Verify summarizer output did not drop must-keep constraints.",
      ],
      fixSummary: "Add versioned invalidation plus freshness weighting and retain must-keep constraints in summaries.",
      verificationChecks: [
        "Latest preference appears in top-3 retrieval for validation queries.",
        "Contradiction rate drops below configured threshold across replay set.",
      ],
    },
    {
      symptom: "Throughput collapses during peak load and requests time out in memory retrieval path.",
      reproductionSteps: [
        "Run load test with burst traffic at 4x baseline request rate.",
        "Enable tracing and record p95/p99 latency for retrieval and ranking stages.",
        "Force cache misses to isolate vector index behavior.",
      ],
      likelyRootCause: "Synchronous retrieval and ranking saturate worker threads without backpressure controls.",
      investigationSteps: [
        "Inspect queue depth, thread utilization, and retry storms during bursts.",
        "Profile latency contribution from vector query, reranker, and post-filter stages.",
        "Check for missing circuit-breaker thresholds around slow dependencies.",
      ],
      fixSummary: "Add bounded concurrency, adaptive backpressure, and timeout-aware fallback retrieval policy.",
      verificationChecks: [
        "p95 latency remains within SLO under 4x burst traffic.",
        "Timeout rate and retry storms stay below alert thresholds.",
      ],
    },
    {
      symptom: "Precision improves after tuning, but recall drops and relevant memories disappear from results.",
      reproductionSteps: [
        "Raise similarity threshold and replay benchmark queries.",
        "Measure precision@k and recall@k before and after threshold change.",
        "Inspect misses for ground-truth relevant memory ids.",
      ],
      likelyRootCause: "Threshold and post-filters were tuned for precision only, over-pruning semantically relevant items.",
      investigationSteps: [
        "Compare retrieval distributions across cohorts and query types.",
        "Audit filter predicates for accidental hard exclusions.",
        "Trace evaluation harness for metric aggregation drift.",
      ],
      fixSummary: "Use dual-threshold retrieval with cohort-aware tuning and monitor precision/recall jointly.",
      verificationChecks: [
        "Recall@k returns to baseline while precision remains within target band.",
        "Evaluation harness shows stable metrics across multiple cohorts.",
      ],
    },
    {
      symptom: "Two concurrent writes race and overwrite deterministic state, causing non-repeatable outputs.",
      reproductionSteps: [
        "Trigger parallel runs that write the same memory key within one second.",
        "Replay identical inputs across three runs and compare output divergence.",
        "Enable mutation logging for write ordering trace.",
      ],
      likelyRootCause: "Write path lacks idempotency keys and atomic compare-and-swap semantics.",
      investigationSteps: [
        "Inspect write logs for interleaving order and duplicate mutation ids.",
        "Check transaction boundaries and conflict retry behavior.",
        "Validate deterministic runner invariants under concurrent execution.",
      ],
      fixSummary: "Introduce idempotency keys, atomic writes, and deterministic conflict-resolution policy.",
      verificationChecks: [
        "Repeated runs with identical inputs produce identical outputs.",
        "Concurrent write conflicts are resolved without state divergence.",
      ],
    },
  ] as const;

  const sourceByUrl = new Map(retrieval.sources.map((source) => [source.url, source]));
  const stackApis = buildStackApiList(brief);
  const scriptSections = plan.modules.map((module, index) => {
    const concept = conceptForModule(module.id, module.title, decomposition, index);
    const nextModule = plan.modules[index + 1];
    const objective = concept?.objective ?? module.objective;
    const primarySource = retrieval.sources[index % Math.max(1, retrieval.sources.length)];
    const secondarySource = retrieval.sources[(index + 1) % Math.max(1, retrieval.sources.length)];
    const artifactType = buildModuleArtifactType(index);
    const debugTemplate = debugTemplates[index % debugTemplates.length];
    const misconception = concept?.failureCase ?? module.beginnerSupport[2] ?? "Learners may apply a local success pattern to production without validation.";
    const practiceFormat = practiceFormats[index % practiceFormats.length];
    const moduleApis = [
      stackApis[index % stackApis.length],
      stackApis[(index + 1) % stackApis.length],
      stackApis[(index + 2) % stackApis.length],
    ].filter((value): value is string => Boolean(value));

    return {
      moduleId: module.id,
      narration: [
        `Prior Knowledge: ${concept?.prerequisites.join(", ") || "none; define every required term in-session"}.`,
        `New Concept: ${module.title} for objective "${objective}".`,
        `Concrete Example: walkthrough one end-to-end ${module.title.toLowerCase()} case before policy abstractions.`,
        "Guided Reasoning: ask learners to justify each design step using explicit assumptions and expected failure boundaries.",
      ].join(" "),
      transition: nextModule
        ? `Reflection: have learners state what failed and why in ${module.title}. Transition: connect that gap to prerequisite needs for ${nextModule.title}.`
        : `Reflection: learners summarize durable heuristics and top failure checks. Transition: move to synthesis and production readiness checklist.`,
      interactionPrompt: `Practice (${practiceFormat}): ${concept?.interactionPrompt ?? `apply ${module.title} to one production scenario`}. Include one prior concept from ${plan.modules[Math.max(0, index - 1)]?.title ?? "the previous module"} and explicitly address this misconception: ${misconception}`,
      beginnerLayer: [
        `Concrete Example: ${module.title} applied to one realistic request path.`,
        `Mental Model: ${concept?.summary ?? module.objective}.`,
        "Simplified Mechanism: explain the smallest deterministic loop (input -> decision -> output).",
        `Failure Mode: ${misconception}.`,
        "Production Constraint: state one latency, reliability, or cost boundary that breaks the simplified mechanism.",
        `Abstraction: generalize into a repeatable policy learners can transfer to the next module.`,
      ].join(" "),
      advancedLayer: [
        module.advancedExtensions.join(" "),
        "Trade-offs: quantify cost vs latency vs reliability and decide which metric is optimized first.",
        "Scaling constraints: identify throughput limits, contention points, and degradation behavior.",
        "Operational concerns: define alerting thresholds, rollback path, and on-call escalation trigger.",
        "Debugging complexity: include one ambiguity where symptoms can map to multiple root causes.",
        "Architecture implications: explain boundary ownership and coupling risk across services.",
        "Observability implications: specify logs, metrics, traces, and sampling strategy.",
      ].join(" "),
      cognitiveBridge: `${bridgePatterns[index % bridgePatterns.length]} Use this contrast to move from beginner intuition to operational judgment for ${module.title}.`,
      abstractionShift: `Move from concrete behavior to policy guardrails, then to architecture constraints and incident-response decisions for ${module.title}.`,
      implementationArtifact: {
        artifactType,
        title: `${module.title} ${artifactType.replace(/-/g, " ")}`.replace(/\b\w/g, (char) => char.toUpperCase()),
        files: [`src/${module.id}.ts`, `src/${module.id}.spec.ts`],
        stackApis: moduleApis.slice(0, 3),
        acceptanceCriteria: [
          `Implements ${module.title} path deterministically with explicit input/output contract.`,
          "Logs retrieval score, memory write decision, and guardrail result for each run.",
          "Includes regression checks for at least one module-specific production failure mode.",
        ],
      },
      debugScenario: {
        title: `${module.title} failure triage`,
        symptom: debugTemplate.symptom,
        reproductionSteps: [...debugTemplate.reproductionSteps],
        likelyRootCause: debugTemplate.likelyRootCause,
        investigationSteps: [...debugTemplate.investigationSteps],
        fixSummary: debugTemplate.fixSummary,
        verificationChecks: [...debugTemplate.verificationChecks],
      },
      groundedClaims: [
        {
          claim: `${primarySource?.title ?? "Official API documentation"} guidance for ${module.title} should be translated into explicit runtime checks, not only narrative explanation.`,
          sourceUrl: primarySource?.url ?? retrieval.sources[0]?.url ?? "https://platform.openai.com/docs/api-reference",
          sourceTitle: primarySource?.title ?? sourceByUrl.get("https://platform.openai.com/docs/api-reference")?.title ?? "OpenAI API Docs",
        },
        {
          claim: `${secondarySource?.title ?? "LangGraph JS Docs"} indicates retrieval and memory quality depend on clear write/read policy boundaries and validation loops.`,
          sourceUrl: secondarySource?.url ?? primarySource?.url ?? retrieval.sources[0]?.url ?? "https://docs.langchain.com/oss/javascript/langgraph/overview",
          sourceTitle: secondarySource?.title ?? primarySource?.title ?? "LangGraph JS Docs",
        },
      ],
      estimatedWords: module.estimatedMinutes * 118,
    };
  });

  const codeSnippets = brief.includeCode
    ? [
        {
          id: "snippet-memory-policy",
          title: "Memory Write Policy With Invalidation Guard",
          language: "typescript" as const,
          description: "Prevents stale preference drift by versioning writes and filtering low-signal memories.",
          dependencies: [],
          code: [
            "type MemoryRecord = { key: string; value: string; version: number; confidence: number; updatedAt: number };",
            "type MemoryWrite = { key: string; value: string; confidence: number; signal: 'durable' | 'ephemeral' };",
            "",
            "function applyWrite(store: Map<string, MemoryRecord>, write: MemoryWrite, now = Date.now()): MemoryRecord | null {",
            "  if (write.signal === 'ephemeral' || write.confidence < 0.65) return null;",
            "  const existing = store.get(write.key);",
            "  const next: MemoryRecord = {",
            "    key: write.key,",
            "    value: write.value,",
            "    version: (existing?.version ?? 0) + 1,",
            "    confidence: write.confidence,",
            "    updatedAt: now,",
            "  };",
            "  store.set(write.key, next);",
            "  return next;",
            "}",
            "",
            "const store = new Map<string, MemoryRecord>();",
            "applyWrite(store, { key: 'preferred_language', value: 'typescript', confidence: 0.91, signal: 'durable' });",
            "console.log(store.get('preferred_language')?.version);",
          ].join("\n"),
        },
        {
          id: "snippet-retrieval-eval",
          title: "Retrieval Precision/Recall Probe",
          language: "typescript" as const,
          description: "Measures retrieval quality drift against an expected memory id set.",
          dependencies: [],
          code: [
            "type RetrievalHit = { id: string; score: number };",
            "",
            "function precisionAtK(hits: RetrievalHit[], relevant: Set<string>, k: number): number {",
            "  const top = hits.slice(0, k);",
            "  if (top.length === 0) return 0;",
            "  const match = top.filter((hit) => relevant.has(hit.id)).length;",
            "  return match / top.length;",
            "}",
            "",
            "function recallAtK(hits: RetrievalHit[], relevant: Set<string>, k: number): number {",
            "  if (relevant.size === 0) return 1;",
            "  const topIds = new Set(hits.slice(0, k).map((hit) => hit.id));",
            "  let matched = 0;",
            "  for (const id of relevant) if (topIds.has(id)) matched += 1;",
            "  return matched / relevant.size;",
            "}",
            "",
            "const hits: RetrievalHit[] = [{ id: 'a', score: 0.91 }, { id: 'c', score: 0.77 }, { id: 'b', score: 0.74 }];",
            "const relevant = new Set(['a', 'b']);",
            "console.log({ p2: precisionAtK(hits, relevant, 2), r2: recallAtK(hits, relevant, 2) });",
          ].join("\n"),
        },
        {
          id: "snippet-stage-contract",
          title: "Deterministic Stage Contract",
          language: "typescript" as const,
          description: "Pipeline stage contract with explicit confidence and trace payload.",
          dependencies: [],
          code: [
            "type StageResult<T> = {",
            "  stage: string;",
            "  ok: boolean;",
            "  confidence: number;",
            "  warnings: string[];",
            "  output: T;",
            "};",
            "",
            "function runStage<T>(stage: string, output: T): StageResult<T> {",
            "  return { stage, ok: true, confidence: 0.9, warnings: [], output };",
            "}",
            "",
            "console.log(runStage('planning', { modules: 4 }));",
          ].join("\n"),
        },
      ]
    : [];

  const references = retrieval.sources.map((source) => source.url).slice(0, 6);

  return GenerationOutputSchema.parse({
    scriptSections,
    codeSnippets,
    exercises: brief.includeExercises
      ? plan.modules.slice(0, 3).map((module, index) => ({
          id: `exercise-${index + 1}`,
          title: `${module.title} ${practiceFormats[index % practiceFormats.length]} Exercise`,
          prompt: [
            `Format: ${practiceFormats[index % practiceFormats.length]}.`,
            `Target abstraction: ${index === 0 ? "concrete mechanism" : index === 1 ? "policy + failure mode" : "system + operational trade-off"}.`,
            `Task: apply ${module.title} and justify one design decision for ${brief.targetStack.language}.`,
            `Reinforce prior concept from ${plan.modules[Math.max(0, index - 1)]?.title ?? "module 1"} and surface one likely misconception.`,
          ].join(" "),
          difficulty: index === 0 ? "beginner" : index === 1 ? "intermediate" : "advanced",
          expectedOutcome: `Learner demonstrates ${module.title}, identifies one failure mode, and explains one trade-off with a verification check.`,
        }))
      : [],
    cheatSheet: brief.includeCheatSheet
      ? [
          "Open each module with assumptions and prerequisite check before introducing new terminology.",
          "Use this learner path: concrete example -> mental model -> mechanism -> failure mode -> production constraint -> abstraction.",
          "Escalate depth only after learners explain why the previous abstraction breaks.",
          "Track p95 latency, error rate, and contradiction rate before changing retrieval or memory policy.",
          "During incidents: reproduce -> isolate -> verify fix; do not tune thresholds without recall/precision measurement.",
          "Cite official docs for API/framework claims and tie each claim to one runtime check.",
        ]
      : [],
    references,
    confidence: 0.8,
  });
}
