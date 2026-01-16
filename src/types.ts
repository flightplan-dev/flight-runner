/**
 * Types for flight-runner
 */

import { z } from "zod";

// =============================================================================
// Environment Variables
// =============================================================================

export const EnvSchema = z.object({
  GATEWAY_URL: z.string().url(),
  WEBHOOK_SECRET: z.string().min(1), // HMAC secret for signing webhook requests
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
  | "tool:update"
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
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolUpdateEvent extends BaseEvent {
  type: "tool:update";
  toolCallId: string;
  delta: string;
}

export interface ToolEndEvent extends BaseEvent {
  type: "tool:end";
  toolCallId: string;
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
  | ToolUpdateEvent
  | ToolEndEvent;
