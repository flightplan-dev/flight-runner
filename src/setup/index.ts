#!/usr/bin/env node
/**
 * flightplan-setup
 *
 * Sets up the environment for a Flightplan mission.
 * Runs as a separate process before the LLM agent starts.
 *
 * 1. Reads flightplan.yml
 * 2. Installs and starts services (Postgres, Redis)
 * 3. Copies env files, injects secrets
 * 4. Runs setup commands
 * 5. Starts dev server (if configured)
 * 6. Waits for port to be ready
 * 7. Writes status file and exits
 *
 * Usage:
 *   flightplan-setup [workspace]
 *
 * Environment variables:
 *   WORKSPACE      Path to workspace (or pass as first arg)
 *   SECRETS_JSON   JSON object of org secrets (optional)
 *   KEEP_ALIVE     If "true", keeps running to maintain dev server
 *
 * Output:
 *   Writes .flightplan-status.json to workspace on success
 */

import { spawn, ChildProcess } from "child_process";
import { copyFile, readFile, writeFile, appendFile, access } from "fs/promises";
import { createWriteStream, WriteStream } from "fs";
import { join, resolve } from "path";
import {
  loadConfig,
  getSetupCommands,
  getDevServerConfig,
  getEnvFromFile,
  waitForPort,
  type InterpolationContext,
} from "../config.js";
import { startService, type ServiceInstance } from "./services.js";

// =============================================================================
// Logging
// =============================================================================

let logFile: WriteStream | null = null;
const LOG_PATH = "/tmp/flightplan-setup.log";

function initLog(): void {
  logFile = createWriteStream(LOG_PATH, { flags: "w" });
  log(`[setup] Log started at ${new Date().toISOString()}`);
}

function log(message: string): void {
  console.log(message);
  if (logFile) {
    logFile.write(message + "\n");
  }
}

function logError(message: string): void {
  console.error(message);
  if (logFile) {
    logFile.write("[ERROR] " + message + "\n");
  }
}

// =============================================================================
// Types
// =============================================================================

interface SetupStatus {
  /** Current status: running while in progress, ready on success, failed on error */
  status: "running" | "ready" | "failed";
  /** ISO timestamp of last update */
  timestamp: string;
  /** Current step description (only while running) */
  step?: string;
  /** Started services */
  services: ServiceInstance[];
  /** Dev server info (if configured) */
  devServer?: {
    port: number;
    pid?: number;
  };
  /** Resolved environment variables */
  env: Record<string, string>;
  /** Error message (only if status is "failed") */
  error?: string;
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  // Handle --help
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  // Initialize log file
  initLog();

  log("[setup] Starting flightplan-setup...");

  // Get workspace from arg or env
  const workspace = process.argv[2] || process.env.WORKSPACE;
  if (!workspace) {
    logError("[setup] Error: WORKSPACE is required");
    logError("[setup] Usage: flightplan-setup <workspace>");
    process.exit(1);
  }

  const resolvedWorkspace = resolve(workspace);
  log(`[setup] Workspace: ${resolvedWorkspace}`);

  const secretsJson = process.env.SECRETS_JSON;
  const keepAlive = process.env.KEEP_ALIVE === "true";

  // Parse secrets
  let secrets: Record<string, string> = {};
  if (secretsJson) {
    try {
      secrets = JSON.parse(secretsJson);
      log(`[setup] Loaded ${Object.keys(secrets).length} secrets`);
    } catch (e) {
      logError(`[setup] Failed to parse SECRETS_JSON: ${e}`);
      process.exit(1);
    }
  }

  // Track status for output
  const status: SetupStatus = {
    status: "running",
    timestamp: new Date().toISOString(),
    services: [],
    env: {},
  };

  // Helper to update status file with current step
  const updateStatus = async (step: string) => {
    status.step = step;
    status.timestamp = new Date().toISOString();
    await writeStatus(resolvedWorkspace, status).catch(() => {});
  };

