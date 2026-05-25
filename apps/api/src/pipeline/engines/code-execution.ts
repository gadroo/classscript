import { tmpdir } from "node:os";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const CodeSnippetListSchema = z.array(
  z.object({
    id: z.string(),
    language: z.enum(["typescript", "bash", "json", "text"]),
    code: z.string(),
  }),
);

export interface CodeExecutionResult {
  id: string;
  ok: boolean;
  stderr?: string;
}

export interface CodeExecutionEngine {
  kind: "node" | "python";
  validate(snippets: unknown): Promise<CodeExecutionResult[]>;
}

export class NodeCodeExecutionEngine implements CodeExecutionEngine {
  public readonly kind = "node" as const;

  private async resolveExecutionCwd(): Promise<string> {
    const workspaceApiDir = join(process.cwd(), "apps", "api");
    try {
      await access(join(workspaceApiDir, "package.json"));
      return workspaceApiDir;
    } catch {
      return process.cwd();
    }
  }

  async validate(snippets: unknown): Promise<CodeExecutionResult[]> {
    const safeSnippets = CodeSnippetListSchema.parse(snippets);
    const tempDir = await mkdtemp(join(tmpdir(), "curriculum-node-check-"));
    const executionCwd = await this.resolveExecutionCwd();
    try {
      const results: CodeExecutionResult[] = [];
      for (const snippet of safeSnippets) {
        if (snippet.language !== "typescript") {
          results.push({ id: snippet.id, ok: true });
          continue;
        }

        const file = join(tempDir, `${snippet.id}.ts`);
        await writeFile(file, snippet.code, "utf8");
        try {
          await execFileAsync("node", ["--import", "tsx", file], {
            cwd: executionCwd,
            timeout: 8000,
          });
          results.push({ id: snippet.id, ok: true });
        } catch (error) {
          const stderr = error instanceof Error ? error.message : "Unknown execution error";
          results.push({ id: snippet.id, ok: false, stderr });
        }
      }
      return results;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export class PythonCodeExecutionEnginePlaceholder implements CodeExecutionEngine {
  public readonly kind = "python" as const;

  async validate(): Promise<CodeExecutionResult[]> {
    throw new Error(
      "Python engine is intentionally not enabled in v1. Implement this seam when bottleneck metrics justify Python promotion.",
    );
  }
}
