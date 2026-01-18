#!/usr/bin/env node
/**
 * flightplan-wait
 * 
 * Waits for flightplan-setup to complete.
 * Useful when setup and agent run in parallel.
 * 
 * Usage:
 *   flightplan-wait [workspace] [--timeout=60]
 * 
 * Exit codes:
 *   0 - Setup completed successfully
 *   1 - Setup failed
 *   2 - Timeout waiting for setup
 */

import { readFile, access } from "fs/promises";
import { join, resolve } from "path";

interface SetupStatus {
  /** Current status: running while in progress, ready on success, failed on error */
  status: "running" | "ready" | "failed";
  /** Current step description (only while running) */
  step?: string;
  /** Error message (only if status is "failed") */
  error?: string;
  /** Started services */
  services: Array<{ name: string; url: string; port: number }>;
  /** Dev server info (if configured) */
  devServer?: { port: number; pid?: number };
  /** Resolved environment variables */
  env: Record<string, string>;
}

async function main(): Promise<void> {
  // Parse args
  const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const flags = process.argv.slice(2).filter(a => a.startsWith("--"));
  
  const workspace = args[0] || process.env.WORKSPACE || "/workspace";
  const timeoutFlag = flags.find(f => f.startsWith("--timeout="));
  const timeout = timeoutFlag ? parseInt(timeoutFlag.split("=")[1]) * 1000 : 60000;
  
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`
flightplan-wait - Wait for setup to complete

USAGE:
  flightplan-wait [workspace] [--timeout=60]

OPTIONS:
  --timeout=N   Max seconds to wait (default: 60)

EXIT CODES:
  0 - Setup ready
  1 - Setup failed  
  2 - Timeout
`);
    process.exit(0);
  }

  const resolvedWorkspace = resolve(workspace);
  const statusPath = join(resolvedWorkspace, ".flightplan-status.json");
  
  console.log(`[wait] Waiting for setup to complete...`);
  console.log(`[wait] Status file: ${statusPath}`);
  console.log(`[wait] Timeout: ${timeout / 1000}s`);
  
  const start = Date.now();
  let lastStep = "";
  
  while (Date.now() - start < timeout) {
    try {
      // Check if status file exists
      await access(statusPath);
      
      // Read and parse
      const content = await readFile(statusPath, "utf-8");
      const status: SetupStatus = JSON.parse(content);
      
      // Log progress if step changed
      if (status.step && status.step !== lastStep) {
        console.log(`[wait] Step: ${status.step}`);
        lastStep = status.step;
      }
      
      if (status.status === "ready") {
        console.log(`[wait] ✓ Setup complete`);
        
        // Print useful info
        if (status.services.length > 0) {
          console.log(`[wait] Services:`);
          for (const svc of status.services) {
            console.log(`[wait]   ${svc.name}: ${svc.url}`);
          }
        }
        
        if (status.devServer) {
          console.log(`[wait] Dev server: port ${status.devServer.port}`);
        }
        
        process.exit(0);
      }
      
      if (status.status === "failed") {
        console.error(`[wait] ✗ Setup failed: ${status.error}`);
        process.exit(1);
      }
      
      // Status is "running", keep waiting
    } catch (err) {
      // File doesn't exist yet or parse error, keep waiting
    }
    
    await sleep(500);
  }
  
  console.error(`[wait] ✗ Timeout waiting for setup after ${timeout / 1000}s`);
  process.exit(2);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main();
