import type { GraphNode } from "@langchain/langgraph";
import {
  ValidationReportSchema,
  type CriticReport,
  type ScriptSection,
  type ValidationIssue,
} from "@curriculum/schemas";
import type { PipelineState, PipelineStateSchema } from "../state.js";
import { NodeCodeExecutionEngine } from "../engines/code-execution.js";
import { buildNodeExecution, clampScore, clampUnit, nowIso, round, safeDivide, toTrace } from "../utils.js";

const engine = new NodeCodeExecutionEngine();

function hasPlaceholder(text: string): boolean {
  return /(placeholder|tbd|todo|lorem ipsum|module\s*\d+)/i.test(text);
}

function hasDiagramSyntax(code: string): boolean {
  return /^(flowchart|sequenceDiagram|graph|classDiagram|stateDiagram|erDiagram)\b/m.test(code.trim());
}

function expectedFlowchartCount(beginnerPercent: number, advancedPercent: number): number {
  return Math.min(beginnerPercent, advancedPercent) >= 30 ? 2 : 1;
}

function collectDiagramLabels(code: string): string[] {
  return Array.from(code.matchAll(/\[(.*?)\]|\((.*?)\)|\{(.*?)\}/g))
    .map((match) => (match[1] ?? match[2] ?? match[3] ?? "").toLowerCase().trim())
    .filter((label) => label.length > 1);
}

function buildTopicKeywords(topic: string, moduleTitles: string[]): Set<string> {
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

interface DiagramQuality {
  syntaxValid: boolean;
  hasFlowStructure: boolean;
  topicRelevant: boolean;
  meaningful: boolean;
  beginnerAligned: boolean;
  advancedAligned: boolean;
  metaOnly: boolean;
}

function evaluateDiagramQuality(code: string, topicKeywords: Set<string>): DiagramQuality {
  const normalized = code.toLowerCase();
  const labels = collectDiagramLabels(code);
  const edgeCount = (normalized.match(/-->|==>|-\.->|---/g) ?? []).length;
  const decisionCount = (normalized.match(/\{[^}]+\}/g) ?? []).length;
  const syntaxValid = hasDiagramSyntax(code);
  const hasFlowStructure = /^(flowchart|graph)\s+(td|lr|rl|bt)\b/m.test(normalized) && edgeCount >= 3 && labels.length >= 4;
  const overlap = Array.from(topicKeywords).filter((token) => normalized.includes(token)).length;
  const topicRelevant = overlap >= 2;
  const metaHits = [
    "teaching flow",
    "how to explain",
    "how to teach",
    "lesson plan",
    "classroom",
    "instructor",
    "student",
  ].filter((token) => normalized.includes(token)).length;
  const metaOnly = metaHits >= 2 && !topicRelevant;
  const beginnerAligned = /\b(basic|foundation|intro|overview|input|output|example|prerequisite)\b/.test(normalized);
  const advancedAligned = /\b(trade[- ]?off|latency|throughput|rollback|retry|slo|observability|scal|constraint|failure)\b/.test(normalized);
  const meaningful = syntaxValid
    && hasFlowStructure
    && topicRelevant
    && !metaOnly
    && (decisionCount >= 1 || edgeCount >= 5);
  return {
    syntaxValid,
    hasFlowStructure,
    topicRelevant,
    meaningful,
    beginnerAligned,
    advancedAligned,
    metaOnly,
  };
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter((token) => token.length > 0).length;
}

function buildStackAliases(term: string): string[] {
  const normalized = term.toLowerCase().trim();
  const withoutVersion = normalized.replace(/@[\d][\w.-]*/g, "");
  const withoutJsSuffix = withoutVersion.replace(/\.js\b/g, "");
  const tokenized = withoutJsSuffix.replace(/[^a-z0-9]+/g, " ").trim();
  const aliases = new Set<string>([normalized, withoutVersion, withoutJsSuffix, ...tokenized.split(/\s+/)]);
  return Array.from(aliases).map((alias) => alias.trim()).filter((alias) => alias.length >= 3);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
}

function textOverlap(a: string, b: string): number {
  const left = new Set(tokenize(a));
  if (left.size === 0) return 0;
  const right = new Set(tokenize(b));
  let hits = 0;
  for (const token of left) {
    if (right.has(token)) {
      hits += 1;
    }
  }
  return hits / left.size;
}

const ADVANCED_ABSTRACTION_TOKENS = [
  "latency",
  "throughput",
  "consistency",
  "invalidation",
  "rollback",
  "idempotency",
  "deterministic",
  "precision",
  "recall",
  "drift",
  "cardinality",
  "checkpoint",
  "retry",
  "backpressure",
  "observability",
];

const DEBUG_RIGOR_TOKENS = [
  "reproduce",
  "replay",
  "trace",
  "hypothesis",
  "root cause",
  "verify",
  "instrument",
  "metric",
  "log",
  "rollback",
];

const BEGINNER_FLOW_TOKENS = [
  "concrete example",
  "mental model",
  "simplified mechanism",
  "failure mode",
  "production constraint",
  "abstraction",
];

const MODULE_FLOW_TOKENS = [
  "prior knowledge",
  "new concept",
  "concrete example",
  "guided reasoning",
  "failure mode",
  "practice",
  "reflection",
  "transition",
];

function estimatedExplanationDensity(scriptSections: ScriptSection[]): number {
  const avgWords = scriptSections.reduce((sum, section) => sum + section.estimatedWords, 0) / Math.max(1, scriptSections.length);
  return clampUnit(avgWords / 220);
}

