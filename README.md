# Curriculum OS (MVP)

TypeScript monorepo for an AI-native curriculum generation pipeline.

## Apps

- `apps/api`: Fastify + LangGraph JS orchestration API
- `apps/web`: Next.js instructor preview UI

## Shared Packages

- `packages/schemas`: zod contracts for request/state/artifacts
- `packages/prompts`: versioned prompt templates
- `packages/rendering`: markdown/preview assembly

## Orchestration Pipeline

`brief -> retrieval -> decomposition -> audience -> artifact_planning -> planning -> generation -> diagram -> critique -> validation -> rendering`

Each node emits:

- typed contracts
- node execution logs
- metrics
- confidence
- warnings/errors
- validation traces
- retry metadata

The graph is deterministic and supports partial regeneration by stage.

## Golden Dataset

Part 23 is implemented with:

- dataset: `apps/api/src/pipeline/data/golden-pedagogy-dataset.ts`
- selector: `apps/api/src/pipeline/strategy-selection.ts`
- output artifact: `artifacts.strategySelection`

See: `docs/golden-dataset.md`.

## Python Policy (v1)

Python is intentionally excluded from runtime in v1.

`apps/api/src/pipeline/engines/code-execution.ts` defines:

- `NodeCodeExecutionEngine` (active)
- `PythonCodeExecutionEnginePlaceholder` (extension seam)

Promote Python only when measured bottlenecks justify it.

## Run

```bash
pnpm install
pnpm build
```

Start API:

```bash
OPENROUTER_API_KEY=your_key_here \
CURRICULUM_MODEL=openai/gpt-4.1 \
pnpm --filter @curriculum/api dev
```

Optional LLM env vars:

```bash
CURRICULUM_LLM_BASE_URL=https://openrouter.ai/api/v1
CURRICULUM_APP_ORIGIN=http://localhost:4000
CURRICULUM_APP_TITLE=curriculum-os
```

Start web:

```bash
pnpm --filter @curriculum/web dev
```

Web expects API at `http://localhost:4000` by default. Override with:

```bash
NEXT_PUBLIC_API_URL=http://localhost:4000
```

For deployed web previews, set:

```bash
CURRICULUM_API_URL=https://<your-api-host>
```

The web app now calls same-origin `/api/v1/*` proxy routes, which forward to `CURRICULUM_API_URL`.

## API

`POST /v1/pipeline/run`

Example payload:

```json
{
  "brief": {
    "topic": "LLM Memory",
    "durationMinutes": 120,
    "audience": { "beginnerPercent": 40, "advancedPercent": 60 },
    "teachingMode": "mixed",
    "includeCode": true,
    "includeFlowcharts": true,
    "includeExercises": true,
    "includeCheatSheet": true,
    "targetStack": {
      "language": "typescript",
      "runtime": "node@22",
      "frameworks": ["LangGraph", "OpenAI"]
    },
    "styleNotes": "Emphasize practical examples"
  }
}
```

Optional run controls:

```json
{
  "options": {
    "enableLlm": true,
    "maxNodeRetries": 2,
    "regenerateStages": ["generation", "diagram", "validation"],
    "reuseArtifacts": {
      "retrieval": { "...": "previous retrieval artifact" },
      "decomposition": { "...": "previous decomposition artifact" }
    }
  }
}
```
