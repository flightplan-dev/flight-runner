/**
 * Agent
 *
 * Main agent loop that processes prompts using Claude API with tools.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlockParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { Env } from "./types.js";
import { EventReporter } from "./reporter.js";
import { ToolExecutor, TOOL_DEFINITIONS } from "./tools.js";

// =============================================================================
// Constants
// =============================================================================

const SYSTEM_PROMPT = `You are an expert software engineer helping with coding tasks.

You have access to tools for reading, writing, and editing files, as well as running bash commands.

Guidelines:
- Read files before editing to understand context
- Use the edit tool for precise changes (oldText must match exactly)
- Use bash for running tests, git operations, installing packages, etc.
- Be concise in your responses
- If you encounter an error, try to fix it rather than giving up

When you're done with your task, explain what you did and any important details.`;

const MAX_TURNS = 50; // Safety limit

// =============================================================================
// Agent
// =============================================================================

export class Agent {
  private client: Anthropic;
  private env: Env;
  private reporter: EventReporter;
  private toolExecutor: ToolExecutor;
  private messages: MessageParam[] = [];
  private totalInputTokens = 0;
  private totalOutputTokens = 0;

  constructor(env: Env) {
    this.env = env;
    this.client = new Anthropic({ apiKey: env.LLM_API_KEY });
    this.reporter = new EventReporter(env);
    this.toolExecutor = new ToolExecutor(env.WORKSPACE);
  }

  /**
   * Run the agent with the given prompt
   */
  async run(prompt: string): Promise<void> {
    console.log(`[Agent] Starting with model: ${this.env.MODEL}`);
    console.log(`[Agent] Workspace: ${this.env.WORKSPACE}`);
    console.log(`[Agent] Prompt: ${prompt.slice(0, 100)}...`);

    await this.reporter.report({
      type: "agent:start",
      model: this.env.MODEL,
    });

    try {
      // Add user message
      this.messages.push({
        role: "user",
        content: prompt,
      });

      // Agent loop
      let turns = 0;
      while (turns < MAX_TURNS) {
        turns++;
        console.log(`[Agent] Turn ${turns}`);

        const shouldContinue = await this.runTurn();
        if (!shouldContinue) {
          break;
        }
      }

      if (turns >= MAX_TURNS) {
        console.warn(`[Agent] Reached max turns limit (${MAX_TURNS})`);
      }

      await this.reporter.report({
        type: "agent:end",
        usage: {
          inputTokens: this.totalInputTokens,
          outputTokens: this.totalOutputTokens,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Agent] Error:`, error);

      await this.reporter.report({
        type: "agent:error",
        error: message,
      });

      throw error;
    } finally {
      await this.reporter.drain();
    }
  }

  /**
   * Run a single turn of the agent loop
   * Returns true if the agent should continue (has tool calls)
   */
  private async runTurn(): Promise<boolean> {
    const messageId = `msg_${Date.now()}`;

    await this.reporter.report({
      type: "message:start",
      messageId,
      role: "assistant",
    });

    // Call Claude API with streaming
    const stream = this.client.messages.stream({
      model: this.env.MODEL,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
      })),
      messages: this.messages,
    });

    // Collect the response
    const contentBlocks: ContentBlockParam[] = [];
    let currentText = "";

    stream.on("text", async (text) => {
      currentText += text;
      await this.reporter.report({
        type: "message:delta",
        messageId,
        delta: text,
      });
    });

    // Wait for the stream to complete
    const response = await stream.finalMessage();

    // Update token counts
    this.totalInputTokens += response.usage.input_tokens;
    this.totalOutputTokens += response.usage.output_tokens;

    // Process content blocks
    for (const block of response.content) {
      if (block.type === "text") {
        contentBlocks.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        contentBlocks.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });
      }
    }

    // Report message end
    await this.reporter.report({
      type: "message:end",
      messageId,
      content: currentText,
    });

    // Add assistant message to history
    this.messages.push({
      role: "assistant",
      content: contentBlocks,
    });

    // Check if there are tool calls
    const toolUses = contentBlocks.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      // No tool calls, we're done
      return false;
    }

    // Execute tools and collect results
    const toolResults: ToolResultBlockParam[] = [];

    for (const toolUse of toolUses) {
      if (toolUse.type !== "tool_use") continue;

      const toolName = toolUse.name;
      const toolInput = toolUse.input as Record<string, unknown>;
      const toolUseId = toolUse.id;

      console.log(`[Agent] Executing tool: ${toolName}`);

      await this.reporter.report({
        type: "tool:start",
        toolUseId,
        toolName,
        input: toolInput,
      });

      const { output, isError } = await this.toolExecutor.execute(
        toolName,
        toolInput,
      );

      await this.reporter.report({
        type: "tool:end",
        toolUseId,
        output,
        isError,
      });

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUseId,
        content: output,
        is_error: isError,
      });
    }

    // Add tool results to history
    this.messages.push({
      role: "user",
      content: toolResults,
    });

    // Continue the loop
    return true;
  }
}
