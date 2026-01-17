/**
 * Git Sync Extension
 *
 * - Updates the `origin` remote URL with fresh credentials on startup
 * - Pulls latest changes from remote before first file modification
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
    // Track if we've pulled since last commit (or session start)
    let hasPulledSinceCommit = false;
    let hasUpdatedRemote = false;

    // Update origin remote with fresh token (handles checkpointed sprites with stale tokens)
    async function updateRemoteUrl(): Promise<void> {
      if (hasUpdatedRemote) return;
      hasUpdatedRemote = true;

      try {
        await pi.exec("git", ["remote", "set-url", "origin", config.repoUrl], {
          cwd: config.cwd,
        });
        console.log(`[GitSync] Updated origin remote URL with fresh credentials`);
      } catch (error) {
        console.warn(`[GitSync] Failed to update remote URL:`, error);
      }
    }

    // Check if branch is dirty (has uncommitted changes)
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

    // Bash commands that modify files
    const bashWritePatterns = [
      /\becho\s+.*>/,      // echo > file, echo >> file
      /\bcat\s+.*>/,       // cat > file
      /\bprintf\s+.*>/,    // printf > file
      /\btee\b/,           // tee file
      /\bsed\s+-i/,        // sed -i (in-place edit)
      /\bawk\s+-i/,        // awk -i inplace
      /\bmv\b/,            // mv (rename/move)
      /\bcp\b/,            // cp (copy)
      /\brm\b/,            // rm (delete)
      /\btouch\b/,         // touch (create/update)
      /\bmkdir\b/,         // mkdir
      /\brmdir\b/,         // rmdir
      /\bnpm\s+(install|i|ci|update)\b/,  // npm install
      /\byarn\s+(add|install)\b/,         // yarn add/install
      /\bpnpm\s+(add|install|i)\b/,       // pnpm add/install
      /\bgit\s+(checkout|reset|clean|stash)/,  // git commands that modify working tree
    ];

    function isBashWriteCommand(command: string): boolean {
      return bashWritePatterns.some((pattern) => pattern.test(command));
    }

    // Intercept file modification tools
    pi.on("tool_call", async (event, _ctx) => {
      // Always ensure remote URL is updated with fresh token
      await updateRemoteUrl();

      // Check write/edit tools
      const writeTools = ["write", "edit"];
      const isWriteTool = writeTools.includes(event.toolName);
      
      // Check bash commands that modify files
      const isBashWrite = event.toolName === "bash" && 
        event.input?.command && 
        isBashWriteCommand(event.input.command as string);

      if (!isWriteTool && !isBashWrite) {
        return;
      }

      // Already pulled since last commit
      if (hasPulledSinceCommit) {
        return;
      }

      // Check if branch is dirty (has uncommitted changes)
      const isDirty = await checkDirty();

      if (!isDirty) {
        // Branch is clean - pull latest before making changes
        hasPulledSinceCommit = true;
        await pullLatest();
      } else {
        // Branch has uncommitted changes - can't pull safely
        hasPulledSinceCommit = true;
        console.log(`[GitSync] Skipping pull - branch has uncommitted changes`);
      }
    });

    // Detect git commit commands - reset pull flag so we can pull again
    pi.on("tool_result", async (event, _ctx) => {
      if (event.toolName === "bash" && event.input?.command) {
        const command = event.input.command as string;
        // Check if this was a commit command
        if (/\bgit\s+commit\b/.test(command) && !event.isError) {
          console.log(`[GitSync] Commit detected - will pull before next modification`);
          hasPulledSinceCommit = false;
        }
      }
    });

    // Update remote URL on agent start (before any git operations)
    pi.on("agent_start", async () => {
      await updateRemoteUrl();
    });

    // Reset state on agent end
    pi.on("agent_end", async () => {
      hasPulledSinceCommit = false;
    });
  };
}
