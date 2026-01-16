/**
 * Types for flight-runner
 */

import { z } from "zod";

// =============================================================================
// Environment Variables
// =============================================================================

export const EnvSchema = z.object({
  GATEWAY_URL: z.string().url(),
  GATEWAY_SECRET: z.string().min(1),
  MISSION_ID: z.string().uuid(),
  PROMPT: z.string().min(1),
  MODEL: z.string().min(1),
  LLM_API_KEY: z.string().min(1),
  WORKSPACE: z.string().min(1),
});

export type Env = z.infer<typeof EnvSchema>;

// =============================================================================
// Events sent back to Gateway
// =============================================================================

export type AgentEventType =
  | "agent:start"
  | "agent:end"
  | "agent:error"
  | "message:start"
  | "message:delta"
  | "message:end"
  | "tool:start"
  | "tool:delta"
  | "tool:end";

export interface BaseEvent {
  type: AgentEventType;
  timestamp: string;
  missionId: string;
}

export interface AgentStartEvent extends BaseEvent {
  type: "agent:start";
  model: string;
}

export interface AgentEndEvent extends BaseEvent {
  type: "agent:end";
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface AgentErrorEvent extends BaseEvent {
  type: "agent:error";
  error: string;
}

export interface MessageStartEvent extends BaseEvent {
  type: "message:start";
  messageId: string;
  role: "assistant";
}

export interface MessageDeltaEvent extends BaseEvent {
  type: "message:delta";
  messageId: string;
  delta: string;
}

export interface MessageEndEvent extends BaseEvent {
  type: "message:end";
  messageId: string;
  content: string;
}

export interface ToolStartEvent extends BaseEvent {
  type: "tool:start";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolDeltaEvent extends BaseEvent {
  type: "tool:delta";
  toolUseId: string;
  delta: string;
}

export interface ToolEndEvent extends BaseEvent {
  type: "tool:end";
  toolUseId: string;
  output: string;
  isError?: boolean;
}

export type AgentEvent =
  | AgentStartEvent
  | AgentEndEvent
  | AgentErrorEvent
  | MessageStartEvent
  | MessageDeltaEvent
  | MessageEndEvent
  | ToolStartEvent
  | ToolDeltaEvent
  | ToolEndEvent;

// =============================================================================
// Tool Definitions
// =============================================================================

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// =============================================================================
// Anthropic API Types
// =============================================================================

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface AnthropicToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
