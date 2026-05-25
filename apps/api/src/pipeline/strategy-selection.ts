import {
  GoldenDatasetExampleSchema,
  PedagogicalStrategySelectionSchema,
  type AudienceStrategy,
  type BriefInput,
  type GoldenDatasetExample,
  type PedagogicalStrategySelection,
  type TopicDecomposition,
} from "@curriculum/schemas";
import { averagePrerequisiteDepth } from "./topic-intelligence.js";
import { clampUnit, normalizeTopic, round } from "./utils.js";
import { GOLDEN_PEDAGOGY_DATASET, GOLDEN_PEDAGOGY_DATASET_VERSION } from "./data/golden-pedagogy-dataset.js";

const parsedGoldenDataset: GoldenDatasetExample[] = GOLDEN_PEDAGOGY_DATASET.map((entry) => GoldenDatasetExampleSchema.parse(entry));

interface SelectionSignals {
  topicType: GoldenDatasetExample["topicType"];
  audienceShape: GoldenDatasetExample["audienceShape"];
  teachingStyle: GoldenDatasetExample["teachingStyle"];
  durationBand: GoldenDatasetExample["durationBand"];
  complexityShape: GoldenDatasetExample["complexityShape"];
}

function classifyTopicType(brief: BriefInput): GoldenDatasetExample["topicType"] {
  const topic = normalizeTopic(brief.topic);

  if (/(workflow|pipeline|orchestr|process|lifecycle|state machine)/.test(topic)) {
    return "workflow-heavy";
  }
  if (/(debug|incident|failure|root cause|troubleshoot)/.test(topic)) {
    return "debugging-heavy";
  }
  if (/(infra|kubernetes|deployment|scaling|distributed|architecture)/.test(topic)) {
    return "infrastructure";
  }
  if (/(implement|build|coding|code|api|integration)/.test(topic)) {
    return "implementation-heavy";
  }
  if (/(theory|formal|math|proof|foundation)/.test(topic)) {
    return "theory-heavy";
  }
  if (/(system|design|agent|memory|retrieval|runtime)/.test(topic)) {
    return "systems";
  }
  return "conceptual";
}

function classifyAudienceShape(brief: BriefInput, audience: AudienceStrategy): GoldenDatasetExample["audienceShape"] {
  const beginner = brief.audience.beginnerPercent;
  const advanced = brief.audience.advancedPercent;

  if (beginner >= 70) {
    return "beginner-dominant";
  }
  if (advanced >= 70) {
    return "advanced-dominant";
  }
  if (Math.abs(beginner - advanced) <= 12 && audience.instabilityScore >= 0.68) {
    return "unstable-divergence";
  }
  return "balanced-mixed";
}

function classifyTeachingStyle(brief: BriefInput): GoldenDatasetExample["teachingStyle"] {
  if (brief.teachingMode === "segmented") {
    return "workshop";
  }
  if (brief.durationMinutes >= 150) {
    return "bootcamp";
  }
  if (brief.includeExercises && brief.durationMinutes >= 75) {
    return "workshop";
  }
  if (brief.audience.advancedPercent >= 70) {
    return "architecture-review";
  }
  return "lecture";
}

function classifyDurationBand(durationMinutes: number): GoldenDatasetExample["durationBand"] {
  if (durationMinutes <= 45) {
    return "30m";
  }
  if (durationMinutes <= 75) {
    return "60m";
  }
  if (durationMinutes <= 105) {
    return "90m";
  }
  if (durationMinutes <= 165) {
    return "120m";
  }
  if (durationMinutes <= 240) {
    return "180m";
  }
  return "multi-session";
}

function classifyComplexityShape(decomposition: TopicDecomposition): GoldenDatasetExample["complexityShape"] {
  const avgDifficulty = decomposition.concepts.reduce((sum, concept) => sum + concept.difficulty, 0) / decomposition.concepts.length;
  const prereqDepth = averagePrerequisiteDepth(decomposition.concepts.map((concept) => ({
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
  })));

  if (prereqDepth >= 1.15) {
    return "prerequisite-heavy";
  }
  if (avgDifficulty >= 0.68) {
    return "steep-progression";
  }
  return "smooth-progression";
}

function durationBandDistance(a: GoldenDatasetExample["durationBand"], b: GoldenDatasetExample["durationBand"]): number {
  const order: GoldenDatasetExample["durationBand"][] = ["30m", "60m", "90m", "120m", "180m", "multi-session"];
  return Math.abs(order.indexOf(a) - order.indexOf(b));
}

