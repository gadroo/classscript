import type { BriefInput, CurriculumPlan, GenerationOutput, ValidationReport } from "@curriculum/schemas";

function formatModuleTable(plan: CurriculumPlan): string {
  const header = "| Module | Objective | Minutes | Difficulty |\n|---|---|---:|---:|";
  const rows = plan.modules.map(
    (module) =>
      `| ${module.title} | ${module.objective} | ${module.estimatedMinutes} | ${Math.round(module.difficulty * 100)}% |`,
  );
  return [header, ...rows].join("\n");
}

export function buildInstructorMarkdown(
  brief: BriefInput,
  plan: CurriculumPlan,
  generation: GenerationOutput,
  validation: ValidationReport,
): string {
  const sections = generation.scriptSections
    .map((section, index) => {
      const claims = section.groundedClaims.map((claim) => `- ${claim.claim} ([${claim.sourceTitle}](${claim.sourceUrl}))`).join("\n");
      const debugScenario = [
        `- Symptom: ${section.debugScenario.symptom}`,
        `- Likely root cause: ${section.debugScenario.likelyRootCause}`,
        `- Reproduction: ${section.debugScenario.reproductionSteps.join(" | ")}`,
        `- Investigation: ${section.debugScenario.investigationSteps.join(" | ")}`,
        `- Fix: ${section.debugScenario.fixSummary}`,
        `- Verify: ${section.debugScenario.verificationChecks.join(" | ")}`,
      ].join("\n");
      const artifact = [
        `- Type: ${section.implementationArtifact.artifactType}`,
        `- Files: ${section.implementationArtifact.files.join(", ")}`,
        `- APIs: ${section.implementationArtifact.stackApis.join(", ")}`,
        `- Acceptance: ${section.implementationArtifact.acceptanceCriteria.join(" | ")}`,
      ].join("\n");
      return [
        `### ${index + 1}. ${plan.modules.find((module) => module.id === section.moduleId)?.title ?? section.moduleId}`,
        section.narration,
        `**Beginner layer:** ${section.beginnerLayer}`,
        `**Advanced layer:** ${section.advancedLayer}`,
        `**Cognitive bridge:** ${section.cognitiveBridge}`,
        `**Abstraction shift:** ${section.abstractionShift}`,
        `**Interaction:** ${section.interactionPrompt}`,
        `**Transition:** ${section.transition}`,
        "**Implementation artifact:**",
        artifact,
        "**Debug scenario:**",
        debugScenario,
        "**Grounded claims:**",
        claims,
      ].join("\n\n");
    })
    .join("\n\n");

  const snippets = generation.codeSnippets
    .map((snippet) => [
      `#### ${snippet.title}`,
      snippet.description,
      "```" + snippet.language,
      snippet.code,
      "```",
    ].join("\n"))
    .join("\n\n");

  const exercises = generation.exercises
    .map((exercise) => `- **${exercise.title}** (${exercise.difficulty}): ${exercise.prompt}`)
    .join("\n");

  const validationIssues = validation.issues.length
    ? validation.issues.map((issue) => `- [${issue.stage}] (${issue.severity}) ${issue.message}`).join("\n")
    : "No validation issues detected.";

  const validationBreakdown = validation.breakdown
    ? [
      `- Structural score: ${validation.structuralScore}/100`,
      `- Logical score: ${validation.logicalScore}/100`,
      `- Code execution pass rate: ${Math.round(validation.breakdown.technical.codeExecutionPassRate * 100)}%`,
      `- Stack mention coverage: ${Math.round(validation.breakdown.technical.stackMentionCoverage * 100)}%`,
      `- Implementation specificity: ${Math.round(validation.breakdown.technical.implementationSpecificity * 100)}%`,
      `- API surface coverage: ${Math.round(validation.breakdown.technical.apiSurfaceCoverage * 100)}%`,
      `- Debug realism: ${Math.round(validation.breakdown.technical.debugRealism * 100)}%`,
      `- Beginner layer coverage: ${Math.round(validation.breakdown.pedagogy.beginnerLayerCoverage * 100)}%`,
      `- Advanced layer coverage: ${Math.round(validation.breakdown.pedagogy.advancedLayerCoverage * 100)}%`,
      `- Cognitive progression: ${Math.round(validation.breakdown.pedagogy.cognitiveProgression * 100)}%`,
      `- Abstraction depth: ${Math.round(validation.breakdown.pedagogy.abstractionDepth * 100)}%`,
      `- Advanced realism: ${Math.round(validation.breakdown.pedagogy.advancedRealism * 100)}%`,
      `- Interaction coverage: ${Math.round(validation.breakdown.pedagogy.interactionCoverage * 100)}%`,
      `- Source traceability: ${Math.round((validation.breakdown.retrieval?.sourceTraceability ?? 0) * 100)}%`,
      `- Timing delta: ${Math.round(validation.breakdown.timing.deltaMinutes)} minute(s)`,
      `- Consistency score: ${validation.consistencyScore}/100`,
    ].join("\n")
    : "No breakdown available.";

  const scoreRationale = validation.scoreRationale.length
    ? validation.scoreRationale.map((line) => `- ${line}`).join("\n")
    : "No scoring rationale provided.";

  const references = generation.references.length
    ? generation.references.map((reference) => `- ${reference}`).join("\n")
    : "No references available.";

  const critics = validation.criticReports.length
    ? validation.criticReports
      .map((critic) => `- ${critic.critic}: ${critic.score}/100 (${critic.passed ? "pass" : "review"})`)
      .join("\n")
    : "No critic reports available.";

  const revisionSummary = validation.revisionsApplied.length
    ? validation.revisionsApplied.map((item) => `- ${item}`).join("\n")
    : "No automatic revisions were applied.";

  const humanReview = validation.humanReview.required
    ? [
      "- Required: yes",
      `- Question: ${validation.humanReview.question}`,
      ...(validation.humanReview.reasons.length
        ? validation.humanReview.reasons.map((reason) => `- Reason: ${reason}`)
        : []),
    ].join("\n")
    : "- Required: no";

  return [
    `# ${brief.topic} Instructor Preview`,
    `Duration: ${brief.durationMinutes} minutes`,
    `Audience: ${brief.audience.beginnerPercent}% beginner / ${brief.audience.advancedPercent}% advanced`,
    "## Curriculum Plan",
    formatModuleTable(plan),
    "## Script",
    sections,
    "## Code",
    snippets || "No code snippets requested.",
    "## Exercises",
    exercises || "No exercises requested.",
    "## Cheat Sheet",
    generation.cheatSheet.length ? generation.cheatSheet.map((item) => `- ${item}`).join("\n") : "No cheat sheet requested.",
    "## References",
    references,
  ].join("\n\n");
}

