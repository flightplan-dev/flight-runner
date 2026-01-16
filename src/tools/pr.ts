/**
 * create_pr Tool
 *
 * Creates a pull request when the agent has completed its work.
 * Handles committing uncommitted changes with co-author attribution.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Env } from "../types.js";
import type { EventReporter } from "../reporter.js";

const execAsync = promisify(exec);

// =============================================================================
// Co-Author Tracking
// =============================================================================

export interface Contributor {
  id: string;
  name: string;
  email: string;
}

// Track contributors since last commit (module-level state)
const contributorsSinceLastCommit = new Map<string, Contributor>();

// Mission creator (set once at startup, excluded from co-authors)
let missionCreator: Contributor | null = null;

/**
 * Set the mission creator (primary author for all commits)
 */
export function setMissionCreator(creator: Contributor): void {
  missionCreator = creator;
}

/**
 * Add a contributor for co-author tracking.
 * Mission creator is excluded (they're the primary author).
 */
export function addContributor(contributor: Contributor): void {
  if (missionCreator && contributor.id === missionCreator.id) {
    return; // Don't add mission creator as co-author
  }
  contributorsSinceLastCommit.set(contributor.id, contributor);
}

/**
 * Get co-author trailers for git commit message
 */
function getCoAuthorTrailers(): string {
  const contributors = [...contributorsSinceLastCommit.values()];
  if (contributors.length === 0) return "";

  return contributors
    .map((c) => `Co-authored-by: ${c.name} <${c.email}>`)
    .join("\n");
}

/**
 * Clear contributors after a commit
 */
function clearContributors(): void {
  contributorsSinceLastCommit.clear();
}

// =============================================================================
// Git Helpers
// =============================================================================

async function runGit(
  cwd: string,
  args: string
): Promise<{ stdout: string; stderr: string }> {
  return execAsync(`git ${args}`, { cwd });
}

async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const { stdout } = await runGit(cwd, "status --porcelain");
  return stdout.trim().length > 0;
}

async function getChangedFiles(cwd: string): Promise<string[]> {
  const { stdout } = await runGit(cwd, "diff --name-only HEAD");
  return stdout
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);
}

/**
 * Escape a string for use in a shell command
 */
function escapeShell(str: string): string {
  return str.replace(/'/g, "'\\''");
}

// =============================================================================
// create_pr Tool
// =============================================================================

const createPrSchema = Type.Object({
  title: Type.String({ description: "PR title" }),
  body: Type.String({ description: "PR description summarizing the changes" }),
});

export interface CreatePrToolOptions {
  cwd: string;
  env: Env;
  reporter: EventReporter;
}

export function createPrTool(options: CreatePrToolOptions): ToolDefinition<typeof createPrSchema> {
  const { cwd, env, reporter } = options;

  return {
    name: "create_pr",
    label: "Create PR",
    description:
      "Create a pull request on GitHub. Call this when you've reached a stopping point and want to open a PR for review. Do NOT call if a PR already exists - just push new commits instead. This will commit any uncommitted changes, push, and open a PR.",
    parameters: createPrSchema,
    execute: async (_toolCallId, { title, body }, _onUpdate, _ctx, _signal) => {
      try {
        // 1. Commit any uncommitted changes with co-authors
        if (await hasUncommittedChanges(cwd)) {
          const trailers = getCoAuthorTrailers();
          const changedFiles = await getChangedFiles(cwd);
          const filesPreview = changedFiles.slice(0, 3).join(", ");
          const commitMsg = trailers
            ? `${title}\n\n${trailers}`
            : title;

          await runGit(cwd, "add -A");
          await runGit(cwd, `commit -m '${escapeShell(commitMsg)}'`);
          clearContributors();

          console.log(`[create_pr] Committed changes to ${filesPreview}`);
        }

        // 2. Push to remote with upstream tracking
        const repoUrl = `https://${env.GITHUB_USERNAME}:${env.GITHUB_TOKEN}@github.com/${env.REPO_OWNER}/${env.REPO_NAME}.git`;
        await runGit(cwd, `push -u ${repoUrl} HEAD:${env.BRANCH_NAME}`);
        console.log(`[create_pr] Pushed to origin/${env.BRANCH_NAME}`);

        // 3. Create PR via GitHub API
        const response = await fetch(
          `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/pulls`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.GITHUB_TOKEN}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              title,
              body,
              head: env.BRANCH_NAME,
              base: env.BASE_BRANCH,
            }),
          }
        );

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`GitHub API error: ${response.status} ${error}`);
        }

        const pr = (await response.json()) as { number: number; html_url: string };

        // Store PR info globally for pr_status tool
        (globalThis as any).__flightplan_pr_number = pr.number;
        (globalThis as any).__flightplan_pr_url = pr.html_url;

        // 4. Add assignee (mission creator)
        if (env.PR_ASSIGNEE) {
          try {
            const assigneeResponse = await fetch(
              `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/issues/${pr.number}/assignees`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${env.GITHUB_TOKEN}`,
                  Accept: "application/vnd.github+json",
                  "X-GitHub-Api-Version": "2022-11-28",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  assignees: [env.PR_ASSIGNEE],
                }),
              }
            );
            if (assigneeResponse.ok) {
              console.log(`[create_pr] Added ${env.PR_ASSIGNEE} as assignee`);
            } else {
              console.warn(`[create_pr] Failed to add assignee: ${await assigneeResponse.text()}`);
            }
          } catch (assignError) {
            // Don't fail PR creation if assignee fails
            console.warn(`[create_pr] Failed to add assignee:`, assignError);
          }
        }

        // 5. Report PR created to Gateway
        await reporter.report({
          type: "pr:created",
          prNumber: pr.number,
          prUrl: pr.html_url,
        });

        console.log(`[create_pr] Created PR #${pr.number}: ${pr.html_url}`);

        return {
          content: [
            {
              type: "text" as const,
              text: `Successfully created PR #${pr.number}: ${pr.html_url}`,
            },
          ],
          details: { prNumber: pr.number, prUrl: pr.html_url },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[create_pr] Error:`, error);

        return {
          content: [{ type: "text" as const, text: `Error creating PR: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}
