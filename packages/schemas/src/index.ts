import { z } from "zod";

export const AudienceSchema = z
  .object({
    beginnerPercent: z.number().min(0).max(100),
    advancedPercent: z.number().min(0).max(100),
  })
  .refine((value) => value.beginnerPercent + value.advancedPercent === 100, {
    message: "Audience percentages must sum to 100",
    path: ["advancedPercent"],
  });

export const TargetStackSchema = z.object({
  language: z.string().default("typescript"),
  runtime: z.string().default("node@22"),
  frameworks: z.array(z.string()).default([]),
});

export const BriefInputSchema = z.object({
  topic: z.string().min(3),
  durationMinutes: z.number().int().min(15).max(480),
  audience: AudienceSchema,
  teachingMode: z.enum(["mixed", "beginner-dominant", "advanced-dominant", "segmented"]),
  includeCode: z.boolean().default(true),
  includeFlowcharts: z.boolean().default(true),
  includeExercises: z.boolean().default(true),
  includeCheatSheet: z.boolean().default(true),
  targetStack: TargetStackSchema,
  styleNotes: z.string().max(800).optional(),
});

export const PipelineStageSchema = z.enum([
  "ingest",
  "retrieval",
  "decomposition",
  "audience",
  "artifact_planning",
  "planning",
  "generation",
  "diagram",
  "critique",
  "validation",
  "rendering",
]);

export const NodeExecutionSchema = z.object({
  node: PipelineStageSchema,
  status: z.enum(["success", "warning", "error", "skipped", "retry"]),
  attempt: z.number().int().min(1).default(1),
  retries: z.number().int().min(0).default(0),
  startedAt: z.string(),
  endedAt: z.string(),
  latencyMs: z.number().min(0),
  confidence: z.number().min(0).max(1).optional(),
  warnings: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
  metrics: z.record(z.string(), z.number()).default({}),
  logs: z.array(z.string()).default([]),
  inputArtifacts: z.array(z.string()).default([]),
  outputArtifacts: z.array(z.string()).default([]),
  validationTraces: z.array(z.string()).default([]),
  model: z.string().optional(),
});

export const CurriculumModuleSchema = z.object({
  id: z.string(),
  title: z.string(),
  objective: z.string(),
  estimatedMinutes: z.number().int().min(5),
  difficulty: z.number().min(0).max(1),
  beginnerSupport: z.array(z.string()).default([]),
  advancedExtensions: z.array(z.string()).default([]),
});

export const CurriculumPlanSchema = z.object({
  learningObjectives: z.array(z.string()).min(1),
  modules: z.array(CurriculumModuleSchema).min(1),
  pacingNotes: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

export const ScriptSectionSchema = z.object({
  moduleId: z.string(),
  narration: z.string(),
  transition: z.string(),
  interactionPrompt: z.string(),
  beginnerLayer: z.string(),
  advancedLayer: z.string(),
  cognitiveBridge: z.string(),
  abstractionShift: z.string(),
  implementationArtifact: z.object({
    artifactType: z.enum([
      "langgraph-workflow",
      "langchain-retriever",
      "vector-index-policy",
      "memory-policy",
      "evaluation-harness",
      "deterministic-agent-runner",
      "observability",
    ]),
    title: z.string(),
    files: z.array(z.string()).min(1),
    stackApis: z.array(z.string()).min(2),
    acceptanceCriteria: z.array(z.string()).min(2),
  }),
  debugScenario: z.object({
    title: z.string(),
    symptom: z.string(),
    reproductionSteps: z.array(z.string()).min(2),
    likelyRootCause: z.string(),
    investigationSteps: z.array(z.string()).min(2),
    fixSummary: z.string(),
    verificationChecks: z.array(z.string()).min(1),
  }),
  groundedClaims: z.array(
    z.object({
      claim: z.string(),
      sourceUrl: z.string().url(),
      sourceTitle: z.string(),
    }),
  ).min(1).max(3),
  estimatedWords: z.number().int().positive(),
});

export const CodeSnippetSchema = z.object({
  id: z.string(),
  title: z.string(),
  language: z.enum(["typescript", "bash", "json", "text"]),
  description: z.string(),
  code: z.string(),
  dependencies: z.array(z.string()).default([]),
});

export const ExerciseSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]),
  expectedOutcome: z.string(),
});