export function buildInstructorSummary(brief: BriefInput, validation: ValidationReport): string {
  const readinessBand = validation.classroomReadinessScore >= 90
    ? "high"
    : validation.classroomReadinessScore >= 75
      ? "moderate"
      : "low";
  const issueCounts = {
    errors: validation.issues.filter((issue) => issue.severity === "error").length,
    warnings: validation.issues.filter((issue) => issue.severity === "warning").length,
  };
  const weakestAreas = [
    { label: "structural", score: validation.structuralScore },
    { label: "logical", score: validation.logicalScore },
    { label: "technical", score: validation.technicalScore },
    { label: "pedagogy", score: validation.pedagogyScore },
    { label: "timing", score: validation.timingScore },
    { label: "consistency", score: validation.consistencyScore },
  ]
    .sort((a, b) => a.score - b.score)
    .slice(0, 2)
    .map((item) => `${item.label} ${item.score}/100`)
    .join(", ");
  const stackCoverage = validation.breakdown?.technical.stackMentionCoverage;
  const timingDelta = validation.breakdown?.timing.deltaMinutes;
  const strategyAlignment = validation.breakdown?.strategy?.alignmentScore;
  const leadIssue = validation.issues[0]?.message;
  const inclusionSummary = [
    `code:${brief.includeCode ? "on" : "off"}`,
    `diagrams:${brief.includeFlowcharts ? "on" : "off"}`,
    `exercises:${brief.includeExercises ? "on" : "off"}`,
    `cheat:${brief.includeCheatSheet ? "on" : "off"}`,
  ].join(", ");

  return [
    `Built for ${brief.topic} (${brief.durationMinutes} minutes, mode ${brief.teachingMode}).`,
    `Config: beginner ${brief.audience.beginnerPercent}% / advanced ${brief.audience.advancedPercent}%; ${inclusionSummary}.`,
    `Readiness ${validation.classroomReadinessScore}/100 (${readinessBand}) with ${issueCounts.errors} error(s) and ${issueCounts.warnings} warning(s).`,
    validation.passed ? "All hard validation gates passed." : "One or more hard validation gates failed.",
    `Weakest areas: ${weakestAreas}.`,
    stackCoverage !== undefined ? `Stack coverage ${Math.round(stackCoverage * 100)}%.` : null,
    timingDelta !== undefined ? `Timing delta ${Math.round(timingDelta)} minute(s).` : null,
    strategyAlignment !== undefined ? `Strategy alignment ${Math.round(strategyAlignment * 100)}%.` : null,
    leadIssue ? `Top issue: ${leadIssue}` : null,
    validation.humanReview.required
      ? `Human review required: ${validation.humanReview.reasons[0] ?? "confidence or policy gate triggered."}`
      : "No human review required.",
  ].filter(Boolean).join(" ");
}
