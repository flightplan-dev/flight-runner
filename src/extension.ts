/**
 * Git Sync Extension
 *
 * Pulls latest changes from remote before first file modification.
 * This handles cases where someone pushed changes externally while
 * the agent was idle or checkpointed.
 *
 * Only pulls when:
 * 1. Branch is clean (no uncommitted changes)
 * 2. Haven't already pulled this session
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function createGitSyncExtension(config: {
  repoUrl: string;
  branchName: string;
  cwd: string;
}) {
  return function gitSyncExtension(pi: ExtensionAPI) {
    let hasPulled = false;
    let branchIsDirty = false;

    // Check if branch is dirty
    async function checkDirty(): Promise<boolean> {
      try {
        const { stdout } = await pi.exec("git", ["status", "--porcelain"], {
          cwd: config.cwd,
        });
        return stdout.trim().length > 0;
      } catch {
        return true; // Assume dirty on error
      }
    }

    // Pull latest changes
    async function pullLatest(): Promise<boolean> {
      try {
        console.log(`[GitSync] Pulling latest from ${config.branchName}...`);
        await pi.exec(
          "git",
          ["pull", config.repoUrl, config.branchName, "--rebase", "--autostash"],
          { cwd: config.cwd }
        );
        console.log(`[GitSync] Pull successful`);
        return true;
      } catch (error) {
        // Branch may not exist on remote yet
        console.log(`[GitSync] Pull skipped (branch may not exist on remote)`);
        return false;
      }
    }

    // Intercept file modification tools
    pi.on("tool_call", async (event, _ctx) => {
      // Only intercept write/edit operations
      const writeTools = ["write", "edit"];
      if (!writeTools.includes(event.toolName)) {
        return;
      }

      // Already pulled this session
      if (hasPulled) {
        return;
      }

      // Check if branch is dirty
      if (!branchIsDirty) {
        branchIsDirty = await checkDirty();
      }

      // Only pull if branch is clean
      if (!branchIsDirty) {
        hasPulled = true;
        await pullLatest();
        // Recheck dirty status after pull
        branchIsDirty = await checkDirty();
      } else {
        // Branch already has local changes, skip pull
        hasPulled = true;
        console.log(`[GitSync] Skipping pull - branch has uncommitted changes`);
      }
    });

    // Reset state on agent end (new session will need fresh pull)
    pi.on("agent_end", async () => {
      hasPulled = false;
      branchIsDirty = false;
    });
  };
}
