import type { NodeExecution, PipelineStage, TraceEvent } from "@curriculum/schemas";

export function nowIso(): string {
  return new Date().toISOString();
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function safeDivide(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 1;
  }
  return numerator / denominator;
}

function toTraceStatus(status: NodeExecution["status"]): TraceEvent["status"] {
  if (status === "error") {
    return "error";
  }
  if (status === "warning") {
    return "warning";
  }
  return "success";
}

export function buildNodeExecution(params: {
  node: PipelineStage;
  status: NodeExecution["status"];
  startedAt: string;
  attempt?: number;
  retries?: number;
  confidence?: number;
  warnings?: string[];
  errors?: string[];
  metrics?: Record<string, number>;
  logs?: string[];
  inputArtifacts?: string[];
  outputArtifacts?: string[];
  validationTraces?: string[];
  model?: string;
}): NodeExecution {
  const endedAt = nowIso();
  return {
    node: params.node,
    status: params.status,
    attempt: params.attempt ?? 1,
    retries: params.retries ?? 0,
    startedAt: params.startedAt,
    endedAt,
    latencyMs: Math.max(0, Date.parse(endedAt) - Date.parse(params.startedAt)),
    confidence: params.confidence,
    warnings: params.warnings ?? [],
    errors: params.errors ?? [],
    metrics: params.metrics ?? {},
    logs: params.logs ?? [],
    inputArtifacts: params.inputArtifacts ?? [],
    outputArtifacts: params.outputArtifacts ?? [],
    validationTraces: params.validationTraces ?? [],
    model: params.model,
  };
}

export function toTrace(execution: NodeExecution): TraceEvent {
  return {
    node: execution.node,
    status: toTraceStatus(execution.status),
    startedAt: execution.startedAt,
    endedAt: execution.endedAt,
    latencyMs: execution.latencyMs,
    confidence: execution.confidence,
    warnings: execution.warnings,
    errors: execution.errors,
    metrics: execution.metrics,
  };
}

export function buildTrace(params: {
  node: PipelineStage;
  startedAt: string;
  status: TraceEvent["status"];
  confidence?: number;
  warnings?: string[];
  errors?: string[];
  metrics?: Record<string, number>;
}): TraceEvent {
  const endedAt = nowIso();
  return {
    node: params.node,
    status: params.status,
    startedAt: params.startedAt,
    endedAt,
    latencyMs: Math.max(0, Date.parse(endedAt) - Date.parse(params.startedAt)),
    confidence: params.confidence,
    warnings: params.warnings ?? [],
    errors: params.errors ?? [],
    metrics: params.metrics ?? {},
  };
}

export function shouldReuseStage(regenerateStages: PipelineStage[], stage: PipelineStage): boolean {
  return !regenerateStages.includes(stage);
}

export async function runWithRetry<T>(
  op: (attempt: number) => Promise<T>,
  maxRetries: number,
): Promise<{ value: T; attempts: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    try {
      const value = await op(attempt);
      return { value, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt > maxRetries) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unknown retry error");
}

export function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase().replace(/\s+/g, " ");
}
