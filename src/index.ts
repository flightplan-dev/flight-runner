#!/usr/bin/env node
/**
 * flight-runner
 *
 * Agent runner for Flightplan missions.
 * Runs inside sandboxes and executes coding tasks using LLM APIs.
 *
 * Environment variables:
 * - GATEWAY_URL: URL of the Flightplan gateway
 * - GATEWAY_SECRET: Secret for authenticating with the gateway
 * - MISSION_ID: ID of the mission being executed
 * - PROMPT: The prompt/task to execute
 * - MODEL: The LLM model to use (e.g., claude-sonnet-4-20250514)
 * - LLM_API_KEY: API key for the LLM provider
 * - WORKSPACE: Path to the workspace directory
 */

import { EnvSchema } from "./types.js";
import { Agent } from "./agent.js";

async function main(): Promise<void> {
  console.log("[flight-runner] Starting...");

  // Parse and validate environment
  const envResult = EnvSchema.safeParse(process.env);

  if (!envResult.success) {
    console.error("[flight-runner] Invalid environment variables:");
    for (const error of envResult.error.errors) {
      console.error(`  - ${error.path.join(".")}: ${error.message}`);
    }
    process.exit(1);
  }

  const env = envResult.data;

  console.log(`[flight-runner] Mission: ${env.MISSION_ID}`);
  console.log(`[flight-runner] Model: ${env.MODEL}`);
  console.log(`[flight-runner] Workspace: ${env.WORKSPACE}`);
  console.log(`[flight-runner] Gateway: ${env.GATEWAY_URL}`);

  // Run the agent
  const agent = new Agent(env);

  try {
    await agent.run(env.PROMPT);
    console.log("[flight-runner] Completed successfully");
    process.exit(0);
  } catch (error) {
    console.error("[flight-runner] Failed:", error);
    process.exit(1);
  }
}

main();
