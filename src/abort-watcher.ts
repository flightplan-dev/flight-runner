/**
 * Abort Watcher
 *
 * Polls the filesystem for an abort signal file.
 * When the file exists, triggers the abort callback.
 *
 * The abort file is created by the Gateway via sprites.dev exec API:
 *   POST /api/sprites/exec { "command": "touch /tmp/flightplan-abort" }
 */

import { existsSync, unlinkSync } from "fs";

const ABORT_FILE = "/tmp/flightplan-abort";
const POLL_INTERVAL_MS = 1000; // Check every second

export class AbortWatcher {
  private intervalId: NodeJS.Timeout | null = null;
  private aborted = false;

  /**
   * Start watching for abort signal.
   * @param onAbort - Callback to invoke when abort is detected
   */
  start(onAbort: () => void): void {
    if (this.intervalId) {
      return; // Already watching
    }

    this.intervalId = setInterval(() => {
      if (this.aborted) {
        return;
      }

      if (existsSync(ABORT_FILE)) {
        this.aborted = true;
        this.stop();

        // Clean up the abort file
        try {
          unlinkSync(ABORT_FILE);
        } catch {
          // Ignore cleanup errors
        }

        console.log("[AbortWatcher] Abort signal detected");
        onAbort();
      }
    }, POLL_INTERVAL_MS);
  }

  /**
   * Stop watching for abort signal.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Check if abort was triggered.
   */
  get wasAborted(): boolean {
    return this.aborted;
  }
}
