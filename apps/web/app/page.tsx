"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  InstructorPreviewEvaluationSchema,
  PipelineResultSchema,
  type BriefInput,
  type InstructorPreviewEvaluation,
  type PipelineResult,
  type TraceEvent,
} from "@curriculum/schemas";

type RunStatus = "idle" | "running" | "failed";
type EvaluationStatus = "idle" | "running" | "failed";

const PIPELINE_REQUEST_TIMEOUT_MS = 90000;

const initialBrief: BriefInput = {
  topic: "LLM Memory",
  durationMinutes: 120,
  audience: {
    beginnerPercent: 40,
    advancedPercent: 60,
  },
  teachingMode: "mixed",
  includeCode: true,
  includeFlowcharts: true,
  includeExercises: true,
  includeCheatSheet: true,
  targetStack: {
    language: "typescript",
    runtime: "node@22",
    frameworks: ["LangGraph", "OpenAI"],
  },
  styleNotes: "Emphasize practical examples and transitions.",
};

const topicPresets = ["LLM Memory", "RAG Fundamentals", "Prompt Engineering", "Agentic Workflows"];

function toUserFacingError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }
  if (error.name === "AbortError") {
    return "Pipeline request timed out. Check API/LLM connectivity and try again.";
  }
  if (error.message === "Failed to fetch") {
    return "Network request failed. Verify CURRICULUM_API_URL is configured in Vercel and the API service is reachable.";
  }
  return error.message || fallback;
}

