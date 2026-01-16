/**
 * Agent
 *
 * Wraps pi-mono's createAgentSession to run coding tasks and stream events back to Gateway.
 */

import { exec } from "child_process";
import { promisify } from "util";
import {
  createAgentSession,
  createCodingTools,
  discoverAuthStorage,
  discoverModels,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { Env } from "./types.js";
import { EventReporter } from "./reporter.js";
import { createCustomTools, setMissionCreator, addContributor } from "./tools/index.js";
import { buildSystemPrompt } from "./system-prompt.js";

const execAsync = promisify(exec);

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
    // Configure git attribution (mission creator is primary author)
    await execAsync(
      `git config user.name "${env.GIT_AUTHOR_NAME}" && git config user.email "${env.GIT_AUTHOR_EMAIL}"`,
      { cwd: env.WORKSPACE }
    );
    console.log(`[Agent] Git configured for: ${env.GIT_AUTHOR_NAME} <${env.GIT_AUTHOR_EMAIL}>`);

    // Pull latest changes before starting (in case someone pushed externally)
    try {
      const repoUrl = `https://${env.GITHUB_USERNAME}:${env.GITHUB_TOKEN}@github.com/${env.REPO_OWNER}/${env.REPO_NAME}.git`;
      await execAsync(`git pull ${repoUrl} ${env.BRANCH_NAME} --rebase --autostash`, { cwd: env.WORKSPACE });
      console.log(`[Agent] Pulled latest changes from ${env.BRANCH_NAME}`);
    } catch (pullError) {
      // Branch may not exist on remote yet, that's fine
      console.log(`[Agent] No remote changes to pull (branch may not exist yet)`);
    }

    // Set mission creator for co-author tracking
    setMissionCreator({
      id: env.PROMPT_SENDER_ID, // On first run, sender is the creator
      name: env.GIT_AUTHOR_NAME,
      email: env.GIT_AUTHOR_EMAIL,
    });

    // Track prompt sender as contributor (excluded if same as mission creator)
    addContributor({
      id: env.PROMPT_SENDER_ID,
      name: env.PROMPT_SENDER_NAME,
      email: env.PROMPT_SENDER_EMAIL,
    });
    // Set up auth storage with the provided API key
    const authStorage = discoverAuthStorage();
    authStorage.setRuntimeApiKey(provider, env.LLM_API_KEY);

    // Set up model registry and find the model
    const modelRegistry = discoverModels(authStorage);
    const model = modelRegistry.find(provider, modelId);
    if (!model) {
      throw new Error(`Model not found: ${provider}/${modelId}`);
    }

    // Session directory for this mission (outside workspace to avoid committing)
    const sessionDir = `/opt/flightplan/sessions/${env.MISSION_ID}`;

    // Use continueRecent to resume existing session, or create new one if none exists
    // The session file will be saved to the workspace and checkpointed with the Sprite
    const { session } = await createAgentSession({
      cwd: env.WORKSPACE,
      model,
      thinkingLevel: "off",
      authStorage,
      modelRegistry,
      systemPrompt: buildSystemPrompt(env),
      sessionManager: SessionManager.continueRecent(env.WORKSPACE, sessionDir),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true }, // Enable compaction to manage context length
        retry: { enabled: true, maxRetries: 3 },
      }),
      tools: createCodingTools(env.WORKSPACE),
      customTools: createCustomTools({ cwd: env.WORKSPACE, env, reporter }),
      // Disable discovery (no extensions, skills, context files in sandbox)
      skills: [],
      contextFiles: [],
      promptTemplates: [],
    });

    // Track message content for message:end event
    let currentMessageId: string | undefined;
    let currentMessageContent = "";

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
          currentMessageId = `msg_${Date.now()}`;
          currentMessageContent = "";
          await reporter.report({
            type: "message:start",
            messageId: currentMessageId,
            role: "assistant",
          });
          break;

        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta" && currentMessageId) {
            const delta = event.assistantMessageEvent.delta;
            currentMessageContent += delta;
            await reporter.report({
              type: "message:delta",
              messageId: currentMessageId,
              delta,
            });
          }
          break;

        case "message_end":
          if (currentMessageId) {
            await reporter.report({
              type: "message:end",
              messageId: currentMessageId,
              content: currentMessageContent,
            });
            currentMessageId = undefined;
            currentMessageContent = "";
          }
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

        case "tool_execution_end": {
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

        case "auto_compaction_end":
          // Context was compacted to manage token limits
          if (event.result) {
            await reporter.report({
              type: "system:compaction",
              summary: event.result.summary,
            });
          }
          break;
      }
    });

    // Run the prompt with sender attribution
    const promptWithSender = `[${env.PROMPT_SENDER_NAME}]: ${env.PROMPT}`;
    await session.prompt(promptWithSender);

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
