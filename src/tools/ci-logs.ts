/**
 * get_ci_logs Tool
 *
 * Fetches CI logs from GitHub Actions for diagnosing failures.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Env } from "../types.js";

// =============================================================================
// Types
// =============================================================================

interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  head_sha: string;
}

interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  started_at: string | null;
  completed_at: string | null;
  steps?: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    number: number;
  }>;
}

// =============================================================================
// GitHub API Helpers
// =============================================================================

async function fetchGitHub<T>(
  endpoint: string,
  token: string,
  accept = "application/vnd.github+json"
): Promise<T> {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${error}`);
  }

  // Handle raw text responses (like logs)
  if (accept === "application/vnd.github+json") {
    return response.json() as Promise<T>;
  }
  return response.text() as unknown as T;
}

/**
 * Get the most recent workflow runs for a branch
 */
async function getWorkflowRuns(
  owner: string,
  repo: string,
  branch: string,
  token: string
): Promise<WorkflowRun[]> {
  const data = await fetchGitHub<{ workflow_runs: WorkflowRun[] }>(
    `/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=5`,
    token
  );
  return data.workflow_runs;
}

/**
 * Get jobs for a workflow run
 */
async function getWorkflowJobs(
  owner: string,
  repo: string,
  runId: number,
  token: string
): Promise<WorkflowJob[]> {
  const data = await fetchGitHub<{ jobs: WorkflowJob[] }>(
    `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`,
    token
  );
  return data.jobs;
}

/**
 * Get logs for a specific job
 */