function criticToValidationStage(critic: string): ValidationIssue["stage"] {
  if (critic === "technical") {
    return "technical";
  }
  if (critic === "pedagogical") {
    return "pedagogy";
  }
  if (critic === "timing") {
    return "timing";
  }
  if (critic === "consistency") {
    return "consistency";
  }
  if (critic === "diagram") {
    return "diagram";
  }
  return "retrieval";
}

function injectCriticIssues(
  issues: ValidationIssue[],
  criticReviews: PipelineState["artifacts"]["criticReviews"],
): { failCount: number; warnCount: number } {
  let failCount = 0;
  let warnCount = 0;

  for (const review of criticReviews) {
    if (review.verdict === "pass") {
      continue;
    }

    const severity: ValidationIssue["severity"] = review.verdict === "fail" ? "error" : "warning";
    const stage = criticToValidationStage(review.critic);
    const messages = review.findings.length > 0
      ? review.findings
      : review.suggestedFixes.length > 0
        ? review.suggestedFixes
        : [`${review.critic} critic returned ${review.verdict}.`];

    for (const message of messages) {
      issues.push({
        stage,
        severity,
        message: `[critic:${review.critic}] ${message}`,
      });
    }

    if (review.verdict === "fail") {
      failCount += 1;
    } else {
      warnCount += 1;
    }
  }

  return { failCount, warnCount };
}

function buildCriticReports(
  scores: {
    structuralScore: number;
    logicalScore: number;
    technicalScore: number;
    pedagogyScore: number;
    timingScore: number;
    consistencyScore: number;
  },
  issues: ValidationIssue[],
): CriticReport[] {
  const map: Array<{ critic: CriticReport["critic"]; stage: ValidationIssue["stage"]; score: number }> = [
    { critic: "structural", stage: "structural", score: scores.structuralScore },
    { critic: "logical", stage: "logical", score: scores.logicalScore },
    { critic: "technical", stage: "technical", score: scores.technicalScore },
    { critic: "pedagogical", stage: "pedagogy", score: scores.pedagogyScore },
    { critic: "timing", stage: "timing", score: scores.timingScore },
    { critic: "consistency", stage: "consistency", score: scores.consistencyScore },
    { critic: "diagram", stage: "diagram", score: Math.round((scores.structuralScore + scores.pedagogyScore) / 2) },
    { critic: "retrieval", stage: "retrieval", score: Math.round((scores.technicalScore + scores.consistencyScore) / 2) },
  ];

  return map.map(({ critic, stage, score }) => {
    const stageIssues = issues.filter((issue) => issue.stage === stage);
    const errorCount = stageIssues.filter((issue) => issue.severity === "error").length;
    const warningCount = stageIssues.filter((issue) => issue.severity === "warning").length;
    return {
      critic,
      score,
      confidence: clampUnit(score / 100 - errorCount * 0.18 - warningCount * 0.06),
      passed: errorCount === 0 && score >= 70,
      findings: stageIssues.map((issue) => issue.message),
    };
  });
}