  try {
    // Write initial "running" status so poller knows we've started
    await updateStatus("initializing");

    // Build initial context with any pre-existing service URLs from environment
    const context: InterpolationContext = { services: {}, secrets };
    
    // Check for pre-existing service URLs (e.g., Sprite-provided services)
    if (process.env.POSTGRES_URL) {
      context.services.POSTGRES_URL = process.env.POSTGRES_URL;
    }
    if (process.env.REDIS_URL) {
      context.services.REDIS_URL = process.env.REDIS_URL;
    }
    if (process.env.DATABASE_URL) {
      context.services.DATABASE_URL = process.env.DATABASE_URL;
    }
    
    // Load config
    const { config, source, services } = await loadConfig(resolvedWorkspace, context);

    log(`[setup] Config source: ${source}`);

    if (source === "none") {
      log("[setup] No flightplan.yml found - running with defaults");
    }

    // Step 1: Start services (install if needed)
    if (services.length > 0) {
      log(`[setup] Starting ${services.length} service(s)...`);

      for (const serviceConfig of services) {
        await updateStatus(`installing ${serviceConfig.name}`);
        const instance = await startService(serviceConfig);
        status.services.push(instance);

        // Update context with service URL
        context.services[serviceConfig.envVar] = instance.url;
      }
    }

    // Reload config with service URLs populated
    const { resolvedEnv } = await loadConfig(resolvedWorkspace, context);
    status.env = resolvedEnv;

    // Step 2: Copy env file if specified
    await updateStatus("configuring environment");
    const envFromFile = getEnvFromFile(config);
    if (envFromFile) {
      await copyEnvFile(resolvedWorkspace, envFromFile);
    }

    // Step 3: Write resolved env vars to .env (append or create)
    if (Object.keys(resolvedEnv).length > 0) {
      await writeEnvVars(resolvedWorkspace, resolvedEnv);
    }

    // Export env vars to current process (for setup commands)
    for (const [key, value] of Object.entries(resolvedEnv)) {
      process.env[key] = value;
    }

    // Also export service URLs directly
    for (const service of status.services) {
      const envVar = services.find((s) => s.name === service.name)?.envVar;
      if (envVar) {
        process.env[envVar] = service.url;
      }
    }

    // Step 4: Run setup commands
    const setupCommands = getSetupCommands(config);
    if (setupCommands.length > 0) {
      log(`[setup] Running ${setupCommands.length} setup command(s)...`);
      for (let i = 0; i < setupCommands.length; i++) {
        const cmd = setupCommands[i];
        await updateStatus(`setup command ${i + 1}/${setupCommands.length}`);
        await runCommand(cmd, resolvedWorkspace);
      }
    }

    // Step 5: Start dev server if configured
    const devServer = getDevServerConfig(config);
    let devServerProcess: ChildProcess | null = null;

    if (devServer) {
      await updateStatus("starting dev server");
      log(`[setup] Starting dev server: ${devServer.command}`);
      devServerProcess = startDevServer(devServer.command, resolvedWorkspace);

      status.devServer = {
        port: devServer.port,
        pid: devServerProcess.pid,
      };

      // Step 6: Wait for port
      await updateStatus("waiting for dev server");
      log(`[setup] Waiting for port ${devServer.port}...`);
      await waitForPort(devServer.port, devServer.timeout * 1000);
      log(`[setup] Dev server ready on port ${devServer.port}`);
    }

    // Mark as ready and write status
    status.status = "ready";
    status.step = undefined;
    await writeStatus(resolvedWorkspace, status);

    // Print summary
    printSummary(status);

    // If keep alive, wait forever (to keep dev server running)
    if (keepAlive && devServerProcess) {
      console.log("[setup] Keeping alive for dev server (Ctrl+C to stop)...");

      // Handle graceful shutdown
      process.on("SIGINT", () => {
        console.log("\n[setup] Shutting down...");
        if (devServerProcess) {
          devServerProcess.kill();
        }
        process.exit(0);
      });

      process.on("SIGTERM", () => {
        console.log("[setup] Received SIGTERM, shutting down...");
        if (devServerProcess) {
          devServerProcess.kill();
        }
        process.exit(0);
      });

      await new Promise(() => {}); // Never resolves
    }

    process.exit(0);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logError(`[setup] ✗ Setup failed: ${errorMessage}`);

    status.status = "failed";
    status.error = errorMessage;
    await writeStatus(resolvedWorkspace, status).catch(() => {});

    process.exit(1);
  }
}

function printUsage(): void {
  console.log(`
flightplan-setup - Set up environment for a Flightplan mission

USAGE:
  flightplan-setup <workspace>
  flightplan-setup --help

ARGUMENTS:
  workspace    Path to the project directory containing flightplan.yml

ENVIRONMENT:
  WORKSPACE         Alternative to passing workspace as argument
  FLIGHTPLAN_CONFIG YAML config string (overrides flightplan.yml in repo)
  SECRETS_JSON      JSON object with org secrets, e.g., '{"API_KEY":"xxx"}'
  KEEP_ALIVE        Set to "true" to keep running (for dev server)
  POSTGRES_URL      If set, uses existing Postgres instead of installing
  REDIS_URL         If set, uses existing Redis instead of installing

SERVICES:
  Services are installed directly on the system (no Docker):
  - postgres:16  → Installs PostgreSQL 16, creates 'flightplan' database
  - redis:7      → Installs Redis 7

EXAMPLES:
  # Basic setup
  flightplan-setup /path/to/project

  # With secrets
  SECRETS_JSON='{"STRIPE_KEY":"sk_test_xxx"}' flightplan-setup ./myapp

  # Keep alive for dev server
  KEEP_ALIVE=true flightplan-setup ./myapp

  # Use existing database
  POSTGRES_URL='postgres://user:pass@localhost/mydb' flightplan-setup ./myapp

OUTPUT:
  On success, writes .flightplan-status.json to the workspace with:
  - Service URLs (POSTGRES_URL, etc.)
  - Dev server port and PID
  - Resolved environment variables
`);
}

