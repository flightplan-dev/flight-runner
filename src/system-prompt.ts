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

## Git Workflow

You are working on branch \`${env.BRANCH_NAME}\` in repository \`${env.REPO_OWNER}/${env.REPO_NAME}\`.
The base branch is \`${env.BASE_BRANCH}\`.

**IMPORTANT: Commit and push your changes when you reach a stopping point.**

A "stopping point" includes:
- Completing a logical unit of work (feature, fix, or meaningful progress)
- Finishing the requested task
- Getting stuck and needing human input
- Before ending your response when you've made changes

**To save your work:**
1. Stage and commit your changes with a descriptive message:
   \`\`\`bash
   git add -A
   git commit -m "Your descriptive commit message"
   \`\`\`
2. Push to the remote branch:
   \`\`\`bash
   git push origin ${env.BRANCH_NAME}
   \`\`\`

**If a PR doesn't exist yet, create one** using the \`create_pr\` tool when:
- You have completed the requested task and verified it works
- After running tests (if applicable) and confirming they pass
- You've made meaningful changes that are ready for review

**Do NOT create a PR if:**
- One already exists for this branch (just push new commits)
- You're still exploring or debugging
- Tests are failing and you haven't fixed them yet
- Changes are trivial or incomplete

**Before calling create_pr:**
1. Review your changes to ensure they're complete
2. Run any relevant tests or verification steps
3. Write a clear, descriptive title and body

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
