export interface TopicConcept {
  id: string;
  title: string;
  objective: string;
  summary: string;
  beginnerAnalogy: string;
  beginnerDefinition: string;
  advancedTradeoff: string;
  failureCase: string;
  interactionPrompt: string;
  transitionQuestion: string;
  implementationTask: string;
  difficulty: number;
  prerequisites: string[];
}

export interface TopicProfile {
  canonicalTopic: string;
  concepts: TopicConcept[];
  references: string[];
}

function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildLlmMemoryProfile(): TopicProfile {
  return {
    canonicalTopic: "LLM Memory",
    references: [
      "https://docs.langchain.com/oss/javascript/langgraph",
      "https://platform.openai.com/docs/guides/text",
      "https://www.pinecone.io/learn/vector-embeddings/",
    ],
    concepts: [
      {
        id: "memory-types",
        title: "Working Memory vs Long-Term Memory",
        objective: "Differentiate context-window memory from persisted memory stores in LLM systems.",
        summary: "Frame memory as two layers: transient context in the current prompt and persisted memory retrieved on demand.",
        beginnerAnalogy: "A desk and a filing cabinet: only desk items are instantly visible, cabinet items must be fetched.",
        beginnerDefinition: "Working memory is the current prompt context; long-term memory is saved data retrieved into context.",
        advancedTradeoff: "More persistent memory improves recall but increases retrieval latency and risk of stale context injection.",
        failureCase: "Teams treat every user message as long-term memory, causing irrelevant context bloat and response drift.",
        interactionPrompt: "Given a support chatbot, identify one fact that belongs in working memory and one that belongs in long-term memory.",
        transitionQuestion: "If long-term memory is external, what decides which memories get injected into the prompt?",
        implementationTask: "Model memory records with type, timestamp, and retention policy fields.",
        difficulty: 0.25,
        prerequisites: [],
      },
      {
        id: "context-window",
        title: "Context Windows and Compression",
        objective: "Explain why context limits require summarization and memory compression strategies.",
        summary: "Show how finite context windows force trade-offs between recency, relevance, and completeness.",
        beginnerAnalogy: "A backpack with fixed capacity: adding one item means removing or compressing another.",
        beginnerDefinition: "Context window is the maximum token budget the model can read in a single request.",
        advancedTradeoff: "Aggressive summarization reduces token cost but can erase details needed for future reasoning.",
        failureCase: "A summarizer drops user constraints, so the assistant repeatedly violates the same preference.",
        interactionPrompt: "Ask learners to choose what to keep, summarize, or drop from an overlong chat transcript.",
        transitionQuestion: "How can we retrieve the right facts later without keeping the full transcript in context?",
        implementationTask: "Implement a rolling summary that preserves user preferences and unresolved tasks.",
        difficulty: 0.38,
        prerequisites: ["memory-types"],
      },
      {
        id: "embeddings-and-index",
        title: "Embeddings, Indexing, and Retrieval Intent",
        objective: "Connect embeddings and vector indexes to memory recall quality.",
        summary: "Convert memory entries into vectors and query by semantic similarity to recall relevant history.",
        beginnerAnalogy: "A smart library catalog that groups books by meaning, not by exact title match.",
        beginnerDefinition: "Embeddings are numeric vectors representing semantic meaning of text for similarity search.",
        advancedTradeoff: "Dense retrieval boosts semantic recall but can surface near-duplicates without good write policies.",
        failureCase: "Low-quality chunking stores fragments without context, returning misleading partial memories.",
        interactionPrompt: "Have learners compare lexical keyword matching vs embedding retrieval for the same query.",
        transitionQuestion: "Once memories are retrieved, how should an agent rank and inject them safely?",
        implementationTask: "Create memory chunks with metadata tags and retrieval score thresholds.",
        difficulty: 0.52,
        prerequisites: ["context-window"],
      },
      {
        id: "memory-read-write",
        title: "Memory Read/Write Policies",
        objective: "Design explicit policies for what to store, when to update, and when to forget.",
        summary: "Introduce write filters, deduplication, decay, and conflict handling to keep memory usable over time.",
        beginnerAnalogy: "A notebook with rules: only durable facts go in, outdated notes get crossed out.",
        beginnerDefinition: "Read/write policy is a rule set controlling memory persistence and retrieval behavior.",
        advancedTradeoff: "Strict write policies improve precision but may miss weak signals that become important later.",
        failureCase: "No deduplication leads to repeated contradictory entries and unstable responses.",
        interactionPrompt: "Ask learners to draft one write rule and one delete rule for a personal-assistant bot.",
        transitionQuestion: "How do these policies fit into an end-to-end agent loop with tool calls?",
        implementationTask: "Build a policy function that stores user preferences but skips one-off small talk.",
        difficulty: 0.62,
        prerequisites: ["embeddings-and-index"],
      },
      {
        id: "agent-memory-architecture",
        title: "Agent Memory Architecture in Practice",
        objective: "Implement memory retrieval and persistence hooks in a deterministic agent workflow.",
        summary: "Wire memory read before generation and memory write after response with validation checkpoints.",
        beginnerAnalogy: "Prep-cook-clean: gather ingredients, cook the dish, then store leftovers.",
        beginnerDefinition: "Agent memory architecture defines when memory is read and written in each interaction.",
        advancedTradeoff: "Inline retrieval is simple but can block latency; async enrichment improves latency but risks race conditions.",
        failureCase: "Memory writes happen before response validation, persisting hallucinated details as facts.",
        interactionPrompt: "Have learners map memory read/write points onto a request lifecycle diagram.",
        transitionQuestion: "What monitoring checks confirm memory quality does not degrade over time?",
        implementationTask: "Add pre-response retrieval, post-response memory write, and guardrails for conflict detection.",
        difficulty: 0.75,
        prerequisites: ["memory-read-write"],
      },
      {
        id: "validation-failure-modes",
        title: "Validation and Failure Modes",
        objective: "Measure memory quality using precision, drift, contradiction, and latency indicators.",
        summary: "Establish evaluation loops that detect stale, conflicting, or privacy-violating memories.",
        beginnerAnalogy: "A fact-check checklist that runs before publishing a newsletter.",
        beginnerDefinition: "Failure modes are repeatable ways memory systems break, such as stale recall or false persistence.",
        advancedTradeoff: "More validation checks improve reliability but increase runtime overhead and operational complexity.",
        failureCase: "System keeps retrieving old account status after a user update due to stale index entries.",
        interactionPrompt: "Ask learners to classify sample failures as retrieval, write-policy, or evaluation errors.",
        transitionQuestion: "Which metric should trigger human review first in production?",
        implementationTask: "Define alert thresholds for contradiction rate and stale-memory retrieval rate.",
        difficulty: 0.84,
        prerequisites: ["agent-memory-architecture"],
      },
    ],
  };
}