export const GenerationOutputSchema = z.object({
  scriptSections: z.array(ScriptSectionSchema).min(1),
  codeSnippets: z.array(CodeSnippetSchema),
  exercises: z.array(ExerciseSchema),
  cheatSheet: z.array(z.string()).default([]),
  references: z.array(z.string().url()).default([]),
  confidence: z.number().min(0).max(1),
});

export const RetrievedSourceSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  title: z.string(),
  domain: z.string(),
  official: z.boolean(),
  status: z.enum(["fetched", "fallback", "failed"]),
  snippet: z.string(),
  retrievedAt: z.string(),
  confidence: z.number().min(0).max(1),
});

export const RetrievalArtifactSchema = z.object({
  query: z.string(),
  sources: z.array(RetrievedSourceSchema),
  groundedFacts: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

export const ConceptNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  learningObjective: z.string(),
  difficulty: z.number().min(0).max(1),
  prerequisites: z.array(z.string()).default([]),
  commonMisconceptions: z.array(z.string()).default([]),
  assessmentPrompt: z.string(),
});

export const TopicDecompositionSchema = z.object({
  canonicalTopic: z.string(),
  progressionRationale: z.string(),
  concepts: z.array(ConceptNodeSchema).min(3),
  confidence: z.number().min(0).max(1),
});

