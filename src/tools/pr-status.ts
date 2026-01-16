/**
 * pr_status Tool
 *
 * Reports PR lifecycle events back to the Gateway.
 * The LLM should call this after pushing changes, addressing feedback, etc.
 */

import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Env, PrStatusAction } from "../types.js";
import type { EventReporter } from "../reporter.js";

export interface CreatePrStatusToolOptions {
  env: Env;
  reporter: EventReporter;
}

const PR_STATUS_ACTIONS: PrStatusAction[] = [
  "pushed",
  "updated",
  "ready_for_review",
  "changes_requested",
  "ci_fix",
  "conflict_resolved",
];

export function createPrStatusTool(
  options: CreatePrStatusToolOptions
): ToolDefinition<any> {
  const { reporter } = options;

  return {
    name: "pr_status",
    label: "PR Status",
    description: `Report PR status updates. Call this tool when:
- You've pushed new commits to the branch ("pushed")
- You've made significant changes to the PR ("updated")  
- The PR is ready for human review ("ready_for_review")
- You're addressing review feedback ("changes_requested")
- You're fixing CI/test failures ("ci_fix")
- You've resolved merge conflicts ("conflict_resolved")

This helps team members track the PR's progress.`,
    parameters: Type.Object({
      action: StringEnum(PR_STATUS_ACTIONS, {
        description: "The type of status update",
      }),
      message: Type.String({
        description: "A brief description of what changed (e.g., 'Added unit tests for the new API endpoint')",
      }),
    }),

    async execute(_toolCallId, params: { action: PrStatusAction; message: string }, _onUpdate, _ctx, _signal) {
      const { action, message } = params;

      // Report to Gateway
      await reporter.report({
        type: "pr:status",
        action,
        message,
        // Include PR info if we have it (set after create_pr)
        prNumber: (globalThis as any).__flightplan_pr_number,
        prUrl: (globalThis as any).__flightplan_pr_url,
      });

      console.log(`[pr_status] ${action}: ${message}`);

      return {
        content: [
          {
            type: "text" as const,
            text: `Status update recorded: ${action} - ${message}`,
          },
        ],
        details: { action, message },
      };
    },
  };
}