export default function HomePage() {
  const [brief, setBrief] = useState(initialBrief);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [evaluation, setEvaluation] = useState<InstructorPreviewEvaluation | null>(null);
  const [evaluationStatus, setEvaluationStatus] = useState<EvaluationStatus>("idle");
  const [evaluationError, setEvaluationError] = useState<string | null>(null);
  const [isTraceExpanded, setIsTraceExpanded] = useState(false);

  const advancedPercent = 100 - brief.audience.beginnerPercent;

  async function runPipeline() {
    setStatus("running");
    setError(null);
    setEvaluation(null);
    setEvaluationError(null);
    setEvaluationStatus("idle");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PIPELINE_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch("/api/v1/pipeline/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({ brief }),
      });

      if (!response.ok) {
        const payload = await response.text();
        let message = payload || "Pipeline request failed";
        try {
          const parsed = JSON.parse(payload) as { error?: string };
          if (parsed.error) {
            message = parsed.error;
          }
        } catch {
          // Preserve raw payload when it is not JSON.
        }
        throw new Error(message);
      }

      const payload = await response.json();
      const parsed = PipelineResultSchema.parse(payload);
      setResult(parsed);
      setStatus("idle");
    } catch (runError) {
      setError(toUserFacingError(runError, "Unknown error"));
      setStatus("failed");
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function evaluatePreview() {
    if (!result) {
      return;
    }

    setEvaluationStatus("running");
    setEvaluationError(null);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PIPELINE_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch("/api/v1/pipeline/evaluate-preview", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          brief: result.brief,
          preview: result.preview,
        }),
      });

      if (!response.ok) {
        const payload = await response.text();
        let message = payload || "Preview evaluation request failed";
        try {
          const parsed = JSON.parse(payload) as { error?: string };
          if (parsed.error) {
            message = parsed.error;
          }
        } catch {
          // Preserve raw payload when it is not JSON.
        }
        throw new Error(message);
      }

      const payload = await response.json();
      const parsed = InstructorPreviewEvaluationSchema.parse(payload);
      setEvaluation(parsed);
      setEvaluationStatus("idle");
    } catch (runError) {
      setEvaluationError(toUserFacingError(runError, "Unknown evaluation error"));
      setEvaluationStatus("failed");
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function setBeginnerPercent(value: number) {
    const bounded = Math.max(0, Math.min(100, value));
    setBrief((prev) => ({
      ...prev,
      audience: {
        beginnerPercent: bounded,
        advancedPercent: 100 - bounded,
      },
    }));
  }

  function setDuration(value: number) {
    const bounded = Math.max(15, Math.min(480, value || 15));
    setBrief((prev) => ({ ...prev, durationMinutes: bounded }));
  }

  function toggleFlag(key: "includeCode" | "includeFlowcharts" | "includeExercises" | "includeCheatSheet") {
    setBrief((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function resetBrief() {
    setBrief(initialBrief);
    setError(null);
  }


  return (
    <main className="app-shell">
      <section className="hero">
        <nav className="top-nav">
          <div className="brand">
            <span className="brand-mark">CO</span>
            <div>
              <p className="eyebrow">AI Curriculum Studio</p>
              <strong>Instructor Preview Builder</strong>
            </div>
          </div>
          <span className={`status ${status}`}>{status === "running" ? "Running" : "Ready"}</span>
        </nav>
        <div className="hero-copy">
          <h1>Build an instructor-ready lesson plan in one run.</h1>
          <p>
            Configure audience, delivery mode, and output format, then generate a validated preview with traceable pipeline diagnostics.
          </p>
        </div>
      </section>

      <section className="workspace">
        <section className="panel form-panel">
          <div className="section-head">
            <h2>Brief Configuration</h2>
            <p>Set your teaching intent before running generation.</p>
          </div>

          <div className="block">
            <label htmlFor="topic">Topic</label>
            <input
              id="topic"
              value={brief.topic}
              onChange={(event) => setBrief((prev) => ({ ...prev, topic: event.target.value }))}
              placeholder="e.g. LLM Memory Systems"
            />
            <div className="chip-row">
              {topicPresets.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="chip"
                  onClick={() => setBrief((prev) => ({ ...prev, topic: preset }))}
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>

          <div className="grid two">
            <div className="block">
              <label htmlFor="duration">Duration (minutes)</label>
              <div className="inline-control">
                <input
                  id="duration"
                  type="range"
                  min={15}
                  max={480}
                  step={15}
                  value={brief.durationMinutes}
                  onChange={(event) => setDuration(Number(event.target.value))}
                />
                <input
                  type="number"
                  min={15}
                  max={480}
                  step={15}
                  value={brief.durationMinutes}
                  onChange={(event) => setDuration(Number(event.target.value))}
                />
              </div>
            </div>

            <div className="block">
              <label htmlFor="mode">Teaching Mode</label>
              <select
                id="mode"
                value={brief.teachingMode}
                onChange={(event) =>
                  setBrief((prev) => ({
                    ...prev,
                    teachingMode: event.target.value as BriefInput["teachingMode"],
                  }))
                }
              >
                <option value="mixed">Mixed</option>
                <option value="beginner-dominant">Beginner Dominant</option>
                <option value="advanced-dominant">Advanced Dominant</option>
                <option value="segmented">Segmented</option>
              </select>
            </div>
          </div>

          <div className="block">
            <label>Audience Split</label>
            <input
              type="range"
              min={0}
              max={100}
              value={brief.audience.beginnerPercent}
              onChange={(event) => setBeginnerPercent(Number(event.target.value))}
            />
            <div className="split">
              <span>Beginner: {brief.audience.beginnerPercent}%</span>
              <span>Advanced: {advancedPercent}%</span>
            </div>
          </div>

          <div className="grid two">
            <div className="block">
              <label htmlFor="language">Language</label>
              <input
                id="language"
                value={brief.targetStack.language}
                onChange={(event) =>
                  setBrief((prev) => ({
                    ...prev,
                    targetStack: { ...prev.targetStack, language: event.target.value },
                  }))
                }
              />
            </div>
            <div className="block">
              <label htmlFor="runtime">Runtime</label>
              <input
                id="runtime"
                value={brief.targetStack.runtime}
                onChange={(event) =>
                  setBrief((prev) => ({
                    ...prev,
                    targetStack: { ...prev.targetStack, runtime: event.target.value },
                  }))
                }
              />
            </div>
          </div>

          <div className="block">
            <label>Output Inclusions</label>
            <div className="toggle-grid">
              <ToggleCard label="Code Snippets" checked={brief.includeCode} onClick={() => toggleFlag("includeCode")} />
              <ToggleCard
                label="Flowcharts"
                checked={brief.includeFlowcharts}
                onClick={() => toggleFlag("includeFlowcharts")}
              />
              <ToggleCard
                label="Exercises"
                checked={brief.includeExercises}
                onClick={() => toggleFlag("includeExercises")}
              />
              <ToggleCard
                label="Cheat Sheet"
                checked={brief.includeCheatSheet}
                onClick={() => toggleFlag("includeCheatSheet")}
              />
            </div>
          </div>

          <div className="block">
            <label htmlFor="notes">Style Notes</label>
            <textarea
              id="notes"
              value={brief.styleNotes ?? ""}
              maxLength={800}
              onChange={(event) => setBrief((prev) => ({ ...prev, styleNotes: event.target.value }))}
              placeholder="Tone, pacing, examples, transitions, and constraints."
            />
          </div>

          <div className="actions">
            <button className="primary" onClick={runPipeline} disabled={status === "running"}>
              {status === "running" ? "Running Pipeline..." : "Generate Instructor Preview"}
            </button>
            <button type="button" className="ghost" onClick={resetBrief} disabled={status === "running"}>
              Reset
            </button>
          </div>
          {error ? <p className="error">{error}</p> : null}
        </section>

        <aside className="panel side-panel">
          <h2>Session Snapshot</h2>
          <dl>
            <div>
              <dt>Topic</dt>
              <dd>{brief.topic}</dd>
            </div>
            <div>
              <dt>Audience</dt>
              <dd>
                {brief.audience.beginnerPercent}% Beginner / {advancedPercent}% Advanced
              </dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{brief.durationMinutes} minutes</dd>
            </div>
            <div>
              <dt>Mode</dt>
              <dd>{brief.teachingMode}</dd>
            </div>
            <div>
              <dt>Stack</dt>
              <dd>
                {brief.targetStack.language} · {brief.targetStack.runtime}
              </dd>
            </div>
          </dl>
        </aside>
      </section>

      {result ? (
        <section className="results">
          <section className="panel preview">
            <h2>{result.preview.title}</h2>
            <p>{result.preview.summary}</p>
            <article className="markdown">
              <ReactMarkdown>{result.preview.markdown}</ReactMarkdown>
            </article>
            <div className="preview-actions">
              <button
                type="button"
                className="primary"
                onClick={evaluatePreview}
                disabled={evaluationStatus === "running" || status === "running"}
              >
                {evaluationStatus === "running" ? "Evaluating..." : "Evaluate Instructor Preview"}
              </button>
            </div>
            {evaluationError ? <p className="error">{evaluationError}</p> : null}
          </section>

          {evaluation ? (
            <section className="panel evaluation-report">
              <h2>Executive Verdict</h2>
              <p>{evaluation.narrative.executiveVerdict.coreJudgment}</p>
              <p>
                Trust: <strong>{evaluation.narrative.executiveVerdict.overallTrustLevel}</strong> · Status:{" "}
                <strong>{evaluation.status.toUpperCase()}</strong>
              </p>
              <ul className="issue-list">
                {evaluation.narrative.executiveVerdict.primaryStrengths.map((item, index) => (
                  <li key={`strength-${index}`}>Strength: {item}</li>
                ))}
                {evaluation.narrative.executiveVerdict.primaryWeaknesses.map((item, index) => (
                  <li key={`weakness-${index}`}>Weakness: {item}</li>
                ))}
              </ul>

              <div className="validation-details">
                <h3>Audience Analysis</h3>
                <p>Beginner accessibility: {evaluation.narrative.audienceAnalysis.beginnerAccessibility}</p>
                <p>Advanced depth: {evaluation.narrative.audienceAnalysis.advancedDepth}</p>
                <ul className="issue-list">
                  {evaluation.narrative.audienceAnalysis.hiddenPrerequisiteAssumptions.map((item, index) => (
                    <li key={`prereq-${index}`}>{item}</li>
                  ))}
                  {evaluation.narrative.audienceAnalysis.cognitiveOverloadRisks.map((item, index) => (
                    <li key={`overload-${index}`}>{item}</li>
                  ))}
                </ul>
              </div>

              <div className="validation-details">
                <h3>Pacing Analysis</h3>
                <p>Realistic estimate: {evaluation.narrative.pacingAnalysis.realisticEstimatedTeachingTime}</p>
                <ul className="issue-list">
                  {evaluation.narrative.pacingAnalysis.compressionRisks.map((item, index) => (
                    <li key={`compression-${index}`}>{item}</li>
                  ))}
                  {evaluation.narrative.pacingAnalysis.bottleneckModules.map((item, index) => (
                    <li key={`bottleneck-${index}`}>Bottleneck: {item}</li>
                  ))}
                </ul>
              </div>

              <div className="validation-details">
                <h3>Structural Analysis</h3>
                <p>Repetition: {evaluation.narrative.structuralAnalysis.repetitionDetection}</p>
                <p>Template leakage: {evaluation.narrative.structuralAnalysis.templateLeakage}</p>
                <p>Redundancy: {evaluation.narrative.structuralAnalysis.conceptualRedundancy}</p>
                <p>Transitions: {evaluation.narrative.structuralAnalysis.transitionQuality}</p>
              </div>

              <div className="validation-details">
                <h3>Pedagogical Integration Analysis</h3>
                <ul className="issue-list">
                  {Object.entries(evaluation.narrative.pedagogicalIntegrationAnalysis).map(([key, value]) => (
                    <li key={key}>
                      <strong>{key}</strong>
                      <p>
                        present={String(value.present)} · integrated={String(value.integrated)} · useful={String(value.pedagogicallyUseful)}
                        {" "}· audienceAligned={String(value.audienceAligned)}
                      </p>
                      <p>{value.notes}</p>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="validation-details">
                <h3>Contradiction Analysis</h3>
                <p>{evaluation.narrative.contradictionAnalysis.consistencyVerdict}</p>
                <ul className="issue-list">
                  {evaluation.narrative.contradictionAnalysis.contradictions.map((item, index) => (
                    <li key={`contradiction-${index}`}>{item}</li>
                  ))}
                </ul>
              </div>

              <div className="validation-details">
                <h3>Final Reliability Score</h3>
                <p>
                  <strong>{evaluation.narrative.finalReliabilityScore}</strong>
                </p>
              </div>

              <div className="validation-details">
                <h3>Cited Mismatches</h3>
                <ul className="issue-list">
                  {evaluation.mismatches.map((mismatch, index) => (
                    <li key={`${mismatch.category}-${index}`}>
                      <span className={`severity ${mismatch.severity}`}>{mismatch.severity}</span>
                      <strong>{mismatch.category}</strong>
                      <p>{mismatch.reason}</p>
                      {mismatch.evidence.map((item, evidenceIndex) => (
                        <p key={evidenceIndex}>
                          Evidence: "{item.quote}"{item.sectionTitle ? ` (${item.sectionTitle})` : ""}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ) : null}

          <section className="panel execution-trace">
            <button
              type="button"
              className="trace-header"
              onClick={() => setIsTraceExpanded(!isTraceExpanded)}
            >
              <div>
                <h2>Execution Trace</h2>
                <p className="trace-summary">
                  {result.traces.length} stages ·{" "}
                  {result.traces.filter((t) => t.status === "success").length} success ·{" "}
                  {result.traces.filter((t) => t.status === "error").length} errors ·{" "}
                  {result.traces.filter((t) => t.status === "warning").length} warnings
                </p>
              </div>
              <span className={`expand-icon ${isTraceExpanded ? "expanded" : ""}`}>
                {isTraceExpanded ? "▼" : "▶"}
              </span>
            </button>
            {isTraceExpanded && (
              <div className="trace-list">
                {result.traces.map((trace) => (
                  <TraceCard key={`${trace.node}-${trace.startedAt}`} trace={trace} />
                ))}
              </div>
            )}
          </section>
        </section>
      ) : null}
    </main>
  );
}

function ToggleCard({ label, checked, onClick }: { label: string; checked: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`toggle ${checked ? "on" : "off"}`} onClick={onClick}>
      <span>{label}</span>
      <strong>{checked ? "On" : "Off"}</strong>
    </button>
  );
}

function TraceCard({ trace }: { trace: TraceEvent }) {
  return (
    <article className={`trace ${trace.status}`}>
      <header>
        <strong>{trace.node}</strong>
        <span>{trace.status.toUpperCase()}</span>
      </header>
      <p>{trace.latencyMs} ms</p>
      {trace.warnings.length ? <p>Warnings: {trace.warnings.join(" | ")}</p> : null}
      {trace.errors.length ? <p>Errors: {trace.errors.join(" | ")}</p> : null}
    </article>
  );
}