export const AudienceStrategySchema = z.object({
  mode: z.enum(["beginner-dominant", "advanced-dominant", "balanced-layered", "segmented"]),
  divergenceScore: z.number().min(0).max(1),
  instabilityScore: z.number().min(0).max(1),
  beginnerWeight: z.number().min(0).max(1),
  advancedWeight: z.number().min(0).max(1),
  rationale: z.string(),
  recommendedInterventions: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

export const ArtifactPlanSchema = z.object({
  requireCode: z.boolean(),
  requireDiagrams: z.boolean(),
  requireExercises: z.boolean(),
  requireCheatSheet: z.boolean(),
  requireQuiz: z.boolean(),
  requireGlossary: z.boolean(),
  codeDensityTarget: z.number().min(0).max(1),
  diagramDensityTarget: z.number().min(0).max(1),
  exerciseDensityTarget: z.number().min(0).max(1),
  enforcementRules: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

export const GoldenTopicTypeSchema = z.enum([
  "conceptual",
  "systems",
  "infrastructure",
  "implementation-heavy",
  "theory-heavy",
  "workflow-heavy",
  "debugging-heavy",
]);

export const GoldenAudienceShapeSchema = z.enum([
  "beginner-dominant",
  "advanced-dominant",
  "balanced-mixed",
  "unstable-divergence",
]);

export const GoldenTeachingStyleSchema = z.enum([
  "workshop",
  "lecture",
  "bootcamp",
  "enterprise-training",
  "interview-preparation",
  "architecture-review",
]);

export const GoldenDurationBandSchema = z.enum([
  "30m",
  "60m",
  "90m",
  "120m",
  "180m",
  "multi-session",
]);

export const GoldenComplexityShapeSchema = z.enum([
  "smooth-progression",
  "steep-progression",
  "prerequisite-heavy",
  "abstraction-heavy",
]);

export const GoldenDensityTargetsSchema = z.object({
  code: z.number().min(0).max(1),
  diagram: z.number().min(0).max(1),
  exercise: z.number().min(0).max(1),
  interaction: z.number().min(0).max(1),
  explanation: z.number().min(0).max(1),
});

export const GoldenDatasetExampleSchema = z.object({
  id: z.string(),
  label: z.string(),
  topicType: GoldenTopicTypeSchema,
  audienceShape: GoldenAudienceShapeSchema,
  teachingStyle: GoldenTeachingStyleSchema,
  durationBand: GoldenDurationBandSchema,
  complexityShape: GoldenComplexityShapeSchema,
  recommendedMode: AudienceStrategySchema.shape.mode,
  targetDensities: GoldenDensityTargetsSchema,
  recommendedStructure: z.array(z.string()).min(1),
  antiPatterns: z.array(z.string()).min(1),
});

export const PedagogicalStrategySelectionSchema = z.object({
  datasetVersion: z.string(),
  selectedExampleIds: z.array(z.string()).min(1),
  topicType: GoldenTopicTypeSchema,
  audienceShape: GoldenAudienceShapeSchema,
  teachingStyle: GoldenTeachingStyleSchema,
  durationBand: GoldenDurationBandSchema,
  complexityShape: GoldenComplexityShapeSchema,
  recommendedMode: AudienceStrategySchema.shape.mode,
  targetDensities: GoldenDensityTargetsSchema,
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
  scoreBreakdown: z.object({
    bestMatch: z.number().min(0).max(1),
    secondMatch: z.number().min(0).max(1),
    thirdMatch: z.number().min(0).max(1),
  }),
  warnings: z.array(z.string()).default([]),
});

export const CriticReviewSchema = z.object({
  critic: z.enum(["technical", "pedagogical", "timing", "consistency", "diagram", "retrieval"]),
  verdict: z.enum(["pass", "warn", "fail"]),
  findings: z.array(z.string()).default([]),
  suggestedFixes: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

export const ValidationIssueSchema = z.object({
  stage: z.enum([
    "structural",
    "logical",
    "technical",
    "pedagogy",
    "temporal",
    "consistency",
    "schema",
    "timing",
    "retrieval",
    "diagram",
  ]),
  severity: z.enum(["info", "warning", "error"]),
  message: z.string(),
});

export const CriticReportSchema = z.object({
  critic: z.enum([
    "technical",
    "pedagogical",
    "timing",
    "consistency",
    "diagram",
    "retrieval",
    "structural",
    "logical",
  ]),
  score: z.number().int().min(0).max(100),
  confidence: z.number().min(0).max(1),
  passed: z.boolean(),
  findings: z.array(z.string()).default([]),
});

export const ValidationBreakdownSchema = z.object({
  structural: z.object({
    requiredArtifactCoverage: z.number().min(0).max(1),
    schemaPassRate: z.number().min(0).max(1),
    emptySectionRatio: z.number().min(0).max(1),
  }).optional(),
  logical: z.object({
    prerequisiteOrderCoverage: z.number().min(0).max(1),
    cyclicDependencyCount: z.number().int().min(0),
  }).optional(),
  technical: z.object({
    codeSnippetCount: z.number().int().min(0),
    codeExecutionPassRate: z.number().min(0).max(1),
    stackMentionCoverage: z.number().min(0).max(1),
    referenceCoverage: z.number().min(0).max(1),
    implementationSpecificity: z.number().min(0).max(1),
    apiSurfaceCoverage: z.number().min(0).max(1),
    debugRealism: z.number().min(0).max(1),
  }),
  pedagogy: z.object({
    beginnerLayerCoverage: z.number().min(0).max(1),
    advancedLayerCoverage: z.number().min(0).max(1),
    interactionCoverage: z.number().min(0).max(1),
    objectiveCoverage: z.number().min(0).max(1),
    placeholderDensity: z.number().min(0).max(1),
    cognitiveProgression: z.number().min(0).max(1),
    abstractionDepth: z.number().min(0).max(1),
    advancedRealism: z.number().min(0).max(1),
  }),
  retrieval: z.object({
    moduleGroundingCoverage: z.number().min(0).max(1),
    sourceTraceability: z.number().min(0).max(1),
    officialSourceCoverage: z.number().min(0).max(1),
  }).optional(),
  timing: z.object({
    requestedMinutes: z.number().min(0),
    estimatedMinutes: z.number().min(0),
    deltaMinutes: z.number().min(0),
    withinTolerance: z.boolean(),
    checkpointCount: z.number().int().min(0),
  }),
  consistency: z.object({
    terminologyCoverage: z.number().min(0).max(1),
    contradictionCount: z.number().int().min(0),
    duplicateConceptRatio: z.number().min(0).max(1),
  }).optional(),
  strategy: z.object({
    alignmentScore: z.number().min(0).max(1),
    codeDensityDelta: z.number().min(0),
    diagramDensityDelta: z.number().min(0),
    exerciseDensityDelta: z.number().min(0),
    interactionDensityDelta: z.number().min(0),
    explanationDensityDelta: z.number().min(0),
  }).optional(),
});

export const HumanReviewSchema = z.object({
  required: z.boolean(),
  reasons: z.array(z.string()).default([]),
  question: z.string(),
  approved: z.boolean().nullable().default(null),
});

export const ValidationReportSchema = z.object({
  passed: z.boolean(),
  confidence: z.number().min(0).max(1).default(0),
  structuralScore: z.number().int().min(0).max(100).default(0),
  logicalScore: z.number().int().min(0).max(100).default(0),
  technicalScore: z.number().int().min(0).max(100),
  pedagogyScore: z.number().int().min(0).max(100),
  timingScore: z.number().int().min(0).max(100),
  consistencyScore: z.number().int().min(0).max(100).default(0),
  classroomReadinessScore: z.number().int().min(0).max(100),
  estimatedDurationMinutes: z.number().min(0),
  criticReports: z.array(CriticReportSchema).default([]),
  revisionsApplied: z.array(z.string()).default([]),
  scoreRationale: z.array(z.string()).default([]),
  breakdown: ValidationBreakdownSchema.optional(),
  humanReview: HumanReviewSchema,
  issues: z.array(ValidationIssueSchema),
});

export const TraceEventSchema = z.object({
  node: z.string(),
  status: z.enum(["success", "warning", "error"]),
  startedAt: z.string(),
  endedAt: z.string(),
  latencyMs: z.number(),
  confidence: z.number().min(0).max(1).optional(),
  warnings: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
  metrics: z.record(z.string(), z.number()).default({}),
});

export const InstructorPreviewSchema = z.object({
  title: z.string(),
  summary: z.string(),
  markdown: z.string(),
});

export const EvaluationUnitTypeSchema = z.enum(["paragraph", "section", "example", "exercise", "explanation"]);

export const RubricDimensionScoresSchema = z.object({
  abstractionLevel: z.number().min(0).max(1),
  prerequisiteKnowledge: z.number().min(0).max(1),
  pacingComplexity: z.number().min(0).max(1),
  terminologyDensity: z.number().min(0).max(1),
  technicalDepth: z.number().min(0).max(1),
  instructionalScaffolding: z.number().min(0).max(1),
});

export const EvaluationEvidenceSchema = z.object({
  quote: z.string().min(1),
  sectionTitle: z.string().optional(),
});

export const EvaluationUnitScoreSchema = z.object({
  unitId: z.string(),
  unitType: EvaluationUnitTypeSchema,
  text: z.string(),
  dimensionScores: RubricDimensionScoresSchema,
  beginnerAffinity: z.number().min(0).max(1),
  advancedAffinity: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvaluationEvidenceSchema).min(1).max(3),
});

export const WeightedDistributionAnalysisSchema = z.object({
  targetBeginnerPercent: z.number().min(0).max(100),
  targetAdvancedPercent: z.number().min(0).max(100),
  observedBeginnerPercent: z.number().min(0).max(100),
  observedAdvancedPercent: z.number().min(0).max(100),
  tolerancePercent: z.number().min(0).max(100),
  deviationPercent: z.number().min(0).max(100),
  withinTolerance: z.boolean(),
  overfit: z.object({
    beginnerOverfit: z.boolean(),
    advancedOverfit: z.boolean(),
  }),
});

export const PacingFeasibilitySchema = z.object({
  configuredDurationMinutes: z.number().min(0),
  estimatedTotalMinutes: z.number().min(0),
  explanationMinutes: z.number().min(0),
  exerciseMinutes: z.number().min(0),
  discussionMinutes: z.number().min(0),
  transitionOverheadMinutes: z.number().min(0),
  deltaMinutes: z.number().min(0),
  withinTolerance: z.boolean(),
  toleranceMinutes: z.number().min(0),
});

export const InclusionCoverageItemSchema = z.object({
  key: z.enum(["includeCode", "includeFlowcharts", "includeExercises", "includeCheatSheet"]),
  enabled: z.boolean(),
  present: z.boolean(),
  integrated: z.boolean(),
  appropriateForAudienceMix: z.boolean(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvaluationEvidenceSchema).default([]),
});

export const EvaluationMismatchSchema = z.object({
  severity: z.enum(["info", "warning", "error"]),
  category: z.enum(["cohort", "pacing", "inclusion", "evidence", "confidence"]),
  reason: z.string(),
  violatedDimensions: z.array(RubricDimensionScoresSchema.keyof()).default([]),
  evidence: z.array(EvaluationEvidenceSchema).min(1),
  confidence: z.number().min(0).max(1),
});

export const CorrectiveRecommendationSchema = z.object({
  priority: z.enum(["high", "medium", "low"]),
  recommendation: z.string(),
  rationale: z.string(),
  relatedMismatchIndexes: z.array(z.number().int().min(0)).default([]),
});

export const ReliabilityLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);

export const ExecutiveVerdictSchema = z.object({
  coreJudgment: z.string(),
  primaryStrengths: z.array(z.string()).default([]),
  primaryWeaknesses: z.array(z.string()).default([]),
  overallTrustLevel: ReliabilityLevelSchema,
});

export const AudienceAnalysisSchema = z.object({
  beginnerAccessibility: z.string(),
  advancedDepth: z.string(),
  hiddenPrerequisiteAssumptions: z.array(z.string()).default([]),
  cognitiveOverloadRisks: z.array(z.string()).default([]),
});

export const PacingAnalysisSchema = z.object({
  realisticEstimatedTeachingTime: z.string(),
  compressionRisks: z.array(z.string()).default([]),
  bottleneckModules: z.array(z.string()).default([]),
});

export const StructuralAnalysisSchema = z.object({
  repetitionDetection: z.string(),
  templateLeakage: z.string(),
  conceptualRedundancy: z.string(),
  transitionQuality: z.string(),
});

export const IntegrationDimensionSchema = z.object({
  present: z.boolean(),
  integrated: z.boolean(),
  pedagogicallyUseful: z.boolean(),
  audienceAligned: z.boolean(),
  notes: z.string(),
});

export const PedagogicalIntegrationAnalysisSchema = z.object({
  code: IntegrationDimensionSchema,
  exercises: IntegrationDimensionSchema,
  diagrams: IntegrationDimensionSchema,
  cheatSheet: IntegrationDimensionSchema,
  interactions: IntegrationDimensionSchema,
  debuggingScenarios: IntegrationDimensionSchema,
});

export const ContradictionAnalysisSchema = z.object({
  contradictions: z.array(z.string()).default([]),
  consistencyVerdict: z.string(),
});

export const InstructorPreviewEvaluationNarrativeSchema = z.object({
  executiveVerdict: ExecutiveVerdictSchema,
  audienceAnalysis: AudienceAnalysisSchema,
  pacingAnalysis: PacingAnalysisSchema,
  structuralAnalysis: StructuralAnalysisSchema,
  pedagogicalIntegrationAnalysis: PedagogicalIntegrationAnalysisSchema,
  contradictionAnalysis: ContradictionAnalysisSchema,
  finalReliabilityScore: ReliabilityLevelSchema,
});

export const InstructorPreviewEvaluationSchema = z.object({
  status: z.enum(["pass", "fail", "uncertain"]),
  passed: z.boolean(),
  cohortAlignmentScore: z.number().int().min(0).max(100),
  confidence: z.number().min(0).max(1),
  weightedDistribution: WeightedDistributionAnalysisSchema,
  pacingFeasibility: PacingFeasibilitySchema,
  inclusionCoverage: z.array(InclusionCoverageItemSchema),
  unitScores: z.array(EvaluationUnitScoreSchema).min(1),
  mismatches: z.array(EvaluationMismatchSchema),
  recommendations: z.array(CorrectiveRecommendationSchema),
  narrative: InstructorPreviewEvaluationNarrativeSchema,
  deterministicChecks: z.array(z.string()).default([]),
  uncertainReasons: z.array(z.string()).default([]),
  createdAt: z.string(),
});

export const IntermediateArtifactsSchema = z.object({
  retrieval: RetrievalArtifactSchema.optional(),
  decomposition: TopicDecompositionSchema.optional(),
  audienceStrategy: AudienceStrategySchema.optional(),
  strategySelection: PedagogicalStrategySelectionSchema.optional(),
  artifactPlan: ArtifactPlanSchema.optional(),
  diagramSnippets: z.array(CodeSnippetSchema).default([]),
  criticReviews: z.array(CriticReviewSchema).default([]),
  validationTraces: z.array(z.string()).default([]),
});

export const PipelineRunOptionsSchema = z.object({
  enableLlm: z.boolean().default(true),
  maxNodeRetries: z.number().int().min(0).max(3).default(0),
  regenerateStages: z.array(PipelineStageSchema).default([]),
  reuseArtifacts: IntermediateArtifactsSchema.partial().optional(),
}).default({
  enableLlm: true,
  maxNodeRetries: 0,
  regenerateStages: [],
});

export const PipelineResultSchema = z.object({
  requestId: z.string(),
  brief: BriefInputSchema,
  plan: CurriculumPlanSchema,
  generation: GenerationOutputSchema,
  validation: ValidationReportSchema,
  preview: InstructorPreviewSchema,
  traces: z.array(TraceEventSchema),
  nodeExecutions: z.array(NodeExecutionSchema).default([]),
  artifacts: IntermediateArtifactsSchema.default({
    diagramSnippets: [],
    criticReviews: [],
    validationTraces: [],
  }),
  escalations: z.array(z.string()).default([]),
  createdAt: z.string(),
});

export const PipelineRequestSchema = z.object({
  brief: BriefInputSchema,
  options: PipelineRunOptionsSchema.optional(),
});

export const InstructorPreviewEvaluationRequestSchema = z.object({
  brief: BriefInputSchema,
  preview: InstructorPreviewSchema,
});

export type BriefInput = z.infer<typeof BriefInputSchema>;
export type PipelineStage = z.infer<typeof PipelineStageSchema>;
export type NodeExecution = z.infer<typeof NodeExecutionSchema>;
export type CurriculumModule = z.infer<typeof CurriculumModuleSchema>;
export type CurriculumPlan = z.infer<typeof CurriculumPlanSchema>;
export type ScriptSection = z.infer<typeof ScriptSectionSchema>;
export type CodeSnippet = z.infer<typeof CodeSnippetSchema>;
export type Exercise = z.infer<typeof ExerciseSchema>;
export type GenerationOutput = z.infer<typeof GenerationOutputSchema>;
export type RetrievedSource = z.infer<typeof RetrievedSourceSchema>;
export type RetrievalArtifact = z.infer<typeof RetrievalArtifactSchema>;
export type TopicDecomposition = z.infer<typeof TopicDecompositionSchema>;
export type AudienceStrategy = z.infer<typeof AudienceStrategySchema>;
export type ArtifactPlan = z.infer<typeof ArtifactPlanSchema>;
export type GoldenDatasetExample = z.infer<typeof GoldenDatasetExampleSchema>;
export type PedagogicalStrategySelection = z.infer<typeof PedagogicalStrategySelectionSchema>;
export type CriticReview = z.infer<typeof CriticReviewSchema>;
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;
export type ValidationReport = z.infer<typeof ValidationReportSchema>;
export type ValidationBreakdown = z.infer<typeof ValidationBreakdownSchema>;
export type CriticReport = z.infer<typeof CriticReportSchema>;
export type HumanReview = z.infer<typeof HumanReviewSchema>;
export type TraceEvent = z.infer<typeof TraceEventSchema>;
export type InstructorPreview = z.infer<typeof InstructorPreviewSchema>;
export type IntermediateArtifacts = z.infer<typeof IntermediateArtifactsSchema>;
export type PipelineRunOptions = z.infer<typeof PipelineRunOptionsSchema>;
export type PipelineResult = z.infer<typeof PipelineResultSchema>;
export type EvaluationUnitType = z.infer<typeof EvaluationUnitTypeSchema>;
export type RubricDimensionScores = z.infer<typeof RubricDimensionScoresSchema>;
export type EvaluationEvidence = z.infer<typeof EvaluationEvidenceSchema>;
export type EvaluationUnitScore = z.infer<typeof EvaluationUnitScoreSchema>;
export type WeightedDistributionAnalysis = z.infer<typeof WeightedDistributionAnalysisSchema>;
export type PacingFeasibility = z.infer<typeof PacingFeasibilitySchema>;
export type InclusionCoverageItem = z.infer<typeof InclusionCoverageItemSchema>;
export type EvaluationMismatch = z.infer<typeof EvaluationMismatchSchema>;
export type CorrectiveRecommendation = z.infer<typeof CorrectiveRecommendationSchema>;
export type InstructorPreviewEvaluation = z.infer<typeof InstructorPreviewEvaluationSchema>;
export type InstructorPreviewEvaluationRequest = z.infer<typeof InstructorPreviewEvaluationRequestSchema>;
export type ReliabilityLevel = z.infer<typeof ReliabilityLevelSchema>;
export type ExecutiveVerdict = z.infer<typeof ExecutiveVerdictSchema>;
export type AudienceAnalysis = z.infer<typeof AudienceAnalysisSchema>;
export type PacingAnalysis = z.infer<typeof PacingAnalysisSchema>;
export type StructuralAnalysis = z.infer<typeof StructuralAnalysisSchema>;
export type IntegrationDimension = z.infer<typeof IntegrationDimensionSchema>;
export type PedagogicalIntegrationAnalysis = z.infer<typeof PedagogicalIntegrationAnalysisSchema>;
export type ContradictionAnalysis = z.infer<typeof ContradictionAnalysisSchema>;
export type InstructorPreviewEvaluationNarrative = z.infer<typeof InstructorPreviewEvaluationNarrativeSchema>;
