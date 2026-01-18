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
import { QueueClient, } from "./queue-client.js";
import { createCustomTools, setMissionCreator, addContributor } from "./tools/index.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createGitSyncExtension } from "./extension.js";
import { AbortWatcher } from "./abort-watcher.js";

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
  const queueClient = new QueueClient(env);
  const { provider, modelId } = resolveModel(env.MODEL);

  await reporter.sendSystemMessage(`Starting with model: ${provider}/${modelId}`);
  await reporter.sendSystemMessage(`Workspace: ${env.WORKSPACE}`, "debug");

  // Fetch initial messages from queue (includes initial prompt + any follow-ups during setup)
  const initialMessages = await queueClient.fetchPendingMessages();

  if (initialMessages.length === 0) {
    await reporter.sendSystemMessage("No messages in queue, nothing to do", "warn");
    return;
  }

  await reporter.sendSystemMessage(`Found ${initialMessages.length} initial message(s) in queue`, "debug");

  // Report start
  await reporter.report({
    type: "agent:start",
    model: `${provider}/${modelId}`,
  });

  try {
    // Build repo URL for git operations (with fresh token)
    const repoUrl = `https://${env.GITHUB_USERNAME}:${env.GITHUB_TOKEN}@github.com/${env.REPO_OWNER}/${env.REPO_NAME}.git`;

    // Configure git attribution (mission creator is primary author)
    await execAsync(
      `git config user.name "${env.GIT_AUTHOR_NAME}" && git config user.email "${env.GIT_AUTHOR_EMAIL}"`,
      { cwd: env.WORKSPACE }
    );
    await reporter.sendSystemMessage(`Git configured for: ${env.GIT_AUTHOR_NAME} <${env.GIT_AUTHOR_EMAIL}>`);

    // Update origin remote URL with fresh token (handles checkpointed sprites with stale tokens)
    await execAsync(`git remote set-url origin "${repoUrl}"`, { cwd: env.WORKSPACE });
    await reporter.sendSystemMessage("Updated origin remote with fresh credentials", "debug");

    // Set mission creator from first message sender
    const firstMessage = initialMessages[0];
    setMissionCreator({
      id: firstMessage.senderId,
      name: firstMessage.senderName,
      email: "", // Email not available from queue
    });

    // Track all message senders as contributors
    for (const msg of initialMessages) {
      addContributor({
        id: msg.senderId,
        name: msg.senderName,
        email: "",
      });
    }
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
      // Git sync extension - pulls latest before first file write if branch is clean
      extensions: [
        createGitSyncExtension({
          repoUrl,
          branchName: env.BRANCH_NAME,
          cwd: env.WORKSPACE,
        }),
      ],
      // Disable discovery (no extensions, skills, context files in sandbox)
      skills: [],
      contextFiles: [],
      promptTemplates: [],
    });


    // Start file-based abort watcher
    // Gateway triggers abort by POSTing to sprites.dev exec API:
    //   POST /api/sprites/exec { "command": "touch /tmp/flightplan-abort" }
    const abortWatcher = new AbortWatcher();

    abortWatcher.start(async () => {
      await reporter.sendSystemMessage("Abort requested, stopping agent...", "warn");
      await session.abort();
      await reporter.sendSystemMessage("Agent aborted");
    });


    // Track message content for message:end event
    let currentMessageId: string | undefined;
    let currentMessageContent = "";

    // Track tool names (tool_execution_end doesn't include toolName)
    const toolNames = new Map<string, string>();

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
          // Only report message:end if there's actual text content
          // (skip tool-only responses that have no text)
          if (currentMessageId && currentMessageContent.trim()) {
            await reporter.report({
              type: "message:end",
              messageId: currentMessageId,
              content: currentMessageContent,
            });
          }
          currentMessageId = undefined;
          currentMessageContent = "";
          break;

        case "tool_execution_start":
          // Track tool name for tool_execution_end (which doesn't include it)
          toolNames.set(event.toolCallId, event.toolName);
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
          const toolName = toolNames.get(event.toolCallId) || "tool";
          toolNames.delete(event.toolCallId); // Clean up
          await reporter.report({
            type: "tool:end",
            toolCallId: event.toolCallId,
            toolName,
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

    // Combine all initial messages into one prompt
    // These are messages that were queued during sandbox setup (configuring state)
    const combinedPrompt = initialMessages
      .map(msg => `[${msg.senderName}]: ${msg.text}`)
      .join("\n\n");

    await reporter.sendSystemMessage(`Running combined initial prompt (${initialMessages.length} messages)`, "debug");

    // Mark all initial messages as delivered
    for (const msg of initialMessages) {
      await queueClient.markDelivered(msg.id);
    }

    // Run the combined prompt
    await session.prompt(combinedPrompt);

    // Wait for agent to finish initial prompt
    await session.agent.waitForIdle();

    // Mark all initial messages as processed
    for (const msg of initialMessages) {
      await queueClient.markProcessed(msg.id);
    }

    try {
      const processedMessageIds: string[] = [];

      while (!abortWatcher.wasAborted) {
        const queuedMessages = await queueClient.fetchPendingMessages();

        if (queuedMessages.length === 0) {
          await reporter.sendSystemMessage("No more queued messages, finishing", "debug");
          break;
        }

        await reporter.sendSystemMessage(`Found ${queuedMessages.length} new queued message(s)`, "debug");

        for (const msg of queuedMessages) {
          if (abortWatcher.wasAborted) break;

          // Mark as delivered
          await queueClient.markDelivered(msg.id);

          // Track contributor for co-author attribution
          addContributor({
            id: msg.senderId,
            name: msg.senderName,
            email: "",
          });

          // Format message with sender attribution
          const formattedMessage = `[${msg.senderName}]: ${msg.text}`;

          await reporter.sendSystemMessage(`Processing queued message (${msg.behavior}): ${msg.text.slice(0, 100)}...`, "debug");

          await session.prompt(formattedMessage, {
            streamingBehavior: msg.behavior === "steer" ? "steer" : "followUp",
          });

          await reporter.sendSystemMessage(`Finished processing message ${msg.id}`, "debug");

          processedMessageIds.push(msg.id);
        }
      }

      for (const id of processedMessageIds) {
        // Mark as processed
        await queueClient.markProcessed(id);
        await reporter.sendSystemMessage(`Processed message ${id}`, "debug");
      }

      await session.agent.waitForIdle();
    } finally {
      abortWatcher.stop();
    }

    // Report completion
    await reporter.report({
      type: "agent:end",
    });

    // Clean up
    session.dispose();

    await reporter.sendSystemMessage("Completed successfully", "debug");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await reporter.sendSystemMessage(`Error: ${message}`, "error");

    await reporter.report({
      type: "agent:error",
      error: message,
    });

    throw error;
  } finally {
    await reporter.drain();
  }
}
