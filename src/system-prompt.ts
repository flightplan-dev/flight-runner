/**
 * System Prompt
 *
 * Custom system prompt additions for flight-runner.
 * Appended to pi-mono's default coding agent prompt.
 */

import type { Env } from "./types.js";

export function buildSystemPrompt(env: Env): (defaultPrompt: string) => string {
  return (defaultPrompt: string) => {
    const additions = `

## Pull Request Workflow

You have a \`create_pr\` tool available to create GitHub pull requests.

**When to create a PR:**
- When you have completed the requested task and verified it works
- After running tests (if applicable) and confirming they pass
- When you've made meaningful changes that are ready for review

**When NOT to create a PR:**
- While still exploring or debugging
- If tests are failing and you haven't fixed them yet
- If you're unsure the implementation is correct
- For trivial or incomplete changes

**Before calling create_pr:**
1. Review your changes to ensure they're complete
2. Run any relevant tests or verification steps
3. Write a clear, descriptive title and body

**PR Details:**
- Repository: ${env.REPO_OWNER}/${env.REPO_NAME}
- Branch: ${env.BRANCH_NAME} → ${env.BASE_BRANCH}

When you create a PR, the changes will be committed with proper attribution to the users who contributed prompts during this mission.

## PR Status Updates

You have a \`pr_status\` tool to report progress updates. Call this tool:
- After pushing new commits ("pushed") - briefly describe what you changed
- When addressing review feedback ("changes_requested") - explain what you fixed
- When fixing CI/test failures ("ci_fix") - describe the fix
- When resolving merge conflicts ("conflict_resolved")
- When the PR is ready for review ("ready_for_review")

These status updates help the team track the PR's progress without reading all the code changes.
`;

    return defaultPrompt + additions;
  };
}
