import { commonSystemRules } from "@curriculum/prompts";
import {
  InstructorPreviewEvaluationSchema,
  type InstructorPreviewEvaluationNarrative,
  type BriefInput,
  type EvaluationMismatch,
  type EvaluationUnitScore,
  type InclusionCoverageItem,
  type InstructorPreview,
  type InstructorPreviewEvaluation,
  type ReliabilityLevel,
} from "@curriculum/schemas";
import { z } from "zod";
import { generateStructuredObject } from "./llm/client.js";
import { clampScore, clampUnit, nowIso, round, safeDivide } from "./utils.js";

const RISKY_ADVANCED_TOKENS = [
  "trade-off",
  "latency",
  "throughput",
  "eventual consistency",
  "deterministic",
  "invalidation",
  "rollback",
  "backpressure",
  "cardinality",
  "precision",
  "recall",
  "instrumentation",
];

const BEGINNER_TOKENS = [
  "basics",
  "introduction",
  "foundation",
  "intuition",
  "simple",
  "step-by-step",
  "start with",
  "analogy",
];

const JudgeDimensionSchema = z.object({
  abstractionLevel: z.number().min(0).max(1),
  prerequisiteKnowledge: z.number().min(0).max(1),
  pacingComplexity: z.number().min(0).max(1),
  terminologyDensity: z.number().min(0).max(1),
  technicalDepth: z.number().min(0).max(1),
  instructionalScaffolding: z.number().min(0).max(1),
});

const JudgeEvidenceSchema = z.object({
  quote: z.string().min(1),
  sectionTitle: z.string().optional(),
});

const JudgeUnitAssessmentSchema = z.object({
  unitId: z.string(),
  beginnerAffinity: z.number().min(0).max(1),
  advancedAffinity: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  dimensionScores: JudgeDimensionSchema,
  evidence: z.array(JudgeEvidenceSchema).min(1).max(3),
});

const JudgeInclusionAssessmentSchema = z.object({
  key: z.enum(["includeCode", "includeFlowcharts", "includeExercises", "includeCheatSheet"]),
  integrated: z.boolean(),
  appropriateForAudienceMix: z.boolean(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(JudgeEvidenceSchema).default([]),
});

const JudgeMismatchHintSchema = z.object({
  severity: z.enum(["info", "warning", "error"]),
  category: z.enum(["cohort", "pacing", "inclusion", "evidence", "confidence"]),
  reason: z.string(),
  unitId: z.string().optional(),
  violatedDimensions: z.array(JudgeDimensionSchema.keyof()).default([]),
  evidence: z.array(JudgeEvidenceSchema).min(1).max(3),
  confidence: z.number().min(0).max(1),
});

const JudgeAuditSchema = z.object({
  unitAssessments: z.array(JudgeUnitAssessmentSchema),
  inclusionAssessments: z.array(JudgeInclusionAssessmentSchema).default([]),
  mismatchHints: z.array(JudgeMismatchHintSchema).default([]),
  notes: z.array(z.string()).default([]),
});

type UnitType = "paragraph" | "section" | "example" | "exercise" | "explanation";

interface PreviewUnit {
  unitId: string;
  unitType: UnitType;
  text: string;
  sectionTitle?: string;
  wordCount: number;
}

function wordCount(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0).length;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function asQuote(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}

function inferUnitType(sectionTitle: string | undefined, block: string): UnitType {
  const title = (sectionTitle ?? "").toLowerCase();
  const text = block.toLowerCase();
  if (/exercise|lab|challenge|practice/.test(title) || /^exercise[:\s]/.test(text)) {
    return "exercise";
  }
  if (/example|walkthrough|demo/.test(title) || /\bfor example\b|\be\.g\./.test(text)) {
    return "example";
  }
  if (/explain|intuition|concept/.test(title) || /\bwhy\b|\bintuition\b/.test(text)) {
    return "explanation";
  }
  if (title.length > 0 && block.length < 170) {
    return "section";
  }
  return "paragraph";
}

function parsePreviewUnits(markdown: string): PreviewUnit[] {
  const units: PreviewUnit[] = [];
  const lines = markdown.split("\n");
  let currentSection = "";
  let paragraph: string[] = [];
  let inCodeFence = false;
  let codeFenceLang = "";
  let codeFenceBuffer: string[] = [];

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    paragraph = [];
    if (text.length < 30) {
      return;
    }
    const unitType = inferUnitType(currentSection || undefined, text);
    units.push({
      unitId: `unit_${units.length + 1}`,
      unitType,
      text,
      sectionTitle: currentSection || undefined,
      wordCount: wordCount(text),
    });
  };

  const flushCodeFence = () => {
    if (codeFenceBuffer.length === 0) {
      return;
    }
    const text = codeFenceBuffer.join("\n").trim();
    codeFenceBuffer = [];
    if (!text) {
      return;
    }
    const normalizedLang = codeFenceLang.toLowerCase();
    const unitType: UnitType = normalizedLang.includes("mermaid") ? "example" : "explanation";
    units.push({
      unitId: `unit_${units.length + 1}`,
      unitType,
      text: `\`\`\`${codeFenceLang}\n${text}\n\`\`\``,
      sectionTitle: currentSection || undefined,
      wordCount: Math.max(8, Math.round(text.length / 12)),
    });
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith("```")) {
      if (inCodeFence) {
        flushCodeFence();
        inCodeFence = false;
        codeFenceLang = "";
      } else {
        flushParagraph();
        inCodeFence = true;
        codeFenceLang = line.replace(/```/, "").trim();
      }
      continue;
    }
    if (inCodeFence) {
      codeFenceBuffer.push(line);
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      flushParagraph();
      currentSection = line.replace(/^#{1,6}\s+/, "").trim();
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }
    paragraph.push(line.trim());
  }

  flushParagraph();
  if (inCodeFence) {
    flushCodeFence();
  }

  if (units.length === 0) {
    const fallbackText = markdown.trim();
    return [{
      unitId: "unit_1",
      unitType: "paragraph",
      text: fallbackText,
      sectionTitle: undefined,
      wordCount: Math.max(1, wordCount(fallbackText)),
    }];
  }

  return units;
}

function evidenceExists(quote: string, source: string): boolean {
  const q = normalize(quote);
  if (!q) {
    return false;
  }
  const s = normalize(source);
  return s.includes(q);
}

function fallbackUnitScore(unit: PreviewUnit): EvaluationUnitScore {
  const text = unit.text.toLowerCase();
  const beginnerHits = BEGINNER_TOKENS.filter((token) => text.includes(token)).length;
  const advancedHits = RISKY_ADVANCED_TOKENS.filter((token) => text.includes(token)).length;
  const denominator = Math.max(1, beginnerHits + advancedHits);
  const beginnerAffinity = clampUnit((beginnerHits + 1) / (denominator + 2));
  const advancedAffinity = clampUnit((advancedHits + 1) / (denominator + 2));
  const terminologyDensity = clampUnit((text.match(/\b[a-z]{9,}\b/g)?.length ?? 0) / 18);
  const technicalDepth = clampUnit(advancedHits / 8 + (text.includes("```") ? 0.18 : 0));
  const instructionalScaffolding = clampUnit((beginnerHits / 6) + (/\b(step|first|next|then)\b/.test(text) ? 0.24 : 0));
  return {
    unitId: unit.unitId,
    unitType: unit.unitType,
    text: unit.text,
    dimensionScores: {
      abstractionLevel: clampUnit((advancedAffinity + terminologyDensity) / 2),
      prerequisiteKnowledge: clampUnit((advancedAffinity + technicalDepth) / 2),
      pacingComplexity: clampUnit((terminologyDensity + technicalDepth) / 2),
      terminologyDensity,
      technicalDepth,
      instructionalScaffolding,
    },
    beginnerAffinity,
    advancedAffinity,
    confidence: clampUnit(
      0.62
      + (beginnerHits + advancedHits > 0 ? 0.08 : 0)
      + (unit.wordCount >= 45 ? 0.05 : 0),
    ),
    evidence: [{ quote: asQuote(unit.text), sectionTitle: unit.sectionTitle }],
  };
}

function inclusionPresence(key: InclusionCoverageItem["key"], markdown: string): boolean {
  if (key === "includeCode") {
    return /```(typescript|javascript|js|python|bash|json)?/i.test(markdown);
  }
  if (key === "includeFlowcharts") {
    return /```mermaid|flowchart|sequenceDiagram|graph\s+(TD|LR|RL|BT)\b/i.test(markdown);
  }
  if (key === "includeExercises") {
    return /\bexercise\b|\bchallenge\b|\bpractice\b|\blab\b/i.test(markdown);
  }
  return /\bcheat sheet\b|\bquick reference\b|\bkey takeaways\b/i.test(markdown);
}

function inferInclusionIntegration(
  key: InclusionCoverageItem["key"],
  markdown: string,
  moduleSlices: ModuleSlice[],
  exerciseFormats: string[],
): boolean {
  const scriptBody = extractSectionContent(markdown, "Script") || markdown;
  if (key === "includeCode") {
    return /```(typescript|javascript|js|python|bash|json)?/i.test(markdown)
      && /\b(api|implementation artifact|files:|acceptance|deterministic)\b/i.test(scriptBody);
  }
  if (key === "includeFlowcharts") {
    return /```mermaid|flowchart|sequenceDiagram|graph\s+(TD|LR|RL|BT)\b/i.test(markdown)
      && /\b(flow|diagram|lifecycle|architecture|request path)\b/i.test(scriptBody);
  }
  if (key === "includeExercises") {
    return exerciseFormats.length > 0
      && /\binteraction|practice|prediction|implementation|diagnosis|critique\b/i.test(scriptBody);
  }
  const cheatSheetBody = extractSectionContent(markdown, "Cheat Sheet");
  const cheatSheetLines = cheatSheetBody
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "No cheat sheet requested.");
  return cheatSheetLines.length >= 2
    && (/\brecap|check|during incidents|track|cite\b/i.test(cheatSheetBody) || moduleSlices.length > 0);
}

function validateEvidence(
  evidence: Array<{ quote: string; sectionTitle?: string }>,
  source: string,
): Array<{ quote: string; sectionTitle?: string }> {
  return evidence.filter((item) => evidenceExists(item.quote, source)).slice(0, 3);
}

function ensureNonEmptyQuote(quote: string, fallback: string): string {
  const trimmed = quote.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function ensureEvidenceList(
  evidence: Array<{ quote: string; sectionTitle?: string }>,
  fallbackQuote: string,
  fallbackSectionTitle?: string,
): Array<{ quote: string; sectionTitle?: string }> {
  const normalized = evidence
    .map((item) => ({
      quote: ensureNonEmptyQuote(item.quote, fallbackQuote),
      sectionTitle: item.sectionTitle?.trim() ? item.sectionTitle : fallbackSectionTitle,
    }))
    .filter((item) => item.quote.trim().length > 0);
  if (normalized.length > 0) {
    return normalized.slice(0, 3);
  }
  return [{ quote: fallbackQuote, sectionTitle: fallbackSectionTitle }];
}

function avg(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function toReliabilityLevel(params: {
  confidence: number;
  mismatchCount: number;
  errorCount: number;
  uncertain: boolean;
}): ReliabilityLevel {
  if (params.uncertain || params.errorCount >= 2 || params.confidence < 0.56) {
    return "LOW";
  }
  if (params.mismatchCount >= 4 || params.confidence < 0.74) {
    return "MEDIUM";
  }
  return "HIGH";
}

function toDurationRange(estimateMinutes: number): string {
  const center = Math.max(1, Math.round(estimateMinutes / 5) * 5);
  const spread = Math.max(10, Math.round(center * 0.15 / 5) * 5);
  const lower = Math.max(5, center - spread);
  const upper = center + spread;
  return `about ${lower}-${upper} minutes`;
}

function findSectionCount(markdown: string): number {
  return markdown.split("\n").filter((line) => /^#{1,6}\s+/.test(line)).length;
}

function hasDiscussionPrompt(text: string): boolean {
  return /\bdiscuss|question|pair|reflect|prompt|debate\b/i.test(text);
}

function evaluateTolerance(targetBeginnerPercent: number): number {
  const balanceProximity = 1 - Math.abs(targetBeginnerPercent - 50) / 50;
  return Math.round(6 + balanceProximity * 6);
}

function fingerprint(text: string): string {
  return normalize(text)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 5)
    .slice(0, 12)
    .join(" ");
}

type StructuralPatternKind = "debugging-flow" | "cognitive-bridge" | "remediation-logic" | "exercise-format" | "transition-pattern";

interface ModuleSlice {
  index: number;
  title: string;
  beginnerLayer: string;
  advancedLayer: string;
  cognitiveBridge: string;
  abstractionShift: string;
  interaction: string;
  transition: string;
  implementationArtifact: string;
  debugScenario: string;
  remediationLogic: string;
  fullText: string;
}

interface StructuralPatternGroupResult {
  kind: StructuralPatternKind;
  ratio: number;
  strongestSimilarity: number;
}

interface StructuralLeakageResult {
  leakageIndex: number;
  groups: StructuralPatternGroupResult[];
  repeatedQuotes: string[];
}

interface SequencingResult {
  preparationRatio: number;
  realisticJumpRatio: number;
  prerequisiteTransferRatio: number;
  unsafeCompoundingRatio: number;
  riskyModules: string[];
}

interface ModuleDepthProfile {
  moduleIndex: number;
  depthScore: number;
  deeplyExplored: boolean;
  mentionOnly: boolean;
}

interface PedagogicalTrajectoryResult {
  progressionQuality: number;
  retentionSupport: number;
  misconceptionManagement: number;
  abstractionPacing: number;
  fatigueRisk: number;
  overloadRisk: number;
}

interface ReconciledEvaluationState {
  status: InstructorPreviewEvaluation["status"];
  passed: boolean;
  reliability: ReliabilityLevel;
  confidence: number;
  contradictions: string[];
  adjustments: string[];
}

const STRUCTURAL_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "if", "when", "then", "than", "to", "for", "from", "with", "without",
  "by", "at", "on", "in", "of", "is", "are", "was", "were", "be", "been", "being", "it", "this", "that",
  "these", "those", "as", "into", "about", "over", "under", "between", "through", "after", "before", "while",
  "during", "we", "you", "they", "your", "our", "their", "can", "could", "should", "must", "will", "would",
  "may", "might", "also", "not",
]);

function extractBoldSection(block: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`\\*\\*${escaped}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\*\\*[^\\n]+\\*\\*|$)`, "i"));
  return match?.[1]?.trim() ?? "";
}

