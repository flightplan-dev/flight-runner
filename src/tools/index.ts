/**
 * Tools
 *
 * Combines pi-mono's coding tools with Flightplan-specific tools.
 */

import { createCodingTools } from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createPrTool, type CreatePrToolOptions } from "./pr.js";

export { setMissionCreator, addContributor } from "./pr.js";
export type { Contributor } from "./pr.js";

export interface CreateToolsOptions extends CreatePrToolOptions {}

/**
 * Create all tools for flight-runner.
 * Includes pi-mono coding tools (read, write, edit, bash, etc.) plus Flightplan tools (create_pr).
 */
export function createTools(options: CreateToolsOptions): AgentTool<any>[] {
  const codingTools = createCodingTools(options.cwd);
  const prTool = createPrTool(options);

  return [...codingTools, prTool];
}
