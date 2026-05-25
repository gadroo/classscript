import type {
  ArtifactPlan,
  AudienceStrategy,
  BriefInput,
  CurriculumPlan,
  GenerationOutput,
  RetrievalArtifact,
  TopicDecomposition,
} from "@curriculum/schemas";

export const commonSystemRules = [
  "You are a curriculum orchestration component.",
  "You must output only deterministic, implementation-ready JSON.",
  "Educational quality is measured by learner comprehension, retention, and transferability, not verbosity, artifact count, or terminology density.",
  "Never emit placeholders, TODO markers, or generic module names.",
  "Use retrieval evidence when technical claims are made.",
  "Every module must include concrete implementation, failure, and debugging artifacts tied to the module objective.",
  "Beginner support must define assumptions and avoid hidden prerequisites.",
  "Advanced sections must include trade-offs, scaling constraints, operational concerns, debugging complexity, architecture implications, observability implications, and cost/latency/reliability trade-offs.",
].join(" ");

export function buildDecompositionPrompt(brief: BriefInput, retrieval: RetrievalArtifact): string {
  return [
    `Topic: ${brief.topic}`,
    `Duration: ${brief.durationMinutes} minutes`,
    `Teaching mode: ${brief.teachingMode}`,
    `Audience: ${brief.audience.beginnerPercent}% beginner / ${brief.audience.advancedPercent}% advanced`,
    `Grounding facts:\n${retrieval.groundedFacts.map((fact) => `- ${fact}`).join("\n")}`,
    "Create an educational concept graph with explicit prerequisite progression.",
  ].join("\n\n");
}

export function buildAudienceStrategyPrompt(brief: BriefInput, decomposition: TopicDecomposition): string {
  return [
    `Topic: ${brief.topic}`,
    `Requested mode: ${brief.teachingMode}`,
    `Audience: ${brief.audience.beginnerPercent}% beginner / ${brief.audience.advancedPercent}% advanced`,
    `Concept count: ${decomposition.concepts.length}`,
    "Select an adaptive pedagogy mode and justify interventions for beginner and advanced learners.",
  ].join("\n\n");
}

export function buildArtifactPlanPrompt(
  brief: BriefInput,
  decomposition: TopicDecomposition,
  audience: AudienceStrategy,
): string {
  return [
    `Topic: ${brief.topic}`,
    `Duration: ${brief.durationMinutes}`,
    `Audience mode: ${audience.mode}`,
    `Instability score: ${audience.instabilityScore}`,
    `Concepts: ${decomposition.concepts.map((concept) => concept.title).join(" | ")}`,
    "Define required artifacts and artifact density targets for this class.",
  ].join("\n\n");
}

export function buildCurriculumPlanPrompt(
  brief: BriefInput,
  decomposition: TopicDecomposition,
  audience: AudienceStrategy,
  artifactPlan: ArtifactPlan,
): string {
  return [
    `Topic: ${brief.topic}`,
    `Duration: ${brief.durationMinutes}`,
    `Audience mode: ${audience.mode}`,
    `Divergence score: ${audience.divergenceScore}`,
    `Concept graph:\n${decomposition.concepts.map((concept) => `- ${concept.id}: ${concept.title} | prereq=${concept.prerequisites.join(",") || "none"}`).join("\n")}`,
    `Artifact rules:\n${artifactPlan.enforcementRules.map((rule) => `- ${rule}`).join("\n")}`,
    `Style notes: ${brief.styleNotes ?? "none"}`,
    "Build a module plan with strict prerequisite ordering and realistic time allocations.",
    "Ensure each module adds one deeper abstraction layer than the prior module (concrete -> policy -> system -> operational).",
    "Required per-module cognitive flow: Prior Knowledge -> New Concept -> Concrete Example -> Guided Reasoning -> Failure Mode -> Practice -> Reflection -> Transition.",
    brief.audience.beginnerPercent > 0
      ? "Because beginner percent is above 0, every module must scaffold: Concrete Example -> Mental Model -> Simplified Mechanism -> Failure Mode -> Production Constraint -> Abstraction."
      : "Beginner-specific scaffold can be minimal because beginner percent is 0.",
    "Use module.beginnerSupport to encode explicit assumptions, hidden-prerequisite checks, and likely confusion points before introducing abstractions.",
    "Use module.advancedExtensions to encode production trade-offs, scaling limits, observability plan, and failure containment choices.",
    "Use pacingNotes to include teaching time, learner processing time, exercise time, debugging time, question overhead, and transition overhead assumptions.",
    "Use warnings to capture self-critique findings: likely confusion points, hidden prerequisites, abstraction jumps, overload risks, and pacing risks.",
    "Avoid repeating the same failure mode, exercise pattern, or transition phrasing across modules unless prerequisite logic requires repetition.",
  ].join("\n\n");
}