function extractSectionContent(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markdownHeading = markdown.match(new RegExp(`##\\s+${escaped}\\s+([\\s\\S]*?)(?=\\n##\\s+[^\\n]+|$)`, "i"));
  if (markdownHeading?.[1]) {
    return markdownHeading[1].trim();
  }
  const plainHeading = markdown.match(
    new RegExp(`(?:^|\\n)${escaped}\\s*\\n([\\s\\S]*?)(?=\\n(?:[A-Z][A-Za-z ]{2,}|##\\s+[^\\n]+)\\s*\\n|$)`, "i"),
  );
  return plainHeading?.[1]?.trim() ?? "";
}

function extractLabeledSection(body: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = "(?=\\n\\s*(?:[-*]\\s*)?(?:\\*\\*)?(?:Beginner layer|Advanced layer|Cognitive bridge|Abstraction shift|Interaction|Transition|Implementation artifact|Debug scenario)\\s*:?(?:\\*\\*)?\\s*|$)";
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*\\*\\*${escaped}:\\*\\*\\s*([\\s\\S]*?)${boundary}`, "i"),
    new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?${escaped}:\\s*([\\s\\S]*?)${boundary}`, "i"),
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return "";
}

function parseModuleSlices(markdown: string): ModuleSlice[] {
  const scriptBody = extractSectionContent(markdown, "Script") || markdown;
  const modules: ModuleSlice[] = [];
  const moduleRegex = /^(?:###\s+)?(\d+)\.\s+(.+)\n([\s\S]*?)(?=^(?:###\s+)?\d+\.\s+.+$|\n##\s+[^#\n]+|$)/gm;
  for (const match of scriptBody.matchAll(moduleRegex)) {
    const index = Number.parseInt(match[1] ?? "0", 10);
    if (!Number.isFinite(index) || index <= 0) {
      continue;
    }
    const title = (match[2] ?? "").trim();
    const body = (match[3] ?? "").trim();
    const beginnerLayer = extractLabeledSection(body, "Beginner layer") || extractBoldSection(body, "Beginner layer");
    const advancedLayer = extractLabeledSection(body, "Advanced layer") || extractBoldSection(body, "Advanced layer");
    const cognitiveBridge = extractLabeledSection(body, "Cognitive bridge") || extractBoldSection(body, "Cognitive bridge");
    const abstractionShift = extractLabeledSection(body, "Abstraction shift") || extractBoldSection(body, "Abstraction shift");
    const interaction = extractLabeledSection(body, "Interaction") || extractBoldSection(body, "Interaction");
    const transition = extractLabeledSection(body, "Transition") || extractBoldSection(body, "Transition");
    const implementationArtifact = extractLabeledSection(body, "Implementation artifact") || extractBoldSection(body, "Implementation artifact");
    const debugScenario = extractLabeledSection(body, "Debug scenario") || extractBoldSection(body, "Debug scenario");
    const remediationLogic = [
      ...debugScenario.split("\n").filter((line) => /fix:|verify:|mitigat|rollback|contain/i.test(line)),
      abstractionShift,
    ].join(" ").trim();
    modules.push({
      index: index - 1,
      title,
      beginnerLayer,
      advancedLayer,
      cognitiveBridge,
      abstractionShift,
      interaction,
      transition,
      implementationArtifact,
      debugScenario,
      remediationLogic,
      fullText: body,
    });
  }
  return modules.sort((a, b) => a.index - b.index);
}

function parseExerciseFormats(markdown: string): string[] {
  const section = extractSectionContent(markdown, "Exercises");
  if (!section) {
    return [];
  }
  const bulletLines = section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^-\s+/.test(line))
    .map((line) => line.replace(/^-\s+/, ""));
  if (bulletLines.length > 0) {
    return bulletLines;
  }
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 20 && /\bexercise|practice|challenge|task\b/i.test(line));
}

function expectedFlowchartCount(beginnerPercent: number, advancedPercent: number): number {
  return Math.min(beginnerPercent, advancedPercent) >= 30 ? 2 : 1;
}

function collectFlowchartBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const mermaidBlocks = markdown.matchAll(/```mermaid\s*([\s\S]*?)```/gi);
  for (const match of mermaidBlocks) {
    const body = (match[1] ?? "").trim();
    if (/^(flowchart|graph)\s+(TD|LR|RL|BT)\b/im.test(body)) {
      blocks.push(body);
    }
  }
  return blocks;
}

function collectTopicTokens(topic: string, moduleTitles: string[]): Set<string> {
  const tokens = new Set<string>(
    normalize(topic)
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3),
  );
  for (const title of moduleTitles) {
    const titleTokens = normalize(title)
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3);
    for (const token of titleTokens) {
      tokens.add(token);
    }
  }
  return tokens;
}

interface FlowchartQualitySummary {
  total: number;
  meaningful: number;
  topicRelevant: number;
  metaOnly: number;
  beginnerAligned: number;
  advancedAligned: number;
}