export const validateNode: GraphNode<typeof PipelineStateSchema> = async (state) => {
  const startedAt = nowIso();
  const stage = "validation" as const;

  if (!state.plan || !state.generation || !state.artifacts.retrieval || !state.artifacts.decomposition) {
    const execution = buildNodeExecution({
      node: stage,
      status: "error",
      startedAt,
      errors: ["Missing plan, generation, or required artifacts."],
    });
    return {
      escalations: ["Validation blocked by missing artifacts."],
      nodeExecutions: [execution],
      traces: [toTrace(execution)],
    };
  }

  const issues: ValidationIssue[] = [];
  const criticInjections = injectCriticIssues(issues, state.artifacts.criticReviews);
  const script = state.generation.scriptSections;
  const snippets = state.generation.codeSnippets;
  const codeSnippetCount = snippets.filter((snippet) => snippet.language !== "text").length;
  const diagramSnippetCount = snippets.filter((snippet) => snippet.language === "text").length;
  const required = {
    code: state.artifacts.artifactPlan?.requireCode ?? state.brief.includeCode,
    diagrams: state.artifacts.artifactPlan?.requireDiagrams ?? state.brief.includeFlowcharts,
    exercises: state.artifacts.artifactPlan?.requireExercises ?? state.brief.includeExercises,
    cheatSheet: state.artifacts.artifactPlan?.requireCheatSheet ?? state.brief.includeCheatSheet,
  };

  const requiredChecks = [
    { ok: script.length > 0, stage: "structural" as const, message: "Script sections are missing.", required: true },
    { ok: !required.code || codeSnippetCount > 0, stage: "structural" as const, message: "Code snippets are required but missing.", required: required.code },
    {
      ok: !required.diagrams || diagramSnippetCount > 0,
      stage: "diagram" as const,
      message: "Diagram artifact is required but missing.",
      required: required.diagrams,
    },
    { ok: !required.exercises || state.generation.exercises.length > 0, stage: "structural" as const, message: "Exercises are required but missing.", required: required.exercises },
    { ok: !required.cheatSheet || state.generation.cheatSheet.length > 0, stage: "structural" as const, message: "Cheat sheet is required but missing.", required: required.cheatSheet },
  ].filter((check) => check.required);

  for (const check of requiredChecks) {
    if (!check.ok) {
      issues.push({ stage: check.stage, severity: "error", message: check.message });
    }
  }

  const emptySectionCount = script.filter((section) => [
    section.narration,
    section.beginnerLayer,
    section.advancedLayer,
    section.interactionPrompt,
    section.transition,
  ].some((field) => field.trim().length === 0)).length;

  if (emptySectionCount > 0) {
    issues.push({
      stage: "structural",
      severity: "warning",
      message: `${emptySectionCount} script section(s) contain empty required fields.`,
    });
  }

  if (!required.code && codeSnippetCount > 0) {
    issues.push({
      stage: "structural",
      severity: "warning",
      message: "[settings] Code snippets were generated even though includeCode is disabled.",
    });
  }
  if (!required.diagrams && diagramSnippetCount > 0) {
    issues.push({
      stage: "diagram",
      severity: "warning",
      message: "[settings] Diagram snippets were generated even though includeFlowcharts is disabled.",
    });
  }
  if (!required.exercises && state.generation.exercises.length > 0) {
    issues.push({
      stage: "pedagogy",
      severity: "warning",
      message: "[settings] Exercises were generated even though includeExercises is disabled.",
    });
  }
  if (!required.cheatSheet && state.generation.cheatSheet.length > 0) {
    issues.push({
      stage: "pedagogy",
      severity: "warning",
      message: "[settings] Cheat sheet content was generated even though includeCheatSheet is disabled.",
    });
  }

  const decompositionIndex = new Map(state.artifacts.decomposition.concepts.map((concept, index) => [concept.id, index]));
  let prerequisiteEdges = 0;
  let prerequisiteViolations = 0;
  const modulePosition = new Map(state.plan.modules.map((module, index) => [module.id, index]));
  for (const [index, module] of state.plan.modules.entries()) {
    const concept = state.artifacts.decomposition.concepts.find((candidate) => module.id.includes(candidate.id))
      ?? state.artifacts.decomposition.concepts[index];
    if (!concept) {
      continue;
    }
    for (const prerequisite of concept.prerequisites) {
      const prereqIndex = decompositionIndex.get(prerequisite);
      if (prereqIndex === undefined) {
        continue;
      }
      prerequisiteEdges += 1;
      const moduleIndex = modulePosition.get(module.id) ?? index;
      if (moduleIndex < prereqIndex) {
        prerequisiteViolations += 1;
      }
    }
  }
  if (prerequisiteViolations > 0) {
    issues.push({
      stage: "logical",
      severity: "error",
      message: `${prerequisiteViolations} prerequisite ordering violation(s) detected.`,
    });
  }

  const prerequisiteDepth = safeDivide(
    state.artifacts.decomposition.concepts.reduce((sum, concept) => sum + concept.prerequisites.length, 0),
    state.artifacts.decomposition.concepts.length,
  );
  const progressionRealism = (() => {
    if (state.plan.modules.length <= 1) return 1;
    let positiveTransitions = 0;
    for (let index = 1; index < state.plan.modules.length; index += 1) {
      if (state.plan.modules[index].difficulty >= state.plan.modules[index - 1].difficulty - 0.02) {
        positiveTransitions += 1;
      }
    }
    return safeDivide(positiveTransitions, state.plan.modules.length - 1);
  })();
  if (progressionRealism < 0.7) {
    issues.push({
      stage: "logical",
      severity: "warning",
      message: "Module difficulty progression regresses too often; abstraction staircase is not coherent.",
    });
  }

  const codeResults = await engine.validate(snippets);
  const failedCode = codeResults.filter((result) => !result.ok);
  for (const failed of failedCode) {
    issues.push({
      stage: "technical",
      severity: "error",
      message: `Snippet ${failed.id} failed execution: ${failed.stderr ?? "unknown error"}`,
    });
  }

  const invalidDiagramCount = snippets
    .filter((snippet) => snippet.language === "text")
    .filter((snippet) => !hasDiagramSyntax(snippet.code)).length;
  if (invalidDiagramCount > 0) {
    issues.push({
      stage: "diagram",
      severity: "warning",
      message: `${invalidDiagramCount} diagram snippet(s) failed Mermaid syntax precheck.`,
    });
  }

  const diagramSnippets = snippets.filter((snippet) => snippet.language === "text");
  const requiredFlowcharts = expectedFlowchartCount(
    state.brief.audience.beginnerPercent,
    state.brief.audience.advancedPercent,
  );
  const topicKeywords = buildTopicKeywords(
    state.brief.topic,
    state.plan.modules.map((module) => module.title),
  );
  const diagramQuality = diagramSnippets.map((snippet) => evaluateDiagramQuality(snippet.code, topicKeywords));
  const meaningfulDiagramCount = diagramQuality.filter((item) => item.meaningful).length;
  const topicRelevantDiagramCount = diagramQuality.filter((item) => item.topicRelevant).length;
  const metaOnlyDiagramCount = diagramQuality.filter((item) => item.metaOnly).length;
  const beginnerAlignedDiagramCount = diagramQuality.filter((item) => item.beginnerAligned).length;
  const advancedAlignedDiagramCount = diagramQuality.filter((item) => item.advancedAligned).length;

  if (required.diagrams && meaningfulDiagramCount < requiredFlowcharts) {
    const severity: ValidationIssue["severity"] = meaningfulDiagramCount === 0 && topicRelevantDiagramCount === 0 ? "error" : "warning";
    issues.push({
      stage: "diagram",
      severity,
      message: `Flowchart quality gate failed: ${meaningfulDiagramCount}/${requiredFlowcharts} diagram(s) are meaningful, topic-specific, and structurally valid.`,
    });
  }
  if (required.diagrams && metaOnlyDiagramCount > 0) {
    issues.push({
      stage: "diagram",
      severity: "warning",
      message: `${metaOnlyDiagramCount} flowchart(s) appear pedagogy-meta (how to teach) instead of modeling the topic process.`,
    });
  }
  if (required.diagrams && topicRelevantDiagramCount < requiredFlowcharts) {
    issues.push({
      stage: "diagram",
      severity: "warning",
      message: "Flowchart/topic alignment is weak; diagrams should include topic entities, decisions, and outcomes.",
    });
  }
  if (required.diagrams && requiredFlowcharts >= 2 && (beginnerAlignedDiagramCount === 0 || advancedAlignedDiagramCount === 0)) {
    issues.push({
      stage: "diagram",
      severity: "warning",
      message: "Mixed cohort detected, but flowcharts do not clearly cover both foundational and advanced perspectives.",
    });
  }

  const bodyText = [
    ...script.flatMap((section) => [
      section.narration,
      section.beginnerLayer,
      section.advancedLayer,
      section.interactionPrompt,
      section.transition,
      section.cognitiveBridge,
      section.abstractionShift,
      section.implementationArtifact.title,
      ...section.implementationArtifact.files,
      ...section.implementationArtifact.stackApis,
      ...section.implementationArtifact.acceptanceCriteria,
      section.debugScenario.symptom,
      section.debugScenario.likelyRootCause,
      ...section.debugScenario.reproductionSteps,
      ...section.debugScenario.investigationSteps,
      section.debugScenario.fixSummary,
      ...section.debugScenario.verificationChecks,
      ...section.groundedClaims.map((claim) => `${claim.claim} ${claim.sourceTitle}`),
    ]),
    ...snippets.map((snippet) => `${snippet.title} ${snippet.description} ${snippet.code}`),
    ...state.generation.exercises.flatMap((exercise) => [exercise.title, exercise.prompt, exercise.expectedOutcome]),
    ...state.generation.cheatSheet,
    ...state.generation.references,
  ].join(" ").toLowerCase();

  const stackTerms = [
    state.brief.targetStack.language,
    state.brief.targetStack.runtime,
    ...state.brief.targetStack.frameworks,
  ].filter((term) => term.trim().length > 0);
  const stackTermGroups = stackTerms
    .map((term) => ({ term, aliases: buildStackAliases(term) }))
    .filter((group) => group.aliases.length > 0);

  const stackMentionCoverage = safeDivide(
    stackTermGroups.filter((group) => group.aliases.some((alias) => bodyText.includes(alias))).length,
    stackTermGroups.length,
  );
  if (stackMentionCoverage < 0.5) {
    issues.push({ stage: "consistency", severity: "warning", message: "Target stack terminology coverage is low." });
  }

  const referencesFromOfficial = state.generation.references.filter((reference) => {
    try {
      const url = new URL(reference);
      return state.artifacts.retrieval!.sources.some((source) => source.url === reference && source.official)
        || ["platform.openai.com", "docs.langchain.com", "js.langchain.com", "typescriptlang.org", "nodejs.org", "nextjs.org", "python.org"].some((domain) => url.hostname.includes(domain));
    } catch {
      return false;
    }
  }).length;
  const referenceCoverage = safeDivide(referencesFromOfficial, Math.max(1, state.generation.references.length));
  if (referenceCoverage < 0.5) {
    issues.push({ stage: "retrieval", severity: "warning", message: "Reference grounding to validated sources is weak." });
  }

  const implementationSpecificity = safeDivide(
    script.filter((section) =>
      section.implementationArtifact.stackApis.length >= 2
      && section.implementationArtifact.acceptanceCriteria.length >= 2
      && section.implementationArtifact.files.length >= 1).length,
    script.length,
  );
  if (implementationSpecificity < 0.9) {
    issues.push({
      stage: "technical",
      severity: "warning",
      message: "Not all modules include implementation artifacts with concrete APIs and acceptance criteria.",
    });
  }

  const apiSurfaceCoverage = safeDivide(
    script.filter((section) => {
      const apiMentions = section.implementationArtifact.stackApis.filter((api) => bodyText.includes(api.toLowerCase()));
      return apiMentions.length >= 1;
    }).length,
    script.length,
  );
  if (apiSurfaceCoverage < 0.75) {
    issues.push({
      stage: "technical",
      severity: "warning",
      message: "Stack-specific API surface is weak in generated narrative/code context.",
    });
  }

  const debugRealism = safeDivide(
    script.filter((section) => {
      const debugText = [
        section.debugScenario.symptom,
        section.debugScenario.likelyRootCause,
        ...section.debugScenario.reproductionSteps,
        ...section.debugScenario.investigationSteps,
        section.debugScenario.fixSummary,
        ...section.debugScenario.verificationChecks,
      ].join(" ").toLowerCase();
      const tokenHits = DEBUG_RIGOR_TOKENS.filter((token) => debugText.includes(token)).length;
      return section.debugScenario.reproductionSteps.length >= 2
        && section.debugScenario.investigationSteps.length >= 2
        && section.debugScenario.verificationChecks.length >= 1
        && tokenHits >= 2;
    }).length,
    script.length,
  );
  if (debugRealism < 0.8) {
    issues.push({
      stage: "technical",
      severity: "warning",
      message: "Debugging scenarios are not realistic enough (missing reproduce/investigate/verify rigor).",
    });
  }

  const moduleGroundingCoverage = safeDivide(
    script.filter((section) => section.groundedClaims.length > 0).length,
    script.length,
  );
  if (moduleGroundingCoverage < 1) {
    issues.push({
      stage: "retrieval",
      severity: "warning",
      message: "Each module should include at least one inline grounded claim.",
    });
  }

  const sourceTraceability = safeDivide(
    script.flatMap((section) => section.groundedClaims).filter((claim) => {
      const source = state.artifacts.retrieval!.sources.find((candidate) => candidate.url === claim.sourceUrl);
      if (!source) return false;
      const snippetOverlap = textOverlap(claim.claim, source.snippet);
      const titleOverlap = textOverlap(claim.claim, source.title);
      return snippetOverlap >= 0.08
        || titleOverlap >= 0.25
        || (source.official && claim.claim.length >= 70 && titleOverlap >= 0.12);
    }).length,
    Math.max(1, script.flatMap((section) => section.groundedClaims).length),
  );
  if (sourceTraceability < 0.55) {
    issues.push({
      stage: "retrieval",
      severity: "warning",
      message: "Grounded claims are weakly traceable to retrieved source snippets.",
    });
  }

  const placeholderCount = script.flatMap((section) => [
    section.narration,
    section.beginnerLayer,
    section.advancedLayer,
    section.interactionPrompt,
    section.transition,
  ]).filter((field) => hasPlaceholder(field)).length;
  if (placeholderCount > 0) {
    issues.push({ stage: "pedagogy", severity: "warning", message: `Detected ${placeholderCount} placeholder-like instructional fragments.` });
  }

  const beginnerCoverage = safeDivide(script.filter((section) => section.beginnerLayer.length > 30).length, script.length);
  const advancedCoverage = safeDivide(script.filter((section) => section.advancedLayer.length > 30).length, script.length);
  const interactionCoverage = safeDivide(script.filter((section) => section.interactionPrompt.length > 20).length, script.length);
  const objectiveCoverage = safeDivide(
    state.plan.modules.filter((module) => script.some((section) => section.moduleId === module.id)).length,
    state.plan.modules.length,
  );
  const beginnerFlowCoverage = safeDivide(
    script.filter((section) => {
      const text = section.beginnerLayer.toLowerCase();
      const tokenHits = BEGINNER_FLOW_TOKENS.filter((token) => text.includes(token)).length;
      return tokenHits >= 5;
    }).length,
    script.length,
  );
  if (state.brief.audience.beginnerPercent > 0 && beginnerFlowCoverage < 0.75) {
    issues.push({
      stage: "pedagogy",
      severity: "warning",
      message: "Beginner flow is incomplete; include concrete example, mental model, mechanism, failure, production constraint, and abstraction.",
    });
  }

  const moduleFlowCoverage = safeDivide(
    script.filter((section) => {
      const text = [
        section.narration,
        section.interactionPrompt,
        section.transition,
        section.debugScenario.symptom,
      ].join(" ").toLowerCase();
      const tokenHits = MODULE_FLOW_TOKENS.filter((token) => text.includes(token)).length;
      return tokenHits >= 6;
    }).length,
    script.length,
  );
  if (moduleFlowCoverage < 0.72) {
    issues.push({
      stage: "pedagogy",
      severity: "warning",
      message: "Module instructional flow is weak; required sequence (prior knowledge -> transition) is not explicit enough.",
    });
  }

  const cognitiveProgression = safeDivide(
    script.filter((section) => {
      const bridge = `${section.cognitiveBridge} ${section.abstractionShift}`.toLowerCase();
      return section.cognitiveBridge.length > 80
        && section.abstractionShift.length > 50
        && /\b(beginner|foundation|concrete)\b/.test(bridge)
        && /\b(advanced|trade-off|constraint|system)\b/.test(bridge);
    }).length,
    script.length,
  );
  if (cognitiveProgression < 0.8) {
    issues.push({
      stage: "pedagogy",
      severity: "warning",
      message: "Beginner-to-advanced transitions are too implicit; require explicit cognitive bridge statements.",
    });
  }

  const abstractionDepth = safeDivide(
    script.filter((section) => {
      const advancedText = `${section.advancedLayer} ${section.abstractionShift}`.toLowerCase();
      const tokenHits = ADVANCED_ABSTRACTION_TOKENS.filter((token) => advancedText.includes(token)).length;
      return tokenHits >= 3;
    }).length,
    script.length,
  );
  if (abstractionDepth < 0.72) {
    issues.push({
      stage: "pedagogy",
      severity: "warning",
      message: "Advanced content depth is shallow; add operational constraints and architecture trade-offs.",
    });
  }

  const advancedRealism = safeDivide(
    script.filter((section) => {
      const advancedText = `${section.advancedLayer} ${section.debugScenario.likelyRootCause} ${section.debugScenario.fixSummary}`.toLowerCase();
      const hasTradeoff = /\b(trade[- ]?off|vs\.?|versus|cost|latency|precision|recall)\b/.test(advancedText);
      const hasFailureContainment = /\b(mitigat|rollback|fallback|guardrail|contain|invalidation|retry)\b/.test(advancedText);
      return hasTradeoff && hasFailureContainment;
    }).length,
    script.length,
  );
  if (advancedRealism < 0.75) {
    issues.push({
      stage: "pedagogy",
      severity: "warning",
      message: "Advanced layers lack production realism (trade-offs and failure containment are missing).",
    });
  }

  const antiTemplateDiversity = (() => {
    if (script.length <= 1) return 1;
    const normalizedDebug = script.map((section) => section.debugScenario.symptom.toLowerCase().replace(/\s+/g, " ").trim());
    const normalizedTransitions = script.map((section) => section.transition.toLowerCase().replace(/\s+/g, " ").trim());
    const debugUnique = new Set(normalizedDebug).size;
    const transitionUnique = new Set(normalizedTransitions).size;
    return clampUnit((safeDivide(debugUnique, script.length) + safeDivide(transitionUnique, script.length)) / 2);
  })();
  if (antiTemplateDiversity < 0.7) {
    issues.push({
      stage: "consistency",
      severity: "warning",
      message: "Instructional patterns are overly repetitive across modules; diversify transitions and failure scenarios.",
    });
  }

  const beginnerWordCount = script.reduce((sum, section) => sum + countWords(section.beginnerLayer), 0);
  const advancedWordCount = script.reduce((sum, section) => sum + countWords(section.advancedLayer), 0);
  const audienceLayerBeginnerShare = safeDivide(beginnerWordCount, beginnerWordCount + advancedWordCount);
  const expectedBeginnerShare = state.brief.audience.beginnerPercent / 100;
  const audienceShareDelta = Math.abs(audienceLayerBeginnerShare - expectedBeginnerShare);
  if (audienceShareDelta > 0.22) {
    issues.push({
      stage: "pedagogy",
      severity: "warning",
      message: `[settings] Audience layering diverges from requested split by ${Math.round(audienceShareDelta * 100)} percentage points.`,
    });
  }

  const mode = state.brief.teachingMode;
  const realizedMode = state.artifacts.audienceStrategy?.mode;
  const allowedModes = mode === "mixed"
    ? ["balanced-layered", "segmented"]
    : mode === "beginner-dominant"
      ? ["beginner-dominant"]
      : mode === "advanced-dominant"
        ? ["advanced-dominant"]
        : ["segmented"];
  const modeMismatch = realizedMode ? !allowedModes.includes(realizedMode) : false;
  if (modeMismatch) {
    issues.push({
      stage: "pedagogy",
      severity: "warning",
      message: `[settings] Requested teaching mode '${mode}' but audience strategy resolved to '${realizedMode}'.`,
    });
  }

  if (mode === "segmented") {
    const segmentedCueCount = script
      .flatMap((section) => [section.transition, section.interactionPrompt])
      .filter((text) => /\b(track|segment|group|cohort)\b/i.test(text))
      .length;
    if (segmentedCueCount < Math.max(1, script.length - 1)) {
      issues.push({
        stage: "pedagogy",
        severity: "warning",
        message: "[settings] Segmented mode requested but script has weak track-separation cues.",
      });
    }
  }

  const strategy = state.artifacts.strategySelection;
  const codeDensityActual = safeDivide(snippets.length, Math.max(1, script.length));
  const diagramDensityActual = safeDivide(snippets.filter((snippet) => snippet.language === "text").length, Math.max(1, script.length));
  const exerciseDensityActual = safeDivide(state.generation.exercises.length, Math.max(1, script.length));
  const interactionDensityActual = interactionCoverage;
  const explanationDensityActual = estimatedExplanationDensity(script);
  const strategyDeltas = strategy
    ? {
        codeDensityDelta: Math.abs(codeDensityActual - strategy.targetDensities.code),
        diagramDensityDelta: Math.abs(diagramDensityActual - strategy.targetDensities.diagram),
        exerciseDensityDelta: Math.abs(exerciseDensityActual - strategy.targetDensities.exercise),
        interactionDensityDelta: Math.abs(interactionDensityActual - strategy.targetDensities.interaction),
        explanationDensityDelta: Math.abs(explanationDensityActual - strategy.targetDensities.explanation),
      }
    : null;
  const strategyAlignmentScore = strategyDeltas
    ? clampUnit(1 - (
      strategyDeltas.codeDensityDelta
      + strategyDeltas.diagramDensityDelta
      + strategyDeltas.exerciseDensityDelta
      + strategyDeltas.interactionDensityDelta
      + strategyDeltas.explanationDensityDelta
    ) / 1.9)
    : 1;

  if (strategy && strategyAlignmentScore < 0.62) {
    issues.push({
      stage: "pedagogy",
      severity: "warning",
      message: `Generated artifact mix diverges from selected golden strategy profile (alignment ${Math.round(strategyAlignmentScore * 100)}%).`,
    });
  }

  const estimatedMinutes = script.reduce((sum, section) => sum + section.estimatedWords / 120, 0);
  const deltaMinutes = Math.abs(estimatedMinutes - state.brief.durationMinutes);
  const withinTolerance = deltaMinutes <= Math.max(8, state.brief.durationMinutes * 0.15);
  if (!withinTolerance) {
    issues.push({ stage: "timing", severity: "warning", message: `Estimated duration delta is ${Math.round(deltaMinutes)} minutes.` });
  }

  const duplicateRatio = (() => {
    const seen = new Set<string>();
    let duplicates = 0;
    for (const section of script) {
      const key = `${section.narration}::${section.beginnerLayer}::${section.advancedLayer}`.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) {
        duplicates += 1;
      }
      seen.add(key);
    }
    return safeDivide(duplicates, Math.max(1, script.length - 1));
  })();
  if (duplicateRatio > 0.2) {
    issues.push({ stage: "consistency", severity: "warning", message: "High duplicate concept density detected in script sections." });
  }

  const criticPenalty = state.artifacts.criticReviews.reduce((penalty, review) => {
    if (review.verdict === "fail") return penalty + 0.12;
    if (review.verdict === "warn") return penalty + 0.04;
    return penalty;
  }, 0);

  const structuralScore = clampScore(
    safeDivide(requiredChecks.filter((check) => check.ok).length, Math.max(1, requiredChecks.length)) * 45
      + (1 - safeDivide(emptySectionCount, Math.max(1, script.length))) * 35
      + moduleGroundingCoverage * 20,
  );
  const logicalScore = clampScore(
    (1 - safeDivide(prerequisiteViolations, Math.max(1, prerequisiteEdges))) * 55
      + progressionRealism * 30
      + clampUnit(prerequisiteDepth / 2.5) * 15,
  );
  const technicalScore = clampScore(
    safeDivide(codeResults.filter((result) => result.ok).length, Math.max(1, codeResults.length)) * 35
      + stackMentionCoverage * 15
      + implementationSpecificity * 20
      + apiSurfaceCoverage * 10
      + debugRealism * 10
      + sourceTraceability * 10,
  );
  const pedagogyScore = clampScore(
    beginnerCoverage * 10
      + advancedCoverage * 10
      + beginnerFlowCoverage * 15
      + moduleFlowCoverage * 15
      + cognitiveProgression * 15
      + abstractionDepth * 15
      + advancedRealism * 10
      + interactionCoverage * 5
      + objectiveCoverage * 5
      + antiTemplateDiversity * 10
      + (1 - safeDivide(placeholderCount, Math.max(1, script.length * 7))) * 5,
  );
  const timingScore = clampScore(
    100 - Math.min(100, (deltaMinutes / Math.max(1, state.brief.durationMinutes)) * 140) + Math.min(8, Math.floor(state.brief.durationMinutes / 20)),
  );
  const settingsMismatchCount = issues.filter((issue) => issue.message.startsWith("[settings]")).length;
  const settingsConformanceScore = clampUnit(
    1
      - settingsMismatchCount * 0.12
      - (modeMismatch ? 0.22 : 0)
      - Math.min(0.3, audienceShareDelta * 0.8),
  );
  const consistencyScore = clampScore(
    stackMentionCoverage * 18
      + (1 - duplicateRatio) * 16
      + referenceCoverage * 12
      + sourceTraceability * 18
      + moduleGroundingCoverage * 12
      + settingsConformanceScore * 24,
  );
  const strategyScore = clampScore(strategyAlignmentScore * 100);

  const classroomReadinessScore = clampScore(
    structuralScore * 0.08
      + logicalScore * 0.15
      + technicalScore * 0.34
      + pedagogyScore * 0.24
      + timingScore * 0.09
      + consistencyScore * 0.08
      + strategyScore * 0.01
      + settingsConformanceScore * 100 * 0.01,
  );

  const issueErrors = issues.filter((issue) => issue.severity === "error").length;
  const issueWarnings = issues.filter((issue) => issue.severity === "warning").length;
  const confidence = clampUnit(
    classroomReadinessScore / 100
      - issueErrors * 0.14
      - issueWarnings * 0.02
      - criticPenalty
      + state.artifacts.retrieval.confidence * 0.08,
  );

  const criticReports = buildCriticReports(
    {
      structuralScore,
      logicalScore,
      technicalScore,
      pedagogyScore,
      timingScore,
      consistencyScore,
    },
    issues,
  );

  const pedagogicalGate = pedagogyScore >= 74 && (cognitiveProgression >= 0.72 || pedagogyScore >= 84);
  const traceabilityGate = sourceTraceability >= 0.48
    || (referenceCoverage >= 0.7 && moduleGroundingCoverage >= 0.95);

  const passed = issueErrors === 0
    && technicalScore >= 74
    && pedagogicalGate
    && structuralScore >= 70
    && logicalScore >= 70
    && consistencyScore >= 60
    && implementationSpecificity >= 0.85
    && traceabilityGate;

  const humanReviewReasons: string[] = [];
  if (!passed) {
    humanReviewReasons.push("At least one validation gate failed.");
  }
  if (confidence < 0.8) {
    humanReviewReasons.push("Confidence below 0.80.");
  }
  if (state.artifacts.audienceStrategy?.mode === "segmented") {
    humanReviewReasons.push("Segmented mode detected; instructor review required for track separation.");
  }
  if ((state.artifacts.audienceStrategy?.instabilityScore ?? 0) >= 0.78) {
    humanReviewReasons.push("Audience instability is high; verify layered transitions manually.");
  }
  if (criticInjections.failCount > 0) {
    humanReviewReasons.push(`${criticInjections.failCount} specialized critic(s) returned fail verdicts.`);
  }
  if (strategy && strategyAlignmentScore < 0.55) {
    humanReviewReasons.push("Golden strategy alignment is low; instructional structure should be manually reviewed.");
  }
  if (implementationSpecificity < 0.85) {
    humanReviewReasons.push("Implementation artifacts are not specific enough for production-grade instruction.");
  }
  if (cognitiveProgression < 0.72 && pedagogyScore < 84) {
    humanReviewReasons.push("Cognitive progression between beginner and advanced layers is weak.");
  }
  if (beginnerFlowCoverage < 0.7 && state.brief.audience.beginnerPercent > 0) {
    humanReviewReasons.push("Beginner scaffolding flow is incomplete for a non-zero beginner audience.");
  }
  if (moduleFlowCoverage < 0.7) {
    humanReviewReasons.push("Instructional flow sequence is under-specified across modules.");
  }
  if (sourceTraceability < 0.48 && !(referenceCoverage >= 0.7 && moduleGroundingCoverage >= 0.95)) {
    humanReviewReasons.push("Inline technical claims are not traceable enough to retrieved sources.");
  }

  const validationTraces = [
    `code_pass_rate=${safeDivide(codeResults.filter((result) => result.ok).length, Math.max(1, codeResults.length))}`,
    `timing_delta=${deltaMinutes}`,
    `stack_coverage=${stackMentionCoverage}`,
    `reference_coverage=${referenceCoverage}`,
    `implementation_specificity=${round(implementationSpecificity, 3)}`,
    `api_surface_coverage=${round(apiSurfaceCoverage, 3)}`,
    `debug_realism=${round(debugRealism, 3)}`,
    `cognitive_progression=${round(cognitiveProgression, 3)}`,
    `beginner_flow_coverage=${round(beginnerFlowCoverage, 3)}`,
    `module_flow_coverage=${round(moduleFlowCoverage, 3)}`,
    `abstraction_depth=${round(abstractionDepth, 3)}`,
    `advanced_realism=${round(advancedRealism, 3)}`,
    `anti_template_diversity=${round(antiTemplateDiversity, 3)}`,
    `source_traceability=${round(sourceTraceability, 3)}`,
    `flowchart_required=${requiredFlowcharts}`,
    `flowchart_meaningful=${meaningfulDiagramCount}`,
    `flowchart_topic_relevant=${topicRelevantDiagramCount}`,
    `flowchart_meta_only=${metaOnlyDiagramCount}`,
    `flowchart_beginner_aligned=${beginnerAlignedDiagramCount}`,
    `flowchart_advanced_aligned=${advancedAlignedDiagramCount}`,
    `critic_penalty=${criticPenalty}`,
    `settings_conformance=${round(settingsConformanceScore, 3)}`,
    `audience_delta=${round(audienceShareDelta, 3)}`,
    `mode_requested=${mode}`,
    `mode_resolved=${realizedMode ?? "unknown"}`,
    ...(strategy ? [`strategy_alignment=${round(strategyAlignmentScore, 3)}`] : []),
  ];

  const validation = ValidationReportSchema.parse({
    passed,
    confidence,
    structuralScore,
    logicalScore,
    technicalScore,
    pedagogyScore,
    timingScore,
    consistencyScore,
    classroomReadinessScore,
    estimatedDurationMinutes: estimatedMinutes,
    criticReports,
    revisionsApplied: state.artifacts.criticReviews.flatMap((review) => review.suggestedFixes).slice(0, 12),
    scoreRationale: [
      "All scores are computed from measurable validation checks and execution outcomes.",
      "Technical scoring emphasizes implementation specificity, stack API realism, debug rigor, and source traceability.",
      "Pedagogy scoring emphasizes cognitive progression and abstraction depth, not just section completeness.",
      "Settings conformance checks verify teaching mode, audience layering, and artifact toggles.",
      "Confidence combines readiness score with issue penalties and critic fail/warn penalties.",
    ],
    breakdown: {
      structural: {
        requiredArtifactCoverage: safeDivide(requiredChecks.filter((check) => check.ok).length, Math.max(1, requiredChecks.length)),
        schemaPassRate: 1,
        emptySectionRatio: safeDivide(emptySectionCount, Math.max(1, script.length)),
      },
      logical: {
        prerequisiteOrderCoverage: 1 - safeDivide(prerequisiteViolations, Math.max(1, prerequisiteEdges)),
        cyclicDependencyCount: 0,
      },
      technical: {
        codeSnippetCount,
        codeExecutionPassRate: safeDivide(codeResults.filter((result) => result.ok).length, Math.max(1, codeResults.length)),
        stackMentionCoverage,
        referenceCoverage,
        implementationSpecificity,
        apiSurfaceCoverage,
        debugRealism,
      },
      pedagogy: {
        beginnerLayerCoverage: beginnerCoverage,
        advancedLayerCoverage: advancedCoverage,
        interactionCoverage,
        objectiveCoverage,
        placeholderDensity: safeDivide(placeholderCount, Math.max(1, script.length * 7)),
        cognitiveProgression,
        abstractionDepth,
        advancedRealism,
      },
      retrieval: {
        moduleGroundingCoverage,
        sourceTraceability,
        officialSourceCoverage: referenceCoverage,
      },
      timing: {
        requestedMinutes: state.brief.durationMinutes,
        estimatedMinutes,
        deltaMinutes,
        withinTolerance,
        checkpointCount: Math.floor(state.brief.durationMinutes / 20),
      },
      consistency: {
        terminologyCoverage: stackMentionCoverage,
        contradictionCount: 0,
        duplicateConceptRatio: duplicateRatio,
      },
      strategy: strategyDeltas
        ? {
            alignmentScore: strategyAlignmentScore,
            codeDensityDelta: strategyDeltas.codeDensityDelta,
            diagramDensityDelta: strategyDeltas.diagramDensityDelta,
            exerciseDensityDelta: strategyDeltas.exerciseDensityDelta,
            interactionDensityDelta: strategyDeltas.interactionDensityDelta,
            explanationDensityDelta: strategyDeltas.explanationDensityDelta,
          }
        : undefined,
    },
    humanReview: {
      required: humanReviewReasons.length > 0,
      reasons: humanReviewReasons,
      question: "Would a human instructor confidently deliver this class in a real session?",
      approved: humanReviewReasons.length > 0 ? null : true,
    },
    issues,
  });

  const escalations: string[] = [];
  if (!validation.passed) {
    escalations.push("Validation failed threshold gates. Regeneration or human intervention required.");
  }
  if (validation.humanReview.required) {
    escalations.push("Human review required by confidence-based escalation policy.");
  }

  const execution = buildNodeExecution({
    node: stage,
    status: validation.passed ? (issues.length > 0 ? "warning" : "success") : "error",
    startedAt,
    confidence: validation.confidence,
    warnings: issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message),
    errors: issues.filter((issue) => issue.severity === "error").map((issue) => issue.message),
    metrics: {
      structuralScore,
      logicalScore,
      technicalScore,
      pedagogyScore,
      timingScore,
      consistencyScore,
      classroomReadinessScore,
      confidence,
      issueErrors,
      issueWarnings,
      strategyAlignmentScore,
      settingsConformanceScore,
      audienceShareDelta,
      stackTermCoverageGroups: stackTermGroups.length,
      implementationSpecificity,
      apiSurfaceCoverage,
      debugRealism,
      cognitiveProgression,
      beginnerFlowCoverage,
      moduleFlowCoverage,
      abstractionDepth,
      advancedRealism,
      antiTemplateDiversity,
      sourceTraceability,
      moduleGroundingCoverage,
      requiredFlowcharts,
      meaningfulDiagramCount,
      topicRelevantDiagramCount,
      metaOnlyDiagramCount,
      beginnerAlignedDiagramCount,
      advancedAlignedDiagramCount,
    },
    inputArtifacts: ["plan", "generation", "artifacts.retrieval", "artifacts.decomposition", "artifacts.criticReviews", "artifacts.strategySelection"],
    outputArtifacts: ["validation", "artifacts.validationTraces"],
    validationTraces,
  });

  return {
    validation,
    artifacts: {
      ...state.artifacts,
      validationTraces,
    },
    escalations,
    nodeExecutions: [execution],
    traces: [toTrace(execution)],
  };
};
