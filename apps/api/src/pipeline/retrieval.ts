import type { BriefInput, RetrievalArtifact, RetrievedSource } from "@curriculum/schemas";
import { RetrievalArtifactSchema } from "@curriculum/schemas";
import { normalizeTopic, nowIso, clampUnit } from "./utils.js";

interface SourceSeed {
  id: string;
  title: string;
  url: string;
  topics: string[];
  frameworks: string[];
}

const OFFICIAL_SOURCES: SourceSeed[] = [
  {
    id: "openai-api",
    title: "OpenAI API Docs",
    url: "https://platform.openai.com/docs/api-reference",
    topics: ["llm", "prompt", "agent", "memory"],
    frameworks: ["openai"],
  },
  {
    id: "openai-guides",
    title: "OpenAI Guides",
    url: "https://platform.openai.com/docs/guides/text",
    topics: ["llm", "prompt", "generation"],
    frameworks: ["openai"],
  },
  {
    id: "langgraph-js",
    title: "LangGraph JS Docs",
    url: "https://docs.langchain.com/oss/javascript/langgraph/overview",
    topics: ["graph", "agent", "workflow", "orchestration"],
    frameworks: ["langgraph", "langchain"],
  },
  {
    id: "langchain-js",
    title: "LangChain JS Docs",
    url: "https://js.langchain.com/docs/introduction/",
    topics: ["retrieval", "memory", "agent", "chains"],
    frameworks: ["langchain"],
  },
  {
    id: "typescript-docs",
    title: "TypeScript Handbook",
    url: "https://www.typescriptlang.org/docs/",
    topics: ["typescript", "node", "code"],
    frameworks: ["typescript"],
  },
  {
    id: "node-docs",
    title: "Node.js Docs",
    url: "https://nodejs.org/docs/latest/api/",
    topics: ["node", "runtime", "execution"],
    frameworks: ["node"],
  },
  {
    id: "nextjs-docs",
    title: "Next.js Docs",
    url: "https://nextjs.org/docs",
    topics: ["frontend", "web"],
    frameworks: ["next.js"],
  },
  {
    id: "python-docs",
    title: "Python Docs",
    url: "https://docs.python.org/3/",
    topics: ["python", "runtime", "code"],
    frameworks: ["python"],
  },
];

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

function isOfficialDomain(domain: string): boolean {
  return [
    "platform.openai.com",
    "docs.langchain.com",
    "js.langchain.com",
    "www.typescriptlang.org",
    "nodejs.org",
    "nextjs.org",
    "docs.python.org",
  ].includes(domain);
}

function scoreSource(seed: SourceSeed, brief: BriefInput, topicTokens: string[], frameworks: string[]): number {
  let score = 0;
  for (const token of topicTokens) {
    if (seed.topics.includes(token)) {
      score += 2;
    }
  }
  for (const framework of frameworks) {
    if (seed.frameworks.includes(framework)) {
      score += 3;
    }
  }
  const normalizedTopic = normalizeTopic(brief.topic);
  if (normalizedTopic.includes("memory") && seed.id.includes("langchain")) {
    score += 1;
  }
  if (normalizedTopic.includes("llm") && seed.id.includes("openai")) {
    score += 1;
  }
  return score;
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchSnippet(url: string): Promise<string> {
  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(4500),
    headers: {
      "User-Agent": "curriculum-os-retriever/1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const raw = await response.text();
  const text = stripHtmlToText(raw);
  return text.slice(0, 420);
}

function buildFallbackSnippet(seed: SourceSeed): string {
  return `Official source selected: ${seed.title}. Use this source to ground technical claims and APIs for ${seed.frameworks.join(", ") || "general curriculum"}.`;
}

export async function retrieveGrounding(brief: BriefInput): Promise<RetrievalArtifact> {
  const frameworks = [
    brief.targetStack.language,
    brief.targetStack.runtime,
    ...brief.targetStack.frameworks,
  ].map((value) => normalizeTopic(value));

  const topicTokens = normalizeTopic(brief.topic)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);

  const ranked = OFFICIAL_SOURCES
    .map((seed) => ({ seed, score: scoreSource(seed, brief, topicTokens, frameworks) }))
    .sort((a, b) => b.score - a.score || a.seed.id.localeCompare(b.seed.id))
    .slice(0, 6)
    .map((item) => item.seed);

  const sources: RetrievedSource[] = await Promise.all(ranked.map(async (seed) => {
    const domain = getDomain(seed.url);
    try {
      const snippet = await fetchSnippet(seed.url);
      return {
        id: seed.id,
        url: seed.url,
        title: seed.title,
        domain,
        official: isOfficialDomain(domain),
        status: "fetched" as const,
        snippet,
        retrievedAt: nowIso(),
        confidence: 0.84,
      };
    } catch {
      return {
        id: seed.id,
        url: seed.url,
        title: seed.title,
        domain,
        official: isOfficialDomain(domain),
        status: "fallback" as const,
        snippet: buildFallbackSnippet(seed),
        retrievedAt: nowIso(),
        confidence: 0.62,
      };
    }
  }));

  const groundedFacts = sources.map((source) => {
    return `${source.title} (${source.domain}): ${source.snippet.slice(0, 180)}`;
  });

  const fetchedCount = sources.filter((source) => source.status === "fetched").length;
  const officialCount = sources.filter((source) => source.official).length;
  const confidence = clampUnit((fetchedCount / Math.max(1, sources.length)) * 0.7 + (officialCount / Math.max(1, sources.length)) * 0.3);

  return RetrievalArtifactSchema.parse({
    query: `${brief.topic} | ${brief.targetStack.language} | ${brief.targetStack.frameworks.join(", ")}`,
    sources,
    groundedFacts,
    confidence,
  });
}