function summarizeFlowchartQuality(markdown: string, topicTokens: Set<string>): FlowchartQualitySummary {
  const blocks = collectFlowchartBlocks(markdown);
  let meaningful = 0;
  let topicRelevant = 0;
  let metaOnly = 0;
  let beginnerAligned = 0;
  let advancedAligned = 0;

  for (const block of blocks) {
    const normalized = block.toLowerCase();
    const labels = Array.from(block.matchAll(/\[(.*?)\]|\((.*?)\)|\{(.*?)\}/g))
      .map((match) => (match[1] ?? match[2] ?? match[3] ?? "").toLowerCase().trim())
      .filter((label) => label.length > 1);
    const edgeCount = (normalized.match(/-->|==>|-\.->|---/g) ?? []).length;
    const decisionCount = (normalized.match(/\{[^}]+\}/g) ?? []).length;
    const overlap = Array.from(topicTokens).filter((token) => normalized.includes(token)).length;
    const relevant = overlap >= 2;
    if (relevant) {
      topicRelevant += 1;
    }
    const metaHits = [
      "teaching flow",
      "how to explain",
      "how to teach",
      "lesson plan",
      "classroom",
      "instructor",
      "student",
    ].filter((token) => normalized.includes(token)).length;
    const looksMetaOnly = metaHits >= 2 && !relevant;
    if (looksMetaOnly) {
      metaOnly += 1;
    }
    const hasFlowStructure = edgeCount >= 3 && labels.length >= 4;
    if (hasFlowStructure && relevant && !looksMetaOnly && (decisionCount >= 1 || edgeCount >= 5)) {
      meaningful += 1;
    }
    if (/\b(basic|foundation|intro|overview|input|output|example|prerequisite)\b/.test(normalized)) {
      beginnerAligned += 1;
    }
    if (/\b(trade[- ]?off|latency|throughput|rollback|retry|slo|observability|scal|constraint|failure)\b/.test(normalized)) {
      advancedAligned += 1;
    }
  }

  return {
    total: blocks.length,
    meaningful,
    topicRelevant,
    metaOnly,
    beginnerAligned,
    advancedAligned,
  };
}

function structuralTokens(text: string): string[] {
  return normalize(text)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      if (/^\d+$/.test(token)) return "<num>";
      if (STRUCTURAL_STOPWORDS.has(token)) return token;
      if (token.length <= 3) return "<short>";
      if (token.endsWith("ing")) return "<ing>";
      if (token.endsWith("ed")) return "<past>";
      if (token.length >= 10) return "<long>";
      return "<term>";
    });
}

function buildNgrams(tokens: string[], n = 3): Set<string> {
  const grams = new Set<string>();
  if (tokens.length === 0) return grams;
  if (tokens.length < n) {
    grams.add(tokens.join(" "));
    return grams;
  }
  for (let index = 0; index <= tokens.length - n; index += 1) {
    grams.add(tokens.slice(index, index + n).join(" "));
  }
  return grams;
}

function sentenceShape(text: string): Set<string> {
  const shapes = new Set<string>();
  const sentences = text.split(/[.!?]\s+/).map((sentence) => sentence.trim()).filter(Boolean);
  for (const sentence of sentences) {
    const tokenCount = sentence.split(/\s+/).filter(Boolean).length;
    const lenBucket = tokenCount <= 10 ? "S" : tokenCount <= 20 ? "M" : "L";
    const hasQuestion = /\?/.test(sentence) ? "Q" : "NQ";
    const hasListCue = /[:|]/.test(sentence) ? "L" : "NL";
    const hasConditional = /\b(if|when|unless)\b/i.test(sentence) ? "C" : "NC";
    shapes.add(`${lenBucket}-${hasQuestion}-${hasListCue}-${hasConditional}`);
  }
  return shapes;
}

function jaccard<T>(left: Set<T>, right: Set<T>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  const union = left.size + right.size - overlap;
  return union === 0 ? 0 : overlap / union;
}

function structuralSimilarity(a: string, b: string): number {
  const tokenScore = jaccard(buildNgrams(structuralTokens(a), 3), buildNgrams(structuralTokens(b), 3));
  const shapeScore = jaccard(sentenceShape(a), sentenceShape(b));
  return clampUnit(tokenScore * 0.68 + shapeScore * 0.32);
}

function analyzeStructuralGroup(kind: StructuralPatternKind, values: string[]): StructuralPatternGroupResult {
  const filtered = values.map((value) => value.trim()).filter((value) => value.length > 20);
  if (filtered.length < 2) {
    return { kind, ratio: 0, strongestSimilarity: 0 };
  }
  let pairCount = 0;
  let repeatedPairCount = 0;
  let strongest = 0;
  for (let left = 0; left < filtered.length; left += 1) {
    for (let right = left + 1; right < filtered.length; right += 1) {
      pairCount += 1;
      const similarity = structuralSimilarity(filtered[left], filtered[right]);
      strongest = Math.max(strongest, similarity);
      if (similarity >= 0.78) {
        repeatedPairCount += 1;
      }
    }
  }
  return {
    kind,
    ratio: pairCount === 0 ? 0 : repeatedPairCount / pairCount,
    strongestSimilarity: strongest,
  };
}

function analyzeTemplateLeakage(modules: ModuleSlice[], exercises: string[]): StructuralLeakageResult {
  const groups: StructuralPatternGroupResult[] = [
    analyzeStructuralGroup("debugging-flow", modules.map((module) => module.debugScenario)),
    analyzeStructuralGroup("cognitive-bridge", modules.map((module) => `${module.cognitiveBridge} ${module.abstractionShift}`)),
    analyzeStructuralGroup("remediation-logic", modules.map((module) => module.remediationLogic)),
    analyzeStructuralGroup("exercise-format", exercises),
    analyzeStructuralGroup("transition-pattern", modules.map((module) => module.transition)),
  ];
  const weighted = groups.reduce((sum, group) => sum + group.ratio, 0) / Math.max(1, groups.length);
  const repeatedQuotes = modules
    .filter((module) => module.transition.length > 0)
    .slice(0, 2)
    .map((module) => asQuote(module.transition));
  return {
    leakageIndex: clampUnit(weighted),
    groups,
    repeatedQuotes,
  };
}

function moduleIndexFromSectionTitle(sectionTitle?: string): number | null {
  if (!sectionTitle) return null;
  const match = sectionTitle.match(/^(\d+)\.\s+/);
  if (!match) return null;
  const index = Number.parseInt(match[1], 10) - 1;
  return Number.isFinite(index) && index >= 0 ? index : null;
}

function conceptTokenSet(text: string): Set<string> {
  const tokens = normalize(text)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 6 && !STRUCTURAL_STOPWORDS.has(token));
  return new Set(tokens);
}

function overlapRatio(needle: Set<string>, haystack: Set<string>): number {
  if (needle.size === 0 || haystack.size === 0) return 0;
  let overlap = 0;
  for (const token of needle) {
    if (haystack.has(token)) overlap += 1;
  }
  return overlap / needle.size;
}

function moduleComplexity(module: ModuleSlice, matchingUnits: EvaluationUnitScore[]): number {
  if (matchingUnits.length > 0) {
    return clampUnit(avg(matchingUnits.map((unit) =>
      (unit.dimensionScores.abstractionLevel + unit.dimensionScores.pacingComplexity + unit.dimensionScores.technicalDepth) / 3)));
  }
  const text = `${module.advancedLayer} ${module.abstractionShift}`;
  const longWordDensity = safeDivide(text.match(/\b[a-z]{10,}\b/gi)?.length ?? 0, Math.max(1, wordCount(text)));
  const branchDensity = safeDivide((text.match(/\b(if|when|unless|trade[- ]?off|versus|cost)\b/gi)?.length ?? 0), 6);
  return clampUnit(longWordDensity * 5 + branchDensity);
}

function classifyUnitLayer(text: string): "beginner" | "advanced" | "mixed" | "neutral" {
  const normalized = text.toLowerCase();
  const beginnerCue = /\bbeginner layer\b|\bmental model\b|\bsimplified mechanism\b|\bprior knowledge\b/.test(normalized);
  const advancedCue = /\badvanced layer\b|\btrade[- ]?off\b|\boperational\b|\barchitecture\b|\bscaling\b|\bobservability\b/.test(normalized);
  if (beginnerCue && advancedCue) return "mixed";
  if (beginnerCue) return "beginner";
  if (advancedCue) return "advanced";
  return "neutral";
}

function analyzeSequencing(modules: ModuleSlice[], unitScores: EvaluationUnitScore[]): SequencingResult {
  if (modules.length <= 1) {
    return {
      preparationRatio: 1,
      realisticJumpRatio: 1,
      prerequisiteTransferRatio: 1,
      unsafeCompoundingRatio: 0,
      riskyModules: [],
    };
  }
  const complexityByModule = new Map<number, number>();
  for (const module of modules) {
    const matching = unitScores.filter((unit) => moduleIndexFromSectionTitle(unit.evidence[0]?.sectionTitle) === module.index);
    complexityByModule.set(module.index, moduleComplexity(module, matching));
  }

  let preparedCount = 0;
  let realisticJumps = 0;
  let transferCount = 0;
  let unsafeCompounding = 0;
  const riskyModules: string[] = [];
  const seenKnowledge = new Set<string>();

  for (let index = 0; index < modules.length; index += 1) {
    const module = modules[index];
    const currentNeed = conceptTokenSet(`${module.advancedLayer} ${module.abstractionShift} ${module.cognitiveBridge}`);
    const prepOverlap = overlapRatio(currentNeed, seenKnowledge);
    const transferCue = /\b(build(ing)? on|based on|from earlier|as seen|previous|prior)\b/i.test(
      `${module.transition} ${module.cognitiveBridge}`,
    );
    if (index === 0 || prepOverlap >= 0.14 || transferCue) {
      preparedCount += 1;
    }
    if (index > 0) {
      const currentComplexity = complexityByModule.get(module.index) ?? 0.5;
      const prevComplexity = complexityByModule.get(modules[index - 1].index) ?? 0.5;
      const jump = currentComplexity - prevComplexity;
      if (jump <= 0.22) {
        realisticJumps += 1;
      }
      if (prepOverlap >= 0.14 || transferCue) {
        transferCount += 1;
      }
      const unsafe = jump > 0.2 && prepOverlap < 0.1 && wordCount(module.transition) < 10;
      if (unsafe) {
        unsafeCompounding += 1;
        riskyModules.push(module.title);
      }
    }
    for (const token of conceptTokenSet(module.fullText)) {
      seenKnowledge.add(token);
    }
  }

  return {
    preparationRatio: preparedCount / modules.length,
    realisticJumpRatio: realisticJumps / Math.max(1, modules.length - 1),
    prerequisiteTransferRatio: transferCount / Math.max(1, modules.length - 1),
    unsafeCompoundingRatio: unsafeCompounding / Math.max(1, modules.length - 1),
    riskyModules: riskyModules.slice(0, 4),
  };
}