async function getJobLogs(
  owner: string,
  repo: string,
  jobId: number,
  token: string
): Promise<string> {
  try {
    // GitHub returns logs as a downloadable zip or redirects to a URL
    // We'll try to get the logs directly
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "follow",
      }
    );

    if (!response.ok) {
      if (response.status === 410) {
        return "[Logs have expired or been deleted]";
      }
      throw new Error(`Failed to fetch logs: ${response.status}`);
    }

    return await response.text();
  } catch (error) {
    return `[Error fetching logs: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

/**
 * Extract the most relevant parts of CI logs (errors, failures, last N lines)
 */
function extractRelevantLogs(logs: string, maxLines = 200): string {
  const lines = logs.split("\n");

  // Look for error patterns
  const errorPatterns = [
    /error/i,
    /failed/i,
    /failure/i,
    /exception/i,
    /assert/i,
    /FAIL/,
    /ERR!/,
    /npm ERR/,
    /yarn error/i,
    /exit code [1-9]/i,
    /✗|✖|×/, // Common failure symbols
  ];

  const relevantLines: string[] = [];
  const contextBefore = 5;
  const contextAfter = 10;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isErrorLine = errorPatterns.some((pattern) => pattern.test(line || ""));

    if (isErrorLine) {
      // Add context before
      const start = Math.max(0, i - contextBefore);
      for (let j = start; j < i; j++) {
        if (!relevantLines.includes(lines[j] || "")) {
          relevantLines.push(lines[j] || "");
        }
      }

      // Add the error line
      relevantLines.push(line || "");

      // Add context after
      const end = Math.min(lines.length, i + contextAfter + 1);
      for (let j = i + 1; j < end; j++) {
        relevantLines.push(lines[j] || "");
      }

      i = end - 1; // Skip ahead
    }
  }

  // If we found relevant lines, return those
  if (relevantLines.length > 0) {
    const result = relevantLines.slice(0, maxLines).join("\n");
    if (relevantLines.length > maxLines) {
      return result + `\n\n[...truncated ${relevantLines.length - maxLines} more lines]`;
    }
    return result;
  }

  // Otherwise, return the last N lines
  const lastLines = lines.slice(-maxLines);
  return `[No obvious errors found, showing last ${lastLines.length} lines]\n\n` + lastLines.join("\n");
}

// =============================================================================
// get_ci_logs Tool
// =============================================================================

const getCiLogsSchema = Type.Object({
  runId: Type.Optional(
    Type.Number({ description: "Specific workflow run ID to fetch logs for. If not provided, fetches the most recent failed run." })
  ),
});

export interface GetCiLogsToolOptions {
  env: Env;
}

export function createGetCiLogsTool(options: GetCiLogsToolOptions): ToolDefinition<typeof getCiLogsSchema> {
  const { env } = options;

  return {
    name: "get_ci_logs",
    label: "Get CI Logs",
    description:
      "Fetch CI/CD logs from GitHub Actions for the current branch. Use this to diagnose test failures, build errors, or other CI issues. Returns logs from failed jobs with relevant error context.",
    parameters: getCiLogsSchema,
    execute: async (_toolCallId, { runId }, _onUpdate, _ctx, _signal) => {
      try {
        const owner = env.REPO_OWNER;
        const repo = env.REPO_NAME;
        const branch = env.BRANCH_NAME;
        const token = env.GITHUB_TOKEN;

        let targetRun: WorkflowRun | undefined;

        if (runId) {
          // Fetch specific run
          const runs = await getWorkflowRuns(owner, repo, branch, token);
          targetRun = runs.find((r) => r.id === runId);
          if (!targetRun) {
            return {
              content: [{ type: "text" as const, text: `Workflow run #${runId} not found for branch ${branch}` }],
              details: { error: "Run not found" },
            };
          }
        } else {
          // Find the most recent failed run
          const runs = await getWorkflowRuns(owner, repo, branch, token);
          targetRun = runs.find((r) => r.conclusion === "failure");

          if (!targetRun) {
            // No failures, check if there's a running workflow
            const runningRun = runs.find((r) => r.status === "in_progress");
            if (runningRun) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `No failed CI runs found. There's a workflow currently running:\n- ${runningRun.name} (${runningRun.html_url})`,
                  },
                ],
                details: { status: "running", runUrl: runningRun.html_url },
              };
            }

            // Check for success
            const successRun = runs.find((r) => r.conclusion === "success");
            if (successRun) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `✅ All CI checks are passing! Most recent successful run:\n- ${successRun.name} (${successRun.html_url})`,
                  },
                ],
                details: { status: "success", runUrl: successRun.html_url },
              };
            }

            return {
              content: [{ type: "text" as const, text: `No workflow runs found for branch ${branch}` }],
              details: { status: "no_runs" },
            };
          }
        }

        // Get jobs for the target run
        const jobs = await getWorkflowJobs(owner, repo, targetRun.id, token);
        const failedJobs = jobs.filter((j) => j.conclusion === "failure");

        if (failedJobs.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Workflow run "${targetRun.name}" is marked as failed but no individual job failures found.\nRun URL: ${targetRun.html_url}`,
              },
            ],
            details: { runUrl: targetRun.html_url },
          };
        }

        // Fetch logs for failed jobs
        const results: string[] = [];
        results.push(`## CI Failure Report`);
        results.push(`**Workflow:** ${targetRun.name}`);
        results.push(`**Branch:** ${branch}`);
        results.push(`**Commit:** ${targetRun.head_sha.slice(0, 7)}`);
        results.push(`**URL:** ${targetRun.html_url}`);
        results.push(`**Failed Jobs:** ${failedJobs.length}\n`);

        for (const job of failedJobs) {
          results.push(`---`);
          results.push(`### Job: ${job.name}`);
          results.push(`**URL:** ${job.html_url}`);

          // Show failed steps if available
          const failedSteps = job.steps?.filter((s) => s.conclusion === "failure") || [];
          if (failedSteps.length > 0) {
            results.push(`**Failed Steps:** ${failedSteps.map((s) => s.name).join(", ")}`);
          }

          results.push(`\n**Logs:**\n`);

          const logs = await getJobLogs(owner, repo, job.id, token);
          const relevantLogs = extractRelevantLogs(logs);
          results.push("```");
          results.push(relevantLogs);
          results.push("```\n");
        }

        const output = results.join("\n");

        return {
          content: [{ type: "text" as const, text: output }],
          details: {
            runId: targetRun.id,
            runUrl: targetRun.html_url,
            failedJobCount: failedJobs.length,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[get_ci_logs] Error:`, error);

        return {
          content: [{ type: "text" as const, text: `Error fetching CI logs: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}