function scoreExample(example: GoldenDatasetExample, signals: SelectionSignals): number {
  const weights = {
    topicType: 0.3,
    audienceShape: 0.23,
    teachingStyle: 0.16,
    durationBand: 0.16,
    complexityShape: 0.15,
  };

  let score = 0;

  score += example.topicType === signals.topicType ? weights.topicType : 0;
  score += example.audienceShape === signals.audienceShape
    ? weights.audienceShape
    : ((example.audienceShape === "unstable-divergence" && signals.audienceShape === "balanced-mixed")
      || (example.audienceShape === "balanced-mixed" && signals.audienceShape === "unstable-divergence"))
      ? weights.audienceShape * 0.45
      : 0;

  score += example.teachingStyle === signals.teachingStyle ? weights.teachingStyle : 0;

  const distance = durationBandDistance(example.durationBand, signals.durationBand);
  score += Math.max(0, weights.durationBand - distance * 0.05);

  score += example.complexityShape === signals.complexityShape
    ? weights.complexityShape
    : (example.complexityShape === "prerequisite-heavy" && signals.complexityShape === "steep-progression")
      || (example.complexityShape === "steep-progression" && signals.complexityShape === "prerequisite-heavy")
      ? weights.complexityShape * 0.5
      : 0;

  return clampUnit(score);
}

function weightedMode(topMatches: Array<{ example: GoldenDatasetExample; score: number }>): AudienceStrategy["mode"] {
  const totals = new Map<AudienceStrategy["mode"], number>([
    ["beginner-dominant", 0],
    ["advanced-dominant", 0],
    ["balanced-layered", 0],
    ["segmented", 0],
  ]);

  for (const match of topMatches) {
    totals.set(match.example.recommendedMode, (totals.get(match.example.recommendedMode) ?? 0) + match.score);
  }

  let best: AudienceStrategy["mode"] = "balanced-layered";
  let bestScore = -1;
  for (const [mode, total] of totals.entries()) {
    if (total > bestScore) {
      best = mode;
      bestScore = total;
    }
  }
  return best;
}

function blendDensity(topMatches: Array<{ example: GoldenDatasetExample; score: number }>, key: keyof GoldenDatasetExample["targetDensities"]): number {
  const weightSum = topMatches.reduce((sum, match) => sum + match.score, 0);
  if (weightSum <= 0) {
    return 0;
  }
  const weighted = topMatches.reduce((sum, match) => sum + match.example.targetDensities[key] * match.score, 0);
  return clampUnit(weighted / weightSum);
}

export function listGoldenDatasetExamples(): GoldenDatasetExample[] {
  return parsedGoldenDataset.slice();
}

export function selectPedagogicalStrategy(
  brief: BriefInput,
  decomposition: TopicDecomposition,
  audience: AudienceStrategy,
): PedagogicalStrategySelection {
  const signals: SelectionSignals = {
    topicType: classifyTopicType(brief),
    audienceShape: classifyAudienceShape(brief, audience),
    teachingStyle: classifyTeachingStyle(brief),
    durationBand: classifyDurationBand(brief.durationMinutes),
    complexityShape: classifyComplexityShape(decomposition),
  };

  const ranked = parsedGoldenDataset
    .map((example) => ({ example, score: scoreExample(example, signals) }))
    .sort((left, right) => right.score - left.score || left.example.id.localeCompare(right.example.id));

  const topMatches = ranked.slice(0, 3);
  const selectedExampleIds = topMatches.map((match) => match.example.id);
  const recommendedMode = weightedMode(topMatches);

  const confidence = clampUnit(
    (topMatches[0]?.score ?? 0) * 0.7
      + (topMatches[1]?.score ?? 0) * 0.2
      + (topMatches[2]?.score ?? 0) * 0.1,
  );

  const strategy = PedagogicalStrategySelectionSchema.parse({
    datasetVersion: GOLDEN_PEDAGOGY_DATASET_VERSION,
    selectedExampleIds,
    topicType: signals.topicType,
    audienceShape: signals.audienceShape,
    teachingStyle: signals.teachingStyle,
    durationBand: signals.durationBand,
    complexityShape: signals.complexityShape,
    recommendedMode,
    targetDensities: {
      code: round(blendDensity(topMatches, "code"), 3),
      diagram: round(blendDensity(topMatches, "diagram"), 3),
      exercise: round(blendDensity(topMatches, "exercise"), 3),
      interaction: round(blendDensity(topMatches, "interaction"), 3),
      explanation: round(blendDensity(topMatches, "explanation"), 3),
    },
    rationale: `Strategy selected from ${topMatches.length} nearest golden examples: ${selectedExampleIds.join(", ")}.`,
    confidence,
    scoreBreakdown: {
      bestMatch: topMatches[0]?.score ?? 0,
      secondMatch: topMatches[1]?.score ?? 0,
      thirdMatch: topMatches[2]?.score ?? 0,
    },
    warnings: confidence < 0.62
      ? ["Low confidence strategy match; manual strategy review is recommended."]
      : [],
  });

  return strategy;
}
