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
