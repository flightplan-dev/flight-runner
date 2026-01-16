/**
 * Tools
 *
 * Custom tools for flight-runner (used via customTools option).
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createPrTool, type CreatePrToolOptions } from "./pr.js";

export { setMissionCreator, addContributor } from "./pr.js";
export type { Contributor } from "./pr.js";

export interface CreateCustomToolsOptions extends CreatePrToolOptions {}

/**
 * Create custom tools for flight-runner.
 * These are registered via customTools option (in addition to built-in coding tools).
 */
export function createCustomTools(options: CreateCustomToolsOptions): ToolDefinition<any>[] {
  return [createPrTool(options)];
}