function buildGenericProfile(topic: string): TopicProfile {
  const topicName = topic.trim();
  return {
    canonicalTopic: topicName,
    references: [
      "https://www.typescriptlang.org/docs/",
      "https://docs.langchain.com/oss/javascript/langgraph",
    ],
    concepts: [
      {
        id: "foundations",
        title: "Foundations and Vocabulary",
        objective: `Define core terms and baseline mental model for ${topicName}.`,
        summary: `Ground learners in the smallest set of concepts required to discuss ${topicName} accurately.`,
        beginnerAnalogy: `Use a real-world analogy to explain what ${topicName} is and what it is not.`,
        beginnerDefinition: `${topicName} fundamentals explained in one concise definition and one concrete example.`,
        advancedTradeoff: `Contrast a simple implementation of ${topicName} with a production-oriented design.`,
        failureCase: `Show a common misunderstanding that causes teams to misuse ${topicName}.`,
        interactionPrompt: `Ask learners to restate ${topicName} in one sentence using an applied scenario.`,
        transitionQuestion: `Which assumptions from the foundation step become constraints during implementation?`,
        implementationTask: `Build a minimal example that demonstrates one foundational behavior of ${topicName}.`,
        difficulty: 0.25,
        prerequisites: [],
      },
      {
        id: "architecture",
        title: "Architecture and System Boundaries",
        objective: `Map the components, boundaries, and interfaces involved in ${topicName}.`,
        summary: `Describe where ${topicName} lives in the wider system and how data flows across boundaries.`,
        beginnerAnalogy: `Map architecture to a familiar workflow with clear handoff points.`,
        beginnerDefinition: `System boundary is where ownership, assumptions, and failure handling shift.`,
        advancedTradeoff: `Discuss coupling vs flexibility when integrating ${topicName} into existing systems.`,
        failureCase: `Boundary mismatch causes hidden side effects and difficult incident debugging.`,
        interactionPrompt: `Have learners identify one boundary that requires explicit contract validation.`,
        transitionQuestion: `What implementation choices create the largest long-term maintenance impact?`,
        implementationTask: `Document interfaces and failure handling paths for each boundary.`,
        difficulty: 0.46,
        prerequisites: ["foundations"],
      },
      {
        id: "implementation",
        title: "Implementation Walkthrough",
        objective: `Implement a deterministic baseline for ${topicName} and instrument key checkpoints.`,
        summary: `Walk through a working implementation and tie each step to the learning objective.`,
        beginnerAnalogy: `Treat implementation as a checklist: setup, run, verify, and inspect.`,
        beginnerDefinition: `Deterministic baseline means identical input produces predictable output.`,
        advancedTradeoff: `Compare maintainability, performance, and extensibility of two implementation paths.`,
        failureCase: `Hidden defaults produce behavior that differs between environments.`,
        interactionPrompt: `Ask learners to predict output before execution and explain mismatches.`,
        transitionQuestion: `How should we validate correctness beyond a successful run?`,
        implementationTask: `Instrument logging and assertions around critical control points.`,
        difficulty: 0.62,
        prerequisites: ["architecture"],
      },
      {
        id: "validation",
        title: "Validation and Failure Modes",
        objective: `Create validation criteria and failure-mode tests for ${topicName}.`,
        summary: `Formalize what correctness means and how to detect regressions early.`,
        beginnerAnalogy: `Use a pre-flight checklist metaphor for release readiness.`,
        beginnerDefinition: `Validation is evidence that behavior matches expected constraints.`,
        advancedTradeoff: `Discuss runtime overhead of deeper validation versus incident recovery costs.`,
        failureCase: `A green happy-path test hides a production regression in edge conditions.`,
        interactionPrompt: `Ask learners to propose one metric that would trigger manual review.`,
        transitionQuestion: `What should be monitored continuously after rollout?`,
        implementationTask: `Write failure-injection tests for invalid inputs and boundary conditions.`,
        difficulty: 0.78,
        prerequisites: ["implementation"],
      },
    ],
  };
}

