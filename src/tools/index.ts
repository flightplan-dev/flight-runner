/**
 * Tools
 *
 * Custom tools for flight-runner (used via customTools option).
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createPrTool, type CreatePrToolOptions } from "./pr.js";
import { createPrStatusTool, type CreatePrStatusToolOptions } from "./pr-status.js";

export { setMissionCreator, addContributor } from "./pr.js";
export type { Contributor } from "./pr.js";

export interface CreateCustomToolsOptions extends CreatePrToolOptions, CreatePrStatusToolOptions {}

/**
 * Create custom tools for flight-runner.
 * These are registered via customTools option (in addition to built-in coding tools).
 */
export function createCustomTools(options: CreateCustomToolsOptions): ToolDefinition<any>[] {
  return [
    createPrTool(options),
    createPrStatusTool(options),
  ];
}
