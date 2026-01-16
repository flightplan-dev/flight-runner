/**
 * Agent
 *
 * Wraps pi-mono's createAgentSession to run coding tasks and stream events back to Gateway.
 */

import {
  createAgentSession,
  discoverAuthStorage,
  discoverModels,
  SessionManager,
  SettingsManager,
  createCodingTools,
} from "@mariozechner/pi-coding-agent";
import type { Env } from "./types.js";
import { EventReporter } from "./reporter.js";

// =============================================================================
// Model Mapping
// =============================================================================

// Map friendly model names to pi-mono provider/model pairs
const MODEL_MAP: Record<string, { provider: string; modelId: string }> = {
  // Claude 4.5 models (latest)
  "claude-sonnet-4.5": { provider: "anthropic", modelId: "claude-sonnet-4-5" },
  "claude-opus-4.5": { provider: "anthropic", modelId: "claude-opus-4-5" },
  // Claude 4 models
  "claude-sonnet-4": { provider: "anthropic", modelId: "claude-sonnet-4" },
  "claude-opus-4": { provider: "anthropic", modelId: "claude-opus-4-0" },
  // OpenAI models
  "gpt-4o": { provider: "openai", modelId: "gpt-4o" },
  "gpt-4.1": { provider: "openai", modelId: "gpt-4.1" },
};

function resolveModel(modelName: string): { provider: string; modelId: string } {
  // Check if it's a friendly name
  if (MODEL_MAP[modelName]) {
    return MODEL_MAP[modelName];
  }

  // Assume it's already in provider/model format or just a model ID
  if (modelName.includes("/")) {
    const [provider, modelId] = modelName.split("/", 2);
    return { provider, modelId };
  }

  // Default to Anthropic
  return { provider: "anthropic", modelId: modelName };
}

// =============================================================================
// Agent Runner
// =============================================================================

export async function runAgent(env: Env): Promise<void> {
  const reporter = new EventReporter(env);
  const { provider, modelId } = resolveModel(env.MODEL);

  console.log(`[Agent] Starting with model: ${provider}/${modelId}`);
  console.log(`[Agent] Workspace: ${env.WORKSPACE}`);
  console.log(`[Agent] Prompt: ${env.PROMPT.slice(0, 100)}...`);

  // Report start
  await reporter.report({
    type: "agent:start",
    model: `${provider}/${modelId}`,
  });

  try {
    // Set up auth storage with the provided API key
    const authStorage = discoverAuthStorage();
    authStorage.setRuntimeApiKey(provider, env.LLM_API_KEY);

    // Set up model registry and find the model
    const modelRegistry = discoverModels(authStorage);
    const model = modelRegistry.find(provider, modelId);
    if (!model) {
      throw new Error(`Model not found: ${provider}/${modelId}`);
    }

    // Session directory for this mission (persisted in Sprite filesystem)
    const sessionDir = `${env.WORKSPACE}/.flightplan/sessions`;

    // Use continueRecent to resume existing session, or create new one if none exists
    // The session file will be saved to the workspace and checkpointed with the Sprite
    const { session } = await createAgentSession({
      cwd: env.WORKSPACE,
      model,
      thinkingLevel: "off",
      authStorage,
      modelRegistry,
      sessionManager: SessionManager.continueRecent(env.WORKSPACE, sessionDir),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true }, // Enable compaction to manage context length
        retry: { enabled: true, maxRetries: 3 },
      }),
      tools: createCodingTools(env.WORKSPACE),
      // Disable discovery (no extensions, skills, context files in sandbox)
      skills: [],
      contextFiles: [],
      promptTemplates: [],
    });

    // Track message content for message:end event
    // We defer sending message:start until we actually have text content
    // (some messages only contain tool calls or thinking blocks)
    let currentMessageId: string | undefined;
    let currentMessageContent = "";
    let messageStartSent = false;

    // Subscribe to events and forward to Gateway
    session.subscribe(async (event) => {
      switch (event.type) {
        case "agent_start":
          // Already reported above
          break;

        case "agent_end":
          // Handled after prompt() returns
          break;

        case "message_start":
          // Don't send message:start yet - wait for actual text content
          currentMessageId = `msg_${Date.now()}`;
          currentMessageContent = "";
          messageStartSent = false;
          break;

        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta" && currentMessageId) {
            const delta = event.assistantMessageEvent.delta;
            
            // Send message:start on first text delta (lazy initialization)
            if (!messageStartSent) {
              await reporter.report({
                type: "message:start",
                messageId: currentMessageId,
                role: "assistant",
              });
              messageStartSent = true;
            }
            
            currentMessageContent += delta;
            await reporter.report({
              type: "message:delta",
              messageId: currentMessageId,
              delta,
            });
          }
          break;

        case "message_end":
          // Only send message:end if we actually sent message:start
          if (currentMessageId && messageStartSent && currentMessageContent) {
            await reporter.report({
              type: "message:end",
              messageId: currentMessageId,
              content: currentMessageContent,
            });
          }
          currentMessageId = undefined;
          currentMessageContent = "";
          messageStartSent = false;
          break;

        case "tool_execution_start":
          await reporter.report({
            type: "tool:start",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.args as Record<string, unknown>,
          });
          break;

        case "tool_execution_update":
          // partialResult contains streaming output from tools
          const partialOutput = event.partialResult?.content?.[0];
          if (partialOutput && "text" in partialOutput) {
            await reporter.report({
              type: "tool:update",
              toolCallId: event.toolCallId,
              delta: partialOutput.text,
            });
          }
          break;

        case "tool_execution_end":
          // result contains the final tool output
          const resultContent = event.result?.content?.[0];
          const output = resultContent && "text" in resultContent ? resultContent.text : JSON.stringify(event.result);
          await reporter.report({
            type: "tool:end",
            toolCallId: event.toolCallId,
            output,
            isError: event.isError,
          });
          break;
      }
    });

    // Run the prompt
    await session.prompt(env.PROMPT);

    // Wait for agent to finish
    await session.agent.waitForIdle();

    // Report completion
    await reporter.report({
      type: "agent:end",
    });

    // Clean up
    session.dispose();

    console.log("[Agent] Completed successfully");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Agent] Error:", error);

    await reporter.report({
      type: "agent:error",
      error: message,
    });

    throw error;
  } finally {
    await reporter.drain();
  }
}