function isLlmMemoryTopic(topic: string): boolean {
  const normalized = normalizeTopic(topic);
  return normalized.includes("llm memory")
    || normalized.includes("agent memory")
    || (normalized.includes("llm") && normalized.includes("memory"));
}

function spreadSelect<T>(items: T[], count: number): T[] {
  if (count >= items.length) {
    return items.slice();
  }
  const selected: T[] = [];
  for (let index = 0; index < count; index += 1) {
    const ratio = count === 1 ? 0 : index / (count - 1);
    const sourceIndex = Math.round(ratio * (items.length - 1));
    selected.push(items[sourceIndex]);
  }
  return selected;
}

export function buildTopicProfile(topic: string): TopicProfile {
  if (isLlmMemoryTopic(topic)) {
    return buildLlmMemoryProfile();
  }
  return buildGenericProfile(topic);
}

export function selectConceptsForBrief(topic: string, moduleCount: number): TopicConcept[] {
  const profile = buildTopicProfile(topic);
  const boundedCount = Math.max(3, Math.min(profile.concepts.length, moduleCount));
  return spreadSelect(profile.concepts, boundedCount);
}

export function allocateModuleMinutes(concepts: TopicConcept[], totalMinutes: number): number[] {
  const minimumPerModule = 8;
  const boundedTotal = Math.max(totalMinutes, concepts.length * minimumPerModule);
  const weightSum = concepts.reduce((sum, concept) => sum + concept.difficulty + 0.2, 0);
  const provisional = concepts.map((concept) => Math.max(
    minimumPerModule,
    Math.floor((boundedTotal * (concept.difficulty + 0.2)) / weightSum),
  ));

  let assigned = provisional.reduce((sum, value) => sum + value, 0);
  while (assigned < boundedTotal) {
    const idx = assigned % provisional.length;
    provisional[idx] += 1;
    assigned += 1;
  }
  while (assigned > boundedTotal) {
    const idx = assigned % provisional.length;
    if (provisional[idx] > minimumPerModule) {
      provisional[idx] -= 1;
      assigned -= 1;
    } else {
      const fallback = provisional.findIndex((minutes) => minutes > minimumPerModule);
      if (fallback === -1) {
        break;
      }
      provisional[fallback] -= 1;
      assigned -= 1;
    }
  }
  return provisional;
}

export function averagePrerequisiteDepth(concepts: TopicConcept[]): number {
  if (!concepts.length) {
    return 0;
  }
  const conceptIds = new Set(concepts.map((concept) => concept.id));
  const depthSum = concepts.reduce((sum, concept) => {
    const matched = concept.prerequisites.filter((prereq) => conceptIds.has(prereq)).length;
    return sum + matched;
  }, 0);
  return depthSum / concepts.length;
}