function analyzeModuleDepth(module: ModuleSlice): ModuleDepthProfile {
  const advancedWords = wordCount(module.advancedLayer);
  const hasDecisionLogic = /\b(if|when|unless|trade[- ]?off|constraint|choose|depends)\b/i.test(
    `${module.advancedLayer} ${module.abstractionShift}`,
  );
  const hasImplementationReasoning = /files:|apis:|acceptance:/i.test(module.implementationArtifact) && /,\s*| \| /.test(module.implementationArtifact);
  const hasFailureLoop = /symptom:|root cause:|fix:|verify:/i.test(module.debugScenario);
  const hasOperationalValidation = /\b(metric|verify|assert|test|observe|instrument)\b/i.test(
    `${module.debugScenario} ${module.advancedLayer}`,
  );
  const depthScore = clampUnit(
    Math.min(1, advancedWords / 110) * 0.25
      + (hasDecisionLogic ? 0.2 : 0)
      + (hasImplementationReasoning ? 0.25 : 0)
      + (hasFailureLoop ? 0.2 : 0)
      + (hasOperationalValidation ? 0.1 : 0),
  );
  return {
    moduleIndex: module.index,
    depthScore,
    deeplyExplored: depthScore >= 0.66,
    mentionOnly: advancedWords >= 18 && depthScore < 0.42,
  };
}

function analyzePedagogicalTrajectory(
  modules: ModuleSlice[],
  unitScores: EvaluationUnitScore[],
  sequencing: SequencingResult,
  inclusionCoverage: InclusionCoverageItem[],
  durationMinutes: number,
): PedagogicalTrajectoryResult {
  const progressionQuality = clampUnit(
    sequencing.preparationRatio * 0.45
      + sequencing.realisticJumpRatio * 0.35
      + sequencing.prerequisiteTransferRatio * 0.2,
  );
  const recapCueRatio = modules.length === 0
    ? 0
    : modules.filter((module) => /\b(recap|summar|review|connect back|reinforce)\b/i.test(module.transition)).length / modules.length;
  const interactionRatio = modules.length === 0
    ? 0
    : modules.filter((module) => wordCount(module.interaction) >= 8).length / modules.length;
  const cheatSheet = inclusionCoverage.find((item) => item.key === "includeCheatSheet");
  const retentionSupport = clampUnit(
    interactionRatio * 0.45
      + recapCueRatio * 0.35
      + (cheatSheet?.present && cheatSheet.integrated ? 0.2 : 0),
  );
  const misconceptionManagement = modules.length === 0
    ? 0
    : modules.filter((module) => /\bmisconception|common mistake|pitfall|anti-pattern|wrong\b/i.test(module.fullText)).length / modules.length;
  const abstractionPacing = sequencing.realisticJumpRatio;
  const avgScaffolding = avg(unitScores.map((unit) => unit.dimensionScores.instructionalScaffolding));
  const avgComplexity = avg(unitScores.map((unit) =>
    (unit.dimensionScores.pacingComplexity + unit.dimensionScores.terminologyDensity + unit.dimensionScores.technicalDepth) / 3));
  const fatigueRisk = clampUnit(
    Math.min(1, durationMinutes / 180) * 0.34
      + Math.max(0, avgComplexity - 0.55) * 0.46
      + (1 - retentionSupport) * 0.2,
  );
  const overloadRisk = clampUnit(
    avgComplexity * 0.42
      + (1 - avgScaffolding) * 0.33
      + (1 - progressionQuality) * 0.25,
  );
  return {
    progressionQuality,
    retentionSupport,
    misconceptionManagement,
    abstractionPacing,
    fatigueRisk,
    overloadRisk,
  };
}

function reconcileEvaluationState(params: {
  status: InstructorPreviewEvaluation["status"];
  passed: boolean;
  reliability: ReliabilityLevel;
  confidence: number;
  mismatchErrors: number;
  mismatchWarnings: number;
  uncertainReasons: string[];
  cohortAlignmentScore: number;
}): ReconciledEvaluationState {
  let status = params.status;
  let passed = params.passed;
  let reliability = params.reliability;
  const confidence = clampUnit(params.confidence);
  const contradictions: string[] = [];
  const adjustments: string[] = [];

  if (status === "pass" && params.mismatchErrors > 0) {
    contradictions.push("Pass status conflicts with error-level mismatches.");
    status = "fail";
    passed = false;
    adjustments.push("Downgraded status to fail due to error-level mismatches.");
  }
  if (status === "pass" && params.cohortAlignmentScore < 60) {
    contradictions.push("Pass status conflicts with weak cohort alignment.");
    status = "fail";
    passed = false;
    adjustments.push("Downgraded status to fail because cohort alignment is below 60.");
  }
  if (status === "uncertain" && confidence >= 0.82 && params.uncertainReasons.length === 0 && params.mismatchErrors === 0) {
    contradictions.push("Uncertain status conflicts with high confidence and no uncertainty reasons.");
    status = passed ? "pass" : "fail";
    adjustments.push("Resolved uncertain status using confidence and mismatch gates.");
  }
  if (reliability === "HIGH" && (params.mismatchErrors > 0 || params.mismatchWarnings > 4 || confidence < 0.74)) {
    contradictions.push("High trust conflicts with warning/error severity or low confidence.");
    reliability = params.mismatchErrors > 0 || confidence < 0.62 ? "LOW" : "MEDIUM";
    adjustments.push("Lowered trust level to match mismatch severity and confidence.");
  }
  if (reliability === "LOW" && confidence > 0.84 && params.mismatchErrors === 0 && params.mismatchWarnings <= 1) {
    contradictions.push("Low trust conflicts with strong confidence and low warning load.");
    reliability = "MEDIUM";
    adjustments.push("Raised trust level from LOW to MEDIUM due to clean warning profile.");
  }
  if (status === "pass" && confidence < 0.62) {
    contradictions.push("Pass status conflicts with low confidence.");
    status = "uncertain";
    passed = false;
    adjustments.push("Moved status to uncertain due to low confidence.");
  }

  return {
    status,
    passed,
    reliability,
    confidence,
    contradictions,
    adjustments,
  };
}

function createRecommendations(mismatches: EvaluationMismatch[]): InstructorPreviewEvaluation["recommendations"] {
  const recommendations: InstructorPreviewEvaluation["recommendations"] = [];

  mismatches.forEach((mismatch, index) => {
    if (mismatch.category === "cohort") {
      recommendations.push({
        priority: mismatch.severity === "error" ? "high" : "medium",
        recommendation: "Rebalance the lesson by adjusting the ratio of intuitive explanations vs advanced trade-off analysis.",
        rationale: "Audience distribution is out of tolerance for the configured cohort mix.",
        relatedMismatchIndexes: [index],
      });
    }
    if (mismatch.category === "pacing") {
      recommendations.push({
        priority: mismatch.severity === "error" ? "high" : "medium",
        recommendation: "Reallocate time by trimming low-priority detail or restructuring exercises into shorter checkpoints.",
        rationale: "Estimated instructional pacing does not fit the configured class duration.",
        relatedMismatchIndexes: [index],
      });
    }
    if (mismatch.category === "inclusion") {
      recommendations.push({
        priority: mismatch.severity === "error" ? "high" : "medium",
        recommendation: "Integrate required artifacts with explicit teaching intent and debrief guidance.",
        rationale: "Enabled output inclusions are missing or not pedagogically integrated.",
        relatedMismatchIndexes: [index],
      });
    }
    if (mismatch.category === "confidence") {
      recommendations.push({
        priority: "low",
        recommendation: "Add explicit evidence anchors in the preview text to improve judge certainty.",
        rationale: "Low confidence decisions increase uncertainty risk.",
        relatedMismatchIndexes: [index],
      });
    }
    if (mismatch.category === "evidence") {
      recommendations.push({
        priority: mismatch.severity === "error" ? "high" : "medium",
        recommendation: "Vary module scaffolds and explicitly change debugging/remediation/exercise structures across modules.",
        rationale: "Structural template leakage reduces transfer quality and learner engagement.",
        relatedMismatchIndexes: [index],
      });
    }
  });

  if (recommendations.length === 0) {
    recommendations.push({
      priority: "low",
      recommendation: "No corrective action required; maintain current structure.",
      rationale: "All deterministic gates passed within tolerance.",
      relatedMismatchIndexes: [],
    });
  }

  return recommendations.slice(0, 10);
}