export function buildGenerationPrompt(
  brief: BriefInput,
  plan: CurriculumPlan,
  decomposition: TopicDecomposition,
  audience: AudienceStrategy,
  retrieval: RetrievalArtifact,
): string {
  return [
    `Topic: ${brief.topic}`,
    `Duration: ${brief.durationMinutes}`,
    `Audience mode: ${audience.mode}`,
    `Target stack: ${brief.targetStack.language} / ${brief.targetStack.runtime} / ${brief.targetStack.frameworks.join(", ") || "none"}`,
    `Plan modules:\n${plan.modules.map((module) => `- ${module.id}: ${module.title} (${module.estimatedMinutes}m)`).join("\n")}`,
    `Concept checkpoints:\n${decomposition.concepts.map((concept) => `- ${concept.title}: ${concept.learningObjective}`).join("\n")}`,
    `Retrieval grounding:\n${retrieval.groundedFacts.map((fact) => `- ${fact}`).join("\n")}`,
    `Retrieved sources:\n${retrieval.sources.map((source) => `- ${source.title} | ${source.url} | status=${source.status}`).join("\n")}`,
    `Audience split: ${brief.audience.beginnerPercent}% beginner / ${brief.audience.advancedPercent}% advanced`,
    "Generate script sections, runnable code snippets, exercises, cheat sheet, and references grounded in official docs.",
    "For every module, include: cognitiveBridge, abstractionShift, implementationArtifact (with stackApis and acceptanceCriteria), debugScenario, and groundedClaims.",
    "Narration must explicitly include: Prior Knowledge, New Concept, Concrete Example, Guided Reasoning.",
    "Beginner layer must explicitly include: Concrete Example, Mental Model, Simplified Mechanism, Failure Mode, Production Constraint, Abstraction.",
    "Advanced layer must include: trade-offs, scaling constraints, operational concerns, debugging complexity, architecture implications, observability implications, and cost/latency/reliability trade-offs.",
    "Interaction prompts must test the current abstraction layer, reinforce one prior concept, and expose at least one likely misconception.",
    "Transition text must include reflection and a concrete handoff to the next module's prerequisite.",
    "Debug scenarios must vary by module and should not reuse the same symptom/root-cause pair unless justified by dependency.",
    "Exercise formats must vary across modules (e.g., prediction, implementation, diagnosis, critique) to avoid template learning fatigue.",
    "Cheat sheet entries must optimize recall with short operational heuristics that reduce working-memory load during implementation.",
    "Grounded claims must be inline and traceable: each claim must include sourceUrl from retrieved sources.",
    "Debug scenarios must model realistic failures (memory invalidation, summarization corruption, retrieval precision/recall trade-offs, embedding drift, deterministic workflow regressions when relevant).",
    "Do not increase complexity faster than the audience can absorb within the requested duration.",
  ].join("\n\n");
}

export function buildDiagramPrompt(
  brief: BriefInput,
  plan: CurriculumPlan,
  generation: GenerationOutput,
): string {
  const beginnerPercent = brief.audience.beginnerPercent;
  const advancedPercent = brief.audience.advancedPercent;
  const requiredDiagramCount = Math.min(beginnerPercent, advancedPercent) >= 30 ? 2 : 1;
  return [
    `Topic: ${brief.topic}`,
    `Audience split: ${beginnerPercent}% beginner / ${advancedPercent}% advanced`,
    `Module sequence: ${plan.modules.map((module) => module.title).join(" -> ")}`,
    `Existing code snippet count: ${generation.codeSnippets.length}`,
    `Required flowchart count: ${requiredDiagramCount}`,
    "Generate Mermaid flowcharts that model real process flow for this topic (states, decisions, transitions, and outcomes).",
    "Diagrams must be explicitly topic-specific; avoid generic pedagogy-only charts such as 'how to teach/explain'.",
    requiredDiagramCount >= 2
      ? "Because the class is mixed (both beginner and advanced cohorts are substantial), provide two distinct flowcharts: one foundational concept flow and one production/advanced trade-off flow."
      : "Provide one focused flowchart that matches the dominant cohort depth while staying faithful to the topic process.",
  ].join("\n\n");
}

export function buildCriticPrompt(
  brief: BriefInput,
  plan: CurriculumPlan,
  generation: GenerationOutput,
  retrieval: RetrievalArtifact,
): string {
  return [
    `Topic: ${brief.topic}`,
    `Modules: ${plan.modules.length}`,
    `Script sections: ${generation.scriptSections.length}`,
    `References: ${generation.references.join(", ")}`,
    `Grounded sources:\n${retrieval.sources.map((source) => `- ${source.url} (${source.status})`).join("\n")}`,
    "Act as six critics (technical, pedagogical, timing, consistency, diagram, retrieval). Find concrete flaws and suggest fixes.",
    "Flag modules that have shallow advanced sections, missing stack APIs, weak traceability of claims, or unrealistic debugging workflows.",
  ].join("\n\n");
}