// =============================================================================
// Summary
// =============================================================================

function printSummary(status: SetupStatus): void {
  console.log("");
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║                    FLIGHTPLAN SETUP COMPLETE                   ║");
  console.log("╠════════════════════════════════════════════════════════════════╣");

  if (status.services.length > 0) {
    console.log("║  Services:                                                     ║");
    for (const svc of status.services) {
      const line = `    ${svc.name}: ${svc.url}`;
      console.log(`║  ${line.padEnd(62)}║`);
    }
  }

  if (status.devServer) {
    console.log("║  Dev Server:                                                   ║");
    const line = `    Port ${status.devServer.port} (PID: ${status.devServer.pid || "unknown"})`;
    console.log(`║  ${line.padEnd(62)}║`);
  }

  const envCount = Object.keys(status.env).length;
  if (envCount > 0) {
    console.log(`║  Environment: ${envCount} variable(s) configured`.padEnd(65) + "║");
  }

  console.log("╠════════════════════════════════════════════════════════════════╣");
  console.log("║  ✓ Ready for flight-runner                                     ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log("");
}

// =============================================================================
// Status File
// =============================================================================

async function writeStatus(workspace: string, status: SetupStatus): Promise<void> {
  const statusPath = join(workspace, ".flightplan-status.json");
  await writeFile(statusPath, JSON.stringify(status, null, 2));
}

// =============================================================================
// Environment Files
// =============================================================================

async function copyEnvFile(workspace: string, fromFile: string): Promise<void> {
  const source = join(workspace, fromFile);
  const dest = join(workspace, ".env");

  try {
    await access(source);
  } catch {
    console.warn(`[setup] Env file not found: ${fromFile}, skipping copy`);
    return;
  }

  log(`[setup] Copying ${fromFile} → .env`);
  await copyFile(source, dest);
}

async function writeEnvVars(
  workspace: string,
  vars: Record<string, string>
): Promise<void> {
  const envPath = join(workspace, ".env");

  // Read existing .env if it exists
  let existing = "";
  try {
    existing = await readFile(envPath, "utf-8");
    if (!existing.endsWith("\n")) {
      existing += "\n";
    }
  } catch {
    // File doesn't exist, start fresh
  }

  // Parse existing vars to avoid duplicates
  const existingKeys = new Set<string>();
  for (const line of existing.split("\n")) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match) {
      existingKeys.add(match[1]);
    }
  }

  // Append new vars
  const lines: string[] = [];
  lines.push("# Flightplan-managed environment variables");

  for (const [key, value] of Object.entries(vars)) {
    if (existingKeys.has(key)) {
      log(`[setup] Skipping ${key} (already in .env)`);
      continue;
    }
    // Quote values with spaces or special chars
    const needsQuotes = /[\s"'$`\\]/.test(value);
    const quotedValue = needsQuotes ? `"${value.replace(/"/g, '\\"')}"` : value;
    lines.push(`${key}=${quotedValue}`);
    log(`[setup] Set ${key}`);
  }

  if (lines.length > 1) {
    const content = existing + lines.join("\n") + "\n";
    await writeFile(envPath, content);
  }
}

// =============================================================================
// Command Execution
// =============================================================================

async function runCommand(command: string, cwd: string): Promise<void> {
  log(`[setup] $ ${command}`);
  log(`[setup]   cwd: ${cwd}`);

  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      cwd,
      env: { ...process.env },
    });

    child.stdout?.on("data", (data) => {
      const output = data.toString();
      process.stdout.write(output);
      if (logFile) {
        logFile.write(output);
      }
    });

    child.stderr?.on("data", (data) => {
      const output = data.toString();
      process.stderr.write(output);
      if (logFile) {
        logFile.write("[stderr] " + output);
      }
    });

    child.on("close", (code) => {
      log(`[setup]   exit code: ${code}`);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}: ${command}`));
      }
    });

    child.on("error", (err) => {
      logError(`[setup]   error: ${err.message}`);
      reject(err);
    });
  });
}

function startDevServer(command: string, cwd: string): ChildProcess {
  const child = spawn("bash", ["-c", command], {
    cwd,
    stdio: "inherit",
    env: { ...process.env },
    detached: true,
  });

  child.unref();

  child.on("error", (err) => {
    logError(`[setup] Dev server error: ${err}`);
  });

  child.on("close", (code) => {
    if (code !== 0 && code !== null) {
      logError(`[setup] Dev server exited with code ${code}`);
    }
  });

  return child;
}

// =============================================================================
// Entry Point
// =============================================================================

main();