export async function evaluateInstructorPreview(params: {
  brief: BriefInput;
  preview: InstructorPreview;
}): Promise<InstructorPreviewEvaluation> {
  const { brief, preview } = params;
  const units = parsePreviewUnits(preview.markdown);
  const unitIndex = new Map(units.map((unit) => [unit.unitId, unit]));

  const judgePrompt = [
    `Topic: ${brief.topic}`,
    `Configured duration: ${brief.durationMinutes} minutes`,
    `Audience split: ${brief.audience.beginnerPercent}% beginner / ${brief.audience.advancedPercent}% advanced`,
    `Teaching mode: ${brief.teachingMode}`,
    `Enabled inclusions: code=${brief.includeCode}, flowcharts=${brief.includeFlowcharts}, exercises=${brief.includeExercises}, cheatSheet=${brief.includeCheatSheet}`,
    "You are an independent LLM-as-a-Judge evaluator.",
    "Do not regenerate or rewrite any lesson content.",
    "Audit only the supplied units and provide evidence-backed scoring.",
    "Every claim must cite exact text quotes from supplied units.",
    "Use weighted mixed-cohort reasoning. Do not collapse into binary labels.",
    "If uncertain, reduce confidence instead of inventing findings.",
    "Evaluate each unit independently on abstraction level, prerequisite knowledge, pacing complexity, terminology density, technical depth, and instructional scaffolding.",
    "Units:",
    ...units.map((unit) => `- ${unit.unitId} [${unit.unitType}]${unit.sectionTitle ? ` (${unit.sectionTitle})` : ""}: ${unit.text}`),
  ].join("\n");

  let judgeResult: z.infer<typeof JudgeAuditSchema> = {
    unitAssessments: [],
    inclusionAssessments: [],
    mismatchHints: [],
    notes: [],
  };
  let judgeUnavailable = false;
  const deterministicChecks: string[] = [
    "Judge call temperature fixed at 0.",
    "All final pass/fail decisions computed by deterministic aggregator.",
    "Evidence quotes are validated against the generated preview text.",
  ];
  const uncertainReasons: string[] = [];

  try {
    const response = await generateStructuredObject({
      schema: JudgeAuditSchema,
      schemaName: "InstructorPreviewJudgeAudit",
      systemPrompt: `${commonSystemRules}\nYou are an audit-only judging component. You must not generate new instructional content.`,
      userPrompt: judgePrompt,
      temperature: 0,
      maxTokens: 3600,
      maxRetries: 0,
    });
    judgeResult = response.output;
  } catch (error) {
    judgeUnavailable = true;
    uncertainReasons.push(
      error instanceof Error
        ? `Judge model unavailable: ${error.message}`
        : "Judge model unavailable; fallback heuristics applied.",
    );
    deterministicChecks.push("LLM judge failed, deterministic fallback scoring applied.");
  }

  const unitScores: EvaluationUnitScore[] = units.map((unit) => {
    const judged = judgeResult.unitAssessments.find((entry) => entry.unitId === unit.unitId);
    if (!judged) {
      return fallbackUnitScore(unit);
    }
    const validEvidence = validateEvidence(judged.evidence, unit.text);
    const evidenceCoverage = validEvidence.length / Math.max(1, judged.evidence.length);
    if (validEvidence.length === 0) {
      uncertainReasons.push(`No verifiable evidence returned for ${unit.unitId}; fallback evidence attached.`);
    }
    return {
      unitId: unit.unitId,
      unitType: unit.unitType,
      text: unit.text,
      dimensionScores: {
        abstractionLevel: clampUnit(judged.dimensionScores.abstractionLevel),
        prerequisiteKnowledge: clampUnit(judged.dimensionScores.prerequisiteKnowledge),
        pacingComplexity: clampUnit(judged.dimensionScores.pacingComplexity),
        terminologyDensity: clampUnit(judged.dimensionScores.terminologyDensity),
        technicalDepth: clampUnit(judged.dimensionScores.technicalDepth),
        instructionalScaffolding: clampUnit(judged.dimensionScores.instructionalScaffolding),
      },
      beginnerAffinity: clampUnit(judged.beginnerAffinity),
      advancedAffinity: clampUnit(judged.advancedAffinity),
      confidence: clampUnit(judged.confidence * (0.55 + evidenceCoverage * 0.45)),
      evidence: validEvidence.length > 0
        ? validEvidence
        : [{ quote: asQuote(unit.text), sectionTitle: unit.sectionTitle }],
    };
  });

  const moduleSlices = parseModuleSlices(preview.markdown);
  const exerciseFormats = parseExerciseFormats(preview.markdown);
  const flowchartRequiredCount = expectedFlowchartCount(
    brief.audience.beginnerPercent,
    brief.audience.advancedPercent,
  );
  const flowchartQuality = summarizeFlowchartQuality(
    preview.markdown,
    collectTopicTokens(
      brief.topic,
      moduleSlices.map((module) => module.title),
    ),
  );
  const templateLeakage = analyzeTemplateLeakage(moduleSlices, exerciseFormats);
  const sequencing = analyzeSequencing(moduleSlices, unitScores);
  const depthProfiles = moduleSlices.map(analyzeModuleDepth);
  const depthByModule = new Map(depthProfiles.map((profile) => [profile.moduleIndex, profile]));
  const mentionOnlyModules = depthProfiles.filter((profile) => profile.mentionOnly);
  const deeplyExploredModules = depthProfiles.filter((profile) => profile.deeplyExplored);

  const layerTaggedUnits = unitScores.map((unit) => ({ unit, layer: classifyUnitLayer(unit.text) }));
  const beginnerCandidateUnits = layerTaggedUnits
    .filter((entry) => entry.layer === "beginner")
    .map((entry) => entry.unit);
  const advancedCandidateUnits = layerTaggedUnits
    .filter((entry) => entry.layer === "advanced")
    .map((entry) => entry.unit);
  const fallbackCandidatePool = layerTaggedUnits
    .filter((entry) => entry.layer !== "mixed")
    .map((entry) => entry.unit);

  const fakeBeginnerUnits = (beginnerCandidateUnits.length > 0 ? beginnerCandidateUnits : fallbackCandidatePool).filter((unit) =>
    unit.beginnerAffinity >= unit.advancedAffinity
      && (unit.dimensionScores.prerequisiteKnowledge > 0.64
        || unit.dimensionScores.terminologyDensity > 0.7
        || unit.dimensionScores.instructionalScaffolding < 0.3));

  const fakeAdvancedUnits = (advancedCandidateUnits.length > 0 ? advancedCandidateUnits : fallbackCandidatePool).filter((unit) => {
    if (unit.advancedAffinity < unit.beginnerAffinity) {
      return false;
    }
    const moduleIndex = moduleIndexFromSectionTitle(unit.evidence[0]?.sectionTitle);
    const moduleDepth = moduleIndex !== null ? depthByModule.get(moduleIndex)?.depthScore ?? 0 : 0;
    if (moduleDepth >= 0.66) {
      return false;
    }
    const text = unit.text.toLowerCase();
    const tradeoffSignals = /\b(trade[- ]?off|latency|throughput|scal|constraint|rollback|failure|operational|mitigation|contain)\b/.test(text);
    const hasImplementationReasoning = /\b(api|file|acceptance|verification|metric|instrument)\b/.test(text);
    return (unit.dimensionScores.technicalDepth < 0.42 || (!tradeoffSignals && !hasImplementationReasoning)) && moduleDepth < 0.56;
  });

  const fingerprints = unitScores.map((unit) => ({
    id: unit.unitId,
    unitType: unit.unitType,
    fp: fingerprint(unit.text),
  }));
  const fpCounts = new Map<string, number>();
  for (const item of fingerprints) {
    if (!item.fp) continue;
    fpCounts.set(item.fp, (fpCounts.get(item.fp) ?? 0) + 1);
  }
  const repeatedPatternUnits = fingerprints.filter((item) => (fpCounts.get(item.fp) ?? 0) > 1);
  const lexicalRepetitionRatio = repeatedPatternUnits.length / Math.max(1, unitScores.length);
  const repetitionRatio = Math.max(lexicalRepetitionRatio, templateLeakage.leakageIndex);

  const weightedBeginner = unitScores.reduce((sum, score) => {
    const unit = unitIndex.get(score.unitId);
    const weight = (unit?.wordCount ?? 1) * (0.55 + score.confidence * 0.45);
    return sum + score.beginnerAffinity * weight;
  }, 0);
  const weightedAdvanced = unitScores.reduce((sum, score) => {
    const unit = unitIndex.get(score.unitId);
    const weight = (unit?.wordCount ?? 1) * (0.55 + score.confidence * 0.45);
    return sum + score.advancedAffinity * weight;
  }, 0);
  const affinityTotal = Math.max(0.0001, weightedBeginner + weightedAdvanced);
  const observedBeginnerPercent = (weightedBeginner / affinityTotal) * 100;
  const observedAdvancedPercent = 100 - observedBeginnerPercent;
  const targetBeginnerPercent = brief.audience.beginnerPercent;
  const targetAdvancedPercent = brief.audience.advancedPercent;
  const tolerancePercent = evaluateTolerance(targetBeginnerPercent);
  const deviationPercent = Math.abs(observedBeginnerPercent - targetBeginnerPercent);
  const beginnerOverfit = observedBeginnerPercent - targetBeginnerPercent > tolerancePercent && observedBeginnerPercent > 65;
  const advancedOverfit = observedAdvancedPercent - targetAdvancedPercent > tolerancePercent && observedAdvancedPercent > 65;
  const withinAudienceTolerance = deviationPercent <= tolerancePercent;

  const explanationUnits = unitScores.filter((unit) => unit.unitType !== "exercise");
  const exerciseUnits = unitScores.filter((unit) => unit.unitType === "exercise");
  const explanationWords = explanationUnits.reduce((sum, unit) => sum + wordCount(unit.text), 0);
  const exerciseWords = exerciseUnits.reduce((sum, unit) => sum + wordCount(unit.text), 0);
  const avgComplexity = avg(unitScores.map((unit) =>
    (unit.dimensionScores.pacingComplexity + unit.dimensionScores.technicalDepth + unit.dimensionScores.terminologyDensity) / 3));
  const discussionPromptCount = unitScores.filter((unit) => hasDiscussionPrompt(unit.text)).length;
  const sectionCount = Math.max(1, findSectionCount(preview.markdown), moduleSlices.length);
  const cognitiveTransitions = unitScores.slice(1).reduce((count, current, index) => {
    const prev = unitScores[index];
    const delta = Math.abs(current.dimensionScores.abstractionLevel - prev.dimensionScores.abstractionLevel);
    return delta > 0.25 ? count + 1 : count;
  }, 0);

  const explanationMinutes = explanationWords / Math.max(85, 130 - avgComplexity * 28);
  const exerciseMinutes = exerciseWords / 80 + exerciseUnits.length * 5;
  const discussionMinutes = discussionPromptCount * 1.6;
  const transitionOverheadMinutes = Math.max(0, sectionCount - 1) * 0.65 + cognitiveTransitions * 0.5;
  const estimatedTotalMinutes = explanationMinutes + exerciseMinutes + discussionMinutes + transitionOverheadMinutes;
  const deltaMinutes = Math.abs(estimatedTotalMinutes - brief.durationMinutes);
  const toleranceMinutes = Math.max(8, brief.durationMinutes * 0.15);
  const pacingWithinTolerance = deltaMinutes <= toleranceMinutes;

  const inclusionKeys: InclusionCoverageItem["key"][] = [
    "includeCode",
    "includeFlowcharts",
    "includeExercises",
    "includeCheatSheet",
  ];
  const inclusionSettings: Record<InclusionCoverageItem["key"], boolean> = {
    includeCode: brief.includeCode,
    includeFlowcharts: brief.includeFlowcharts,
    includeExercises: brief.includeExercises,
    includeCheatSheet: brief.includeCheatSheet,
  };
  const inclusionByJudge = new Map(judgeResult.inclusionAssessments.map((item) => [item.key, item]));
  const inclusionCoverage: InclusionCoverageItem[] = inclusionKeys.map((key) => {
    const present = inclusionPresence(key, preview.markdown);
    const judgeAssessment = inclusionByJudge.get(key);
    const rawEvidence = judgeAssessment?.evidence ?? [];
    const validEvidence = validateEvidence(rawEvidence, preview.markdown);
    const inferredIntegrated = inferInclusionIntegration(key, preview.markdown, moduleSlices, exerciseFormats);
    const flowchartIntegrated = key === "includeFlowcharts"
      ? flowchartQuality.meaningful >= flowchartRequiredCount
        && flowchartQuality.topicRelevant >= flowchartRequiredCount
        && (flowchartQuality.total - flowchartQuality.metaOnly) >= flowchartRequiredCount
      : inferredIntegrated;
    const flowchartAudienceFit = key === "includeFlowcharts"
      ? (
        flowchartRequiredCount >= 2
          ? flowchartQuality.beginnerAligned > 0 && flowchartQuality.advancedAligned > 0
          : flowchartQuality.meaningful >= 1
      )
      : inferredIntegrated;
    const baseConfidence = judgeAssessment?.confidence ?? (judgeUnavailable ? 0.72 : 0.55);
    const confidence = clampUnit(
      baseConfidence * (
        judgeAssessment
          ? (validEvidence.length > 0 ? 1 : 0.55)
          : (flowchartIntegrated ? 0.95 : 0.72)
      ),
    );
    const integrated = present && (
      key === "includeFlowcharts"
        ? (judgeAssessment?.integrated ?? true) && flowchartIntegrated
        : (judgeAssessment?.integrated ?? flowchartIntegrated)
    );
    const appropriateForAudienceMix = present && (
      key === "includeFlowcharts"
        ? (judgeAssessment?.appropriateForAudienceMix ?? true) && flowchartAudienceFit
        : (judgeAssessment?.appropriateForAudienceMix ?? flowchartAudienceFit)
    );
    return {
      key,
      enabled: inclusionSettings[key],
      present,
      integrated,
      appropriateForAudienceMix,
      confidence,
      evidence: validEvidence,
    };
  });
  const trajectory = analyzePedagogicalTrajectory(
    moduleSlices,
    unitScores,
    sequencing,
    inclusionCoverage,
    brief.durationMinutes,
  );
  deterministicChecks.push(
    `Sequencing analysis: prep=${round(sequencing.preparationRatio, 2)}, jump=${round(sequencing.realisticJumpRatio, 2)}, transfer=${round(sequencing.prerequisiteTransferRatio, 2)}.`,
  );
  deterministicChecks.push(
    `Trajectory analysis: progression=${round(trajectory.progressionQuality, 2)}, retention=${round(trajectory.retentionSupport, 2)}, overloadRisk=${round(trajectory.overloadRisk, 2)}.`,
  );
  deterministicChecks.push(
    `Flowchart audit: meaningful=${flowchartQuality.meaningful}/${flowchartRequiredCount}, topicRelevant=${flowchartQuality.topicRelevant}, metaOnly=${flowchartQuality.metaOnly}, beginnerAligned=${flowchartQuality.beginnerAligned}, advancedAligned=${flowchartQuality.advancedAligned}.`,
  );

  const mismatches: EvaluationMismatch[] = [];
  const addMismatch = (mismatch: EvaluationMismatch) => {
    mismatches.push(mismatch);
  };
  const fallbackEvidenceQuote = ensureNonEmptyQuote(
    asQuote(preview.summary || preview.title || preview.markdown),
    "Evaluation evidence unavailable.",
  );

  if (fakeBeginnerUnits.length > 0) {
    const severeBeginnerDrift = fakeBeginnerUnits.length >= Math.max(3, Math.ceil(unitScores.length * 0.4))
      && moduleSlices.length >= 3
      && !withinAudienceTolerance;
    addMismatch({
      severity: severeBeginnerDrift ? "error" : "warning",
      category: "cohort",
      reason: "Beginner-targeted content appears to assume advanced prerequisites or overloaded terminology.",
      violatedDimensions: ["prerequisiteKnowledge", "terminologyDensity", "instructionalScaffolding"],
      evidence: fakeBeginnerUnits.slice(0, 3).map((unit) => unit.evidence[0]),
      confidence: clampUnit(avg(fakeBeginnerUnits.map((unit) => unit.confidence))),
    });
  }

  if (fakeAdvancedUnits.length > 0) {
    const severeAdvancedDrift = fakeAdvancedUnits.length >= Math.max(3, Math.ceil(unitScores.length * 0.4))
      && deeplyExploredModules.length === 0
      && moduleSlices.length >= 3;
    addMismatch({
      severity: severeAdvancedDrift ? "error" : "warning",
      category: "cohort",
      reason: "Advanced-targeted sections lack systems-level tradeoffs, operational constraints, or production failure depth.",
      violatedDimensions: ["technicalDepth", "abstractionLevel", "pacingComplexity"],
      evidence: fakeAdvancedUnits.slice(0, 3).map((unit) => unit.evidence[0]),
      confidence: clampUnit(avg(fakeAdvancedUnits.map((unit) => unit.confidence))),
    });
  }

  if (templateLeakage.leakageIndex > 0.2 || repetitionRatio > 0.22) {
    addMismatch({
      severity: templateLeakage.leakageIndex > 0.34 ? "error" : "warning",
      category: "evidence",
      reason: "Template leakage detected via semantic-structural comparison across debug flow, cognitive bridge, remediation, exercise, and transition patterns.",
      violatedDimensions: ["instructionalScaffolding", "technicalDepth"],
      evidence: ensureEvidenceList(
        (templateLeakage.repeatedQuotes.length > 0
          ? templateLeakage.repeatedQuotes.map((quote) => ({ quote }))
          : repeatedPatternUnits.slice(0, 3).map((unit) => {
            const source = unitScores.find((entry) => entry.unitId === unit.id);
            return source?.evidence[0] ?? { quote: unit.fp || "Repeated structure detected." };
          })).slice(0, 3),
        fallbackEvidenceQuote,
        preview.title,
      ),
      confidence: clampUnit(0.72 + templateLeakage.leakageIndex * 0.24),
    });
  }

  if (mentionOnlyModules.length > 0 && mentionOnlyModules.length >= Math.max(1, Math.floor(moduleSlices.length / 4))) {
    addMismatch({
      severity: "warning",
      category: "cohort",
      reason: "Some advanced sections mention concepts without deep operational exploration (implementation reasoning and verification are thin).",
      violatedDimensions: ["technicalDepth", "abstractionLevel"],
      evidence: ensureEvidenceList(
        mentionOnlyModules
          .map((profile) => moduleSlices.find((module) => module.index === profile.moduleIndex))
          .filter((module): module is ModuleSlice => Boolean(module))
          .slice(0, 3)
          .map((module) => ({ quote: asQuote(module.advancedLayer), sectionTitle: module.title })),
        fallbackEvidenceQuote,
        preview.title,
      ),
      confidence: clampUnit(0.68 + avg(mentionOnlyModules.map((profile) => 1 - profile.depthScore)) * 0.22),
    });
  }

  if (moduleSlices.length >= 2 && (sequencing.preparationRatio < 0.74 || sequencing.realisticJumpRatio < 0.72 || sequencing.prerequisiteTransferRatio < 0.68)) {
    addMismatch({
      severity: "warning",
      category: "pacing",
      reason: "Sequencing risk detected: earlier modules may not prepare later abstractions, and prerequisite transfer is inconsistent.",
      violatedDimensions: ["prerequisiteKnowledge", "pacingComplexity", "instructionalScaffolding"],
      evidence: ensureEvidenceList(
        (sequencing.riskyModules.length > 0 ? moduleSlices.filter((module) => sequencing.riskyModules.includes(module.title)) : moduleSlices)
          .slice(0, 3)
          .map((module) => ({ quote: asQuote(module.transition || module.cognitiveBridge), sectionTitle: module.title })),
        fallbackEvidenceQuote,
        preview.title,
      ),
      confidence: clampUnit(0.66 + (1 - sequencing.preparationRatio) * 0.22 + sequencing.unsafeCompoundingRatio * 0.12),
    });
  }

  if (moduleSlices.length >= 2 && (trajectory.overloadRisk > 0.66 || trajectory.fatigueRisk > 0.62)) {
    addMismatch({
      severity: trajectory.overloadRisk > 0.78 ? "error" : "warning",
      category: "pacing",
      reason: "Pedagogical trajectory indicates compounding cognitive load with elevated overload/fatigue risk.",
      violatedDimensions: ["pacingComplexity", "terminologyDensity", "instructionalScaffolding"],
      evidence: ensureEvidenceList(
        moduleSlices.slice(0, 3).map((module) => ({ quote: asQuote(module.abstractionShift || module.advancedLayer), sectionTitle: module.title })),
        fallbackEvidenceQuote,
        preview.title,
      ),
      confidence: clampUnit(0.64 + trajectory.overloadRisk * 0.2),
    });
  }

  if (moduleSlices.length >= 2 && trajectory.misconceptionManagement < 0.45) {
    addMismatch({
      severity: "warning",
      category: "cohort",
      reason: "Misconception management is sparse; likely learner errors are not consistently surfaced and corrected.",
      violatedDimensions: ["instructionalScaffolding", "prerequisiteKnowledge"],
      evidence: ensureEvidenceList(
        moduleSlices.slice(0, 2).map((module) => ({ quote: asQuote(module.beginnerLayer), sectionTitle: module.title })),
        fallbackEvidenceQuote,
        preview.title,
      ),
      confidence: 0.7,
    });
  }

  if (moduleSlices.length >= 2 && trajectory.retentionSupport < 0.52) {
    addMismatch({
      severity: "warning",
      category: "pacing",
      reason: "Retention support is weak (recap and reinforcement patterns are not frequent enough for durable transfer).",
      violatedDimensions: ["instructionalScaffolding"],
      evidence: ensureEvidenceList(
        moduleSlices.slice(0, 2).map((module) => ({ quote: asQuote(module.transition || module.interaction), sectionTitle: module.title })),
        fallbackEvidenceQuote,
        preview.title,
      ),
      confidence: 0.7,
    });
  }

  if (!withinAudienceTolerance) {
    const severity: EvaluationMismatch["severity"] = deviationPercent > tolerancePercent + 4 ? "error" : "warning";
    addMismatch({
      severity,
      category: "cohort",
      reason: `Weighted audience distribution deviates by ${round(deviationPercent, 1)} points from configured split.`,
      violatedDimensions: ["abstractionLevel", "prerequisiteKnowledge", "technicalDepth", "instructionalScaffolding"],
      evidence: unitScores.slice(0, 3).map((unit) => unit.evidence[0]),
      confidence: clampUnit(avg(unitScores.map((unit) => unit.confidence))),
    });
  }

  if (beginnerOverfit || advancedOverfit) {
    addMismatch({
      severity: "warning",
      category: "cohort",
      reason: beginnerOverfit
        ? "Content overfits beginner learners relative to target cohort."
        : "Content overfits advanced learners relative to target cohort.",
      violatedDimensions: ["abstractionLevel", "technicalDepth", "instructionalScaffolding"],
      evidence: unitScores.slice(0, 2).map((unit) => unit.evidence[0]),
      confidence: clampUnit(avg(unitScores.map((unit) => unit.confidence))),
    });
  }

  if (!pacingWithinTolerance) {
    addMismatch({
      severity: deltaMinutes > toleranceMinutes * 1.4 ? "error" : "warning",
      category: "pacing",
      reason: `Estimated pacing differs from configured duration by ${round(deltaMinutes, 1)} minutes.`,
      violatedDimensions: ["pacingComplexity", "instructionalScaffolding", "terminologyDensity"],
      evidence: unitScores.slice(0, 3).map((unit) => unit.evidence[0]),
      confidence: clampUnit(avg(unitScores.map((unit) => unit.confidence))),
    });
  }

  for (const item of inclusionCoverage) {
    if (item.enabled && !item.present) {
      addMismatch({
        severity: "error",
        category: "inclusion",
        reason: `${item.key} is enabled but missing in the preview output.`,
        violatedDimensions: ["instructionalScaffolding"],
        evidence: [{ quote: asQuote(preview.summary || preview.title), sectionTitle: preview.title }],
        confidence: 0.95,
      });
      continue;
    }
    if (item.enabled && item.present && (!item.integrated || !item.appropriateForAudienceMix)) {
      addMismatch({
        severity: "warning",
        category: "inclusion",
        reason: `${item.key} is present but not well integrated for the configured audience mix.`,
        violatedDimensions: ["instructionalScaffolding", "technicalDepth"],
        evidence: item.evidence.length > 0 ? item.evidence : [{ quote: asQuote(preview.markdown), sectionTitle: preview.title }],
        confidence: item.confidence,
      });
    }
  }

  if (brief.includeFlowcharts) {
    if (flowchartQuality.meaningful < flowchartRequiredCount) {
      const severity: EvaluationMismatch["severity"] = flowchartQuality.meaningful === 0 && flowchartQuality.topicRelevant === 0 ? "error" : "warning";
      addMismatch({
        severity,
        category: "inclusion",
        reason: `Flowchart quality gate failed: ${flowchartQuality.meaningful}/${flowchartRequiredCount} diagram(s) are meaningful and topic-specific.`,
        violatedDimensions: ["instructionalScaffolding", "technicalDepth"],
        evidence: [{ quote: asQuote(preview.markdown), sectionTitle: preview.title }],
        confidence: severity === "error" ? 0.9 : 0.78,
      });
    }
    if (flowchartQuality.metaOnly > 0) {
      addMismatch({
        severity: "warning",
        category: "inclusion",
        reason: "One or more flowcharts are meta-pedagogical (how to teach) instead of modeling the topic workflow.",
        violatedDimensions: ["instructionalScaffolding"],
        evidence: [{ quote: asQuote(preview.markdown), sectionTitle: preview.title }],
        confidence: 0.78,
      });
    }
    if (flowchartRequiredCount >= 2 && (flowchartQuality.beginnerAligned === 0 || flowchartQuality.advancedAligned === 0)) {
      addMismatch({
        severity: "warning",
        category: "cohort",
        reason: "Mixed audience requires foundational and advanced flowchart perspectives, but one side is missing.",
        violatedDimensions: ["abstractionLevel", "instructionalScaffolding", "technicalDepth"],
        evidence: [{ quote: asQuote(preview.markdown), sectionTitle: preview.title }],
        confidence: 0.78,
      });
    }
  }

  const judgeHints = judgeResult.mismatchHints.map((hint) => {
    const sourceUnit = hint.unitId ? unitIndex.get(hint.unitId) : undefined;
    const sourceText = sourceUnit?.text ?? preview.markdown;
    const evidence = validateEvidence(hint.evidence, sourceText);
    if (evidence.length === 0) {
      return null;
    }
    return {
      severity: hint.severity,
      category: hint.category,
      reason: hint.reason,
      violatedDimensions: hint.violatedDimensions,
      evidence,
      confidence: clampUnit(hint.confidence),
    } satisfies EvaluationMismatch;
  }).filter((hint): hint is EvaluationMismatch => Boolean(hint));

  mismatches.push(...judgeHints.slice(0, 8));

  const lowConfidenceDecisions = unitScores.filter((unit) => unit.confidence < 0.55).length;
  if (lowConfidenceDecisions > Math.max(1, Math.floor(unitScores.length * 0.35))) {
    addMismatch({
      severity: "warning",
      category: "confidence",
      reason: `Low-confidence decisions detected in ${lowConfidenceDecisions} content units.`,
      violatedDimensions: [],
      evidence: unitScores.filter((unit) => unit.confidence < 0.55).slice(0, 2).map((unit) => unit.evidence[0]),
      confidence: 0.75,
    });
  }

  const unitConfidence = avg(unitScores.map((unit) => unit.confidence));
  const inclusionConfidence = avg(inclusionCoverage.map((item) => item.confidence));
  const evidenceCoverage = avg(unitScores.map((unit) =>
    Math.min(1, unit.evidence.filter((item) => evidenceExists(item.quote, unit.text)).length)));
  const confidence = clampUnit(
    unitConfidence * 0.5
    + inclusionConfidence * 0.2
    + (pacingWithinTolerance ? 0.1 : 0.03)
    + (withinAudienceTolerance ? 0.08 : 0.03)
    + trajectory.progressionQuality * 0.08
    + sequencing.prerequisiteTransferRatio * 0.06
    - (1 - evidenceCoverage) * 0.2
    - trajectory.overloadRisk * 0.08
    - sequencing.unsafeCompoundingRatio * 0.06,
  );

  if (confidence < 0.62) {
    uncertainReasons.push("Overall evaluation confidence fell below 0.62.");
  }

  const cohortAlignmentScore = clampScore(
    100
    - deviationPercent * 2.2
    - (beginnerOverfit || advancedOverfit ? 10 : 0)
    - Math.max(0, 0.7 - sequencing.preparationRatio) * 18
    - Math.max(0, 0.72 - unitConfidence) * 55,
  );

  const hasBlockingErrors = mismatches.some((mismatch) => mismatch.severity === "error");
  const enabledInclusionFailures = inclusionCoverage.some((item) => item.enabled && !item.present);
  const nonInfraUncertainReasons = uncertainReasons.filter((reason) => !/^Judge model unavailable:/i.test(reason));
  const uncertain = confidence < 0.62 || nonInfraUncertainReasons.length > 0;
  const withinAudienceToleranceSoft = deviationPercent <= tolerancePercent + 3;
  const pacingWithinToleranceSoft = deltaMinutes <= toleranceMinutes + 5;
  const initialPassed = !uncertain && !hasBlockingErrors && withinAudienceToleranceSoft && pacingWithinToleranceSoft && !enabledInclusionFailures;
  const initialStatus: InstructorPreviewEvaluation["status"] = uncertain ? "uncertain" : initialPassed ? "pass" : "fail";
  const mismatchErrors = mismatches.filter((mismatch) => mismatch.severity === "error").length;
  const mismatchWarnings = mismatches.filter((mismatch) => mismatch.severity === "warning").length;
  const initialReliability = toReliabilityLevel({
    confidence,
    mismatchCount: mismatches.length,
    errorCount: mismatchErrors,
    uncertain,
  });
  const reconciledState = reconcileEvaluationState({
    status: initialStatus,
    passed: initialPassed,
    reliability: initialReliability,
    confidence,
    mismatchErrors,
    mismatchWarnings,
    uncertainReasons,
    cohortAlignmentScore,
  });
  if (reconciledState.adjustments.length > 0) {
    deterministicChecks.push(
      `Score reconciliation adjustments: ${reconciledState.adjustments.join(" | ")}`,
    );
  }
  const status = reconciledState.status;
  const passed = reconciledState.passed;
  const reliability = reconciledState.reliability;
  const finalConfidence = reconciledState.confidence;
  const isUncertain = status === "uncertain";

  const interactionsIntegration = {
    present: /\bquestion|discussion|prompt|reflect|pair\b/i.test(preview.markdown),
    integrated: discussionPromptCount >= Math.max(1, Math.floor(sectionCount / 3)),
    pedagogicallyUseful: discussionPromptCount >= 2,
    audienceAligned: withinAudienceTolerance,
    notes: discussionPromptCount >= 2
      ? "Interaction prompts appear regularly and can reinforce retention."
      : "Interaction prompts are sparse relative to lesson scope.",
  };
  const debuggingIntegration = {
    present: /\bdebug|failure|root cause|incident|troubleshoot\b/i.test(preview.markdown),
    integrated: moduleSlices.length > 0
      ? safeDivide(
        moduleSlices.filter((module) =>
          /\bsymptom:|root cause:|fix:|verify:/i.test(module.debugScenario)
          || /\binvestigation|reproduction|verification|rollback|mitigation\b/i.test(module.debugScenario),
        ).length,
        moduleSlices.length,
      ) >= 0.6
      : !fakeAdvancedUnits.some((unit) => /\bdebug|failure\b/i.test(unit.text)),
    pedagogicallyUseful: /\broot cause|verification|rollback|mitigation\b/i.test(preview.markdown),
    audienceAligned: moduleSlices.length > 0
      ? safeDivide(
        moduleSlices.filter((module) => /beginner layer:/i.test(module.beginnerLayer) || module.beginnerLayer.length > 40).length,
        moduleSlices.length,
      ) >= 0.5
      : !fakeBeginnerUnits.some((unit) => /\bdebug|failure\b/i.test(unit.text)),
    notes: /\broot cause|verification|rollback|mitigation\b/i.test(preview.markdown)
      ? "Debugging scenarios include operational reasoning."
      : "Debugging appears superficial and may not build transferable skill.",
  };

  const contradictionFindings = reconciledState.contradictions;

  const narrative: InstructorPreviewEvaluationNarrative = {
    executiveVerdict: {
      coreJudgment: passed
        ? "Pedagogically usable with credible audience alignment and teachable pacing."
        : isUncertain
          ? "Evaluation is uncertain due to low-confidence or weak evidence links."
          : "Pedagogical quality is not yet reliable for instructor delivery.",
      primaryStrengths: [
        withinAudienceTolerance ? "Audience mix is broadly aligned in weighted terms." : "Some sections attempt audience layering.",
        pacingWithinTolerance ? "Estimated pacing is within practical tolerance." : "Lesson contains teachable segments despite pacing risk.",
        sequencing.preparationRatio >= 0.74 ? "Earlier modules provide usable setup for later abstractions." : "Some modules still establish useful conceptual anchors.",
        inclusionCoverage.some((item) => item.enabled && item.present && item.integrated)
          ? "At least one enabled artifact is pedagogically integrated."
          : "Artifacts exist but integration quality is inconsistent.",
      ],
      primaryWeaknesses: [
        ...fakeBeginnerUnits.length > 0 ? ["Beginner pathways include hidden prerequisite burden."] : [],
        ...fakeAdvancedUnits.length > 0 ? ["Advanced segments lack robust production-grade depth."] : [],
        ...mentionOnlyModules.length > 0 ? ["Some advanced concepts are mentioned but not deeply explored with implementation reasoning."] : [],
        ...templateLeakage.leakageIndex > 0.2 ? ["Template leakage reduces novelty and instructional differentiation."] : [],
        ...sequencing.unsafeCompoundingRatio > 0.2 ? ["Abstraction jumps compound too quickly across modules."] : [],
        ...trajectory.overloadRisk > 0.66 ? ["Trajectory indicates elevated overload risk for mixed cohorts."] : [],
        ...(!pacingWithinTolerance ? ["Pacing model indicates probable over/under-compression."] : []),
      ].slice(0, 4),
      overallTrustLevel: reliability,
    },
    audienceAnalysis: {
      beginnerAccessibility: fakeBeginnerUnits.length === 0
        ? "Beginner access is acceptable with visible scaffolding."
        : "Beginner support is fragile due to prerequisite and terminology overload.",
      advancedDepth: mentionOnlyModules.length === 0
        ? "Advanced depth includes meaningful technical reasoning and operational realism."
        : deeplyExploredModules.length > 0
          ? "Advanced depth is mixed: some modules are deeply explored, others are mention-only."
          : "Advanced depth is frequently superficial or rephrased beginner content.",
      hiddenPrerequisiteAssumptions: [
        ...fakeBeginnerUnits.slice(0, 4).map((unit) => `Potential hidden prerequisite in ${unit.unitId}.`),
        ...sequencing.riskyModules.slice(0, 2).map((title) => `Prerequisite transfer may be weak before module '${title}'.`),
      ],
      cognitiveOverloadRisks: [
        ...avgComplexity > 0.66 ? ["High density of abstraction and terminology may overload mixed cohorts."] : [],
        ...!withinAudienceTolerance ? ["Audience balance drift can overload one cohort while underserving the other."] : [],
        ...trajectory.overloadRisk > 0.66 ? ["Trajectory score flags sustained overload risk across modules."] : [],
        ...trajectory.fatigueRisk > 0.62 ? ["Fatigue risk is elevated for the configured duration and concept density."] : [],
      ],
    },
    pacingAnalysis: {
      realisticEstimatedTeachingTime: toDurationRange(estimatedTotalMinutes),
      compressionRisks: [
        ...(!pacingWithinTolerance ? [`Configured duration is ${brief.durationMinutes} minutes, but realistic delivery looks ${toDurationRange(estimatedTotalMinutes)}.`] : []),
        ...avgComplexity > 0.7 ? ["High concept density will require extra pauses/check-ins."] : [],
        ...sequencing.unsafeCompoundingRatio > 0.2 ? ["Later modules stack abstraction faster than prior preparation supports."] : [],
        ...trajectory.retentionSupport < 0.52 ? ["Retention scaffolds are sparse relative to complexity progression."] : [],
      ],
      bottleneckModules: sequencing.riskyModules.length > 0
        ? sequencing.riskyModules
        : unitScores
          .filter((unit) => unit.dimensionScores.pacingComplexity > 0.72 || unit.dimensionScores.technicalDepth > 0.74)
          .slice(0, 3)
          .map((unit) => `${unit.unitId}${unit.evidence[0]?.sectionTitle ? ` (${unit.evidence[0].sectionTitle})` : ""}`),
    },
    structuralAnalysis: {
      repetitionDetection: repetitionRatio > 0.22
        ? "Repeated module structures are materially present."
        : "No major repetition concentration detected.",
      templateLeakage: templateLeakage.leakageIndex > 0.2
        ? `Template leakage detected across ${templateLeakage.groups.filter((group) => group.ratio > 0.2).map((group) => group.kind).join(", ") || "multiple structural patterns"}.`
        : "Template leakage appears limited.",
      conceptualRedundancy: repetitionRatio > 0.3
        ? "Conceptual redundancy is high and likely to reduce learner engagement."
        : "Conceptual redundancy is manageable.",
      transitionQuality: sequencing.realisticJumpRatio < 0.72 || cognitiveTransitions > Math.max(2, Math.floor(sectionCount / 2))
        ? "Transitions include abstraction jumps that outpace prerequisite transfer."
        : "Transitions are mostly coherent with manageable abstraction shifts.",
    },
    pedagogicalIntegrationAnalysis: {
      code: {
        present: inclusionCoverage.find((item) => item.key === "includeCode")?.present ?? false,
        integrated: inclusionCoverage.find((item) => item.key === "includeCode")?.integrated ?? false,
        pedagogicallyUseful: inclusionCoverage.find((item) => item.key === "includeCode")?.appropriateForAudienceMix ?? false,
        audienceAligned: inclusionCoverage.find((item) => item.key === "includeCode")?.appropriateForAudienceMix ?? false,
        notes: (inclusionCoverage.find((item) => item.key === "includeCode")?.integrated ?? false)
          ? "Code is tied to instructional flow."
          : "Code appears present but weakly connected to progression.",
      },
      exercises: {
        present: inclusionCoverage.find((item) => item.key === "includeExercises")?.present ?? false,
        integrated: inclusionCoverage.find((item) => item.key === "includeExercises")?.integrated ?? false,
        pedagogicallyUseful: inclusionCoverage.find((item) => item.key === "includeExercises")?.appropriateForAudienceMix ?? false,
        audienceAligned: inclusionCoverage.find((item) => item.key === "includeExercises")?.appropriateForAudienceMix ?? false,
        notes: (inclusionCoverage.find((item) => item.key === "includeExercises")?.integrated ?? false)
          ? "Exercises reinforce prior concepts."
          : "Exercises are present but reinforcement links are weak.",
      },
      diagrams: {
        present: inclusionCoverage.find((item) => item.key === "includeFlowcharts")?.present ?? false,
        integrated: inclusionCoverage.find((item) => item.key === "includeFlowcharts")?.integrated ?? false,
        pedagogicallyUseful: inclusionCoverage.find((item) => item.key === "includeFlowcharts")?.appropriateForAudienceMix ?? false,
        audienceAligned: inclusionCoverage.find((item) => item.key === "includeFlowcharts")?.appropriateForAudienceMix ?? false,
        notes: (inclusionCoverage.find((item) => item.key === "includeFlowcharts")?.integrated ?? false)
          ? "Diagrams support abstraction clarity."
          : "Diagrams exist but clarity impact is limited.",
      },
      cheatSheet: {
        present: inclusionCoverage.find((item) => item.key === "includeCheatSheet")?.present ?? false,
        integrated: inclusionCoverage.find((item) => item.key === "includeCheatSheet")?.integrated ?? false,
        pedagogicallyUseful: inclusionCoverage.find((item) => item.key === "includeCheatSheet")?.appropriateForAudienceMix ?? false,
        audienceAligned: inclusionCoverage.find((item) => item.key === "includeCheatSheet")?.appropriateForAudienceMix ?? false,
        notes: (inclusionCoverage.find((item) => item.key === "includeCheatSheet")?.integrated ?? false)
          ? "Cheat sheet likely reduces recall load."
          : "Cheat sheet coverage appears under-integrated.",
      },
      interactions: interactionsIntegration,
      debuggingScenarios: debuggingIntegration,
    },
    contradictionAnalysis: {
      contradictions: contradictionFindings,
      consistencyVerdict: contradictionFindings.length === 0
        ? "No major scoring contradictions detected."
        : "Score contradictions were detected and reconciled to keep readiness/trust/confidence internally coherent.",
    },
    finalReliabilityScore: reliability,
  };

  const evaluation = InstructorPreviewEvaluationSchema.parse({
    status,
    passed,
    cohortAlignmentScore,
    confidence: finalConfidence,
    weightedDistribution: {
      targetBeginnerPercent,
      targetAdvancedPercent,
      observedBeginnerPercent: Math.round(observedBeginnerPercent),
      observedAdvancedPercent: Math.round(observedAdvancedPercent),
      tolerancePercent,
      deviationPercent: Math.round(deviationPercent),
      withinTolerance: withinAudienceTolerance,
      overfit: {
        beginnerOverfit,
        advancedOverfit,
      },
    },
    pacingFeasibility: {
      configuredDurationMinutes: brief.durationMinutes,
      estimatedTotalMinutes: Math.round(estimatedTotalMinutes),
      explanationMinutes: Math.round(explanationMinutes),
      exerciseMinutes: Math.round(exerciseMinutes),
      discussionMinutes: Math.round(discussionMinutes),
      transitionOverheadMinutes: Math.round(transitionOverheadMinutes),
      deltaMinutes: Math.round(deltaMinutes),
      withinTolerance: pacingWithinTolerance,
      toleranceMinutes: Math.round(toleranceMinutes),
    },
    inclusionCoverage,
    unitScores,
    mismatches,
    recommendations: createRecommendations(mismatches),
    narrative,
    deterministicChecks,
    uncertainReasons,
    createdAt: nowIso(),
  });

  return evaluation;
}
