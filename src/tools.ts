/**
 * Tool Implementations
 *
 * These tools run inside the sandbox and perform file/shell operations.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolDefinition } from "./types.js";

const execAsync = promisify(exec);

// =============================================================================
// Tool Definitions (Anthropic format)
// =============================================================================

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "read",
    description:
      "Read the contents of a file. Use this to examine files before editing. Supports text files. Output is truncated for large files - use offset/limit for pagination.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to read (relative to workspace)",
        },
        offset: {
          type: "number",
          description: "Line number to start reading from (1-indexed)",
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to read",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to write (relative to workspace)",
        },
        content: {
          type: "string",
          description: "Content to write to the file",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    description:
      "Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to edit (relative to workspace)",
        },
        oldText: {
          type: "string",
          description: "Exact text to find and replace (must match exactly)",
        },
        newText: {
          type: "string",
          description: "New text to replace the old text with",
        },
      },
      required: ["path", "oldText", "newText"],
    },
  },
  {
    name: "bash",
    description:
      "Execute a bash command in the workspace directory. Returns stdout and stderr. Use for running tests, git operations, installing packages, etc.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Bash command to execute",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default: 120)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "glob",
    description:
      "Find files matching a glob pattern. Returns a list of file paths relative to the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern to match (e.g., '**/*.ts', 'src/**/*.tsx')",
        },
      },
      required: ["pattern"],
    },
  },
];

// =============================================================================
// Tool Executor
// =============================================================================

export class ToolExecutor {
  private workspace: string;
  private maxOutputSize = 50 * 1024; // 50KB max output

  constructor(workspace: string) {
    this.workspace = workspace;
  }

  /**
   * Execute a tool and return the result
   */
  async execute(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ output: string; isError: boolean }> {
    try {
      switch (toolName) {
        case "read":
          return { output: await this.read(input), isError: false };
        case "write":
          return { output: await this.write(input), isError: false };
        case "edit":
          return { output: await this.edit(input), isError: false };
        case "bash":
          return { output: await this.bash(input), isError: false };
        case "glob":
          return { output: await this.glob(input), isError: false };
        default:
          return { output: `Unknown tool: ${toolName}`, isError: true };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { output: message, isError: true };
    }
  }

  /**
   * Read a file
   */
  private async read(input: Record<string, unknown>): Promise<string> {
    const filePath = input.path as string;
    const offset = (input.offset as number) || 1;
    const limit = input.limit as number | undefined;

    const fullPath = this.resolvePath(filePath);
    const content = await fs.readFile(fullPath, "utf-8");
    const lines = content.split("\n");

    const startLine = Math.max(0, offset - 1);
    const endLine = limit ? startLine + limit : lines.length;
    const selectedLines = lines.slice(startLine, endLine);

    let output = selectedLines.join("\n");

    // Truncate if too large
    if (output.length > this.maxOutputSize) {
      output = output.slice(0, this.maxOutputSize) + "\n... (truncated)";
    }

    return output;
  }

  /**
   * Write a file
   */
  private async write(input: Record<string, unknown>): Promise<string> {
    const filePath = input.path as string;
    const content = input.content as string;

    const fullPath = this.resolvePath(filePath);

    // Create parent directories if needed
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    await fs.writeFile(fullPath, content, "utf-8");

    return `Successfully wrote ${content.length} bytes to ${filePath}`;
  }

  /**
   * Edit a file by replacing text
   */
  private async edit(input: Record<string, unknown>): Promise<string> {
    const filePath = input.path as string;
    const oldText = input.oldText as string;
    const newText = input.newText as string;

    const fullPath = this.resolvePath(filePath);
    const content = await fs.readFile(fullPath, "utf-8");

    if (!content.includes(oldText)) {
      throw new Error(
        `Could not find the specified text in ${filePath}. Make sure oldText matches exactly.`,
      );
    }

    // Count occurrences
    const occurrences = content.split(oldText).length - 1;
    if (occurrences > 1) {
      throw new Error(
        `Found ${occurrences} occurrences of the text. Please use more specific text to match exactly once.`,
      );
    }

    const newContent = content.replace(oldText, newText);
    await fs.writeFile(fullPath, newContent, "utf-8");

    return `Successfully edited ${filePath}`;
  }

  /**
   * Execute a bash command
   */
  private async bash(input: Record<string, unknown>): Promise<string> {
    const command = input.command as string;
    const timeout = ((input.timeout as number) || 120) * 1000;

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.workspace,
        timeout,
        maxBuffer: this.maxOutputSize,
        env: {
          ...process.env,
          // Ensure git doesn't prompt for credentials
          GIT_TERMINAL_PROMPT: "0",
        },
      });

      let output = "";
      if (stdout) output += stdout;
      if (stderr) output += (output ? "\n" : "") + stderr;

      return output || "(no output)";
    } catch (error: unknown) {
      const execError = error as {
        stdout?: string;
        stderr?: string;
        code?: number;
      };
      let output = "";
      if (execError.stdout) output += execError.stdout;
      if (execError.stderr) output += (output ? "\n" : "") + execError.stderr;

      if (execError.code !== undefined) {
        output += `\nExit code: ${execError.code}`;
      }

      return output || String(error);
    }
  }

  /**
   * Find files matching a glob pattern
   */
  private async glob(input: Record<string, unknown>): Promise<string> {
    const pattern = input.pattern as string;

    // Use find command for simplicity (available on all Unix systems)
    // Convert basic glob to find pattern
    const { stdout } = await execAsync(
      `find . -type f -name "${pattern.replace(/\*\*/g, "*")}" | head -100`,
      {
        cwd: this.workspace,
        maxBuffer: this.maxOutputSize,
      },
    );

    const files = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((f) => f.replace(/^\.\//, ""));

    if (files.length === 0) {
      return "No files found matching pattern";
    }

    return files.join("\n");
  }

  /**
   * Resolve a path relative to the workspace
   */
  private resolvePath(filePath: string): string {
    // Prevent path traversal attacks
    const resolved = path.resolve(this.workspace, filePath);
    if (!resolved.startsWith(this.workspace)) {
      throw new Error("Path traversal not allowed");
    }
    return resolved;
  }
}
