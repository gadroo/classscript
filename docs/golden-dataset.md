# Golden Dataset and Strategy Methodology

## Where is the golden dataset?

- Dataset file: `apps/api/src/pipeline/data/golden-pedagogy-dataset.ts`
- Selector engine: `apps/api/src/pipeline/strategy-selection.ts`
- Dataset contracts: `packages/schemas/src/index.ts` (`GoldenDatasetExampleSchema`, `PedagogicalStrategySelectionSchema`)

## Inputs

Runtime API input (`POST /v1/pipeline/run`) accepts:

- `brief.topic`
- `brief.durationMinutes`
- `brief.audience.beginnerPercent`
- `brief.audience.advancedPercent`
- `brief.teachingMode`
- `brief.includeCode`
- `brief.includeFlowcharts`
- `brief.includeExercises`
- `brief.includeCheatSheet`
- `brief.targetStack.language`
- `brief.targetStack.runtime`
- `brief.targetStack.frameworks`
- optional `brief.styleNotes`
- optional run controls in `options`

Golden-strategy selection uses these runtime inputs plus generated decomposition/audience artifacts:

- `artifacts.decomposition` (concept list, difficulty, prerequisites)
- `artifacts.audienceStrategy` (instability/divergence/mode)

## Write Outputs

The system writes (in pipeline state and API response payload):

- `artifacts.strategySelection`:
  - `datasetVersion`
  - selected example ids
  - inferred dimensions (topic type, audience shape, duration band, complexity shape, teaching style)
  - recommended mode
  - target density profile (code/diagram/exercise/interaction/explanation)
  - confidence and score breakdown
- `artifacts.artifactPlan` blended with strategy target densities
- `validation.breakdown.strategy` alignment metrics
- `nodeExecutions[].validationTraces` including strategy alignment

Current MVP does not persist to DB; output is returned by API and traceable per request.

## How we validate

Validation is multi-layer and score-derived (not self-reported):

- Structural: required artifacts, non-empty sections
- Logical: prerequisite order coverage
- Technical: snippet execution pass rate
- Diagram: Mermaid syntax precheck
- Retrieval: grounded reference coverage
- Pedagogy: layer/interactions/objective coverage + placeholder detection
- Timing: estimated vs requested duration
- Consistency: stack terminology + duplicate density
- Strategy alignment: compares actual generated densities to selected golden target profile

Strategy alignment emits deltas:

- code density delta
- diagram density delta
- exercise density delta
- interaction density delta
- explanation density delta

Low strategy alignment raises warnings and can require manual review.

## Methodology

1. Classify request + decomposition into strategy signals.
2. Score all golden dataset examples by weighted multi-factor similarity.
3. Select top matches and blend target densities.
4. Blend these densities into artifact planning.
5. Generate outputs.
6. Validate outputs across all layers including strategy alignment.
7. Compute readiness/confidence and enforce human-review escalation when needed.

This is a deterministic, traceable orchestration flow with optional LLM assists per stage.
