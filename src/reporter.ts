/**
 * Event Reporter
 *
 * Sends agent events back to the Gateway via HTTP POST.
 * Uses HMAC signatures for authentication.
 */

import { createHmac } from "crypto";
import type {
  AgentEvent,
  AgentStartEvent,
  AgentEndEvent,
  AgentErrorEvent,
  MessageStartEvent,
  MessageDeltaEvent,
  MessageEndEvent,
  ToolStartEvent,
  ToolUpdateEvent,
  ToolEndEvent,
  SystemCompactionEvent,
  SystemMessageEvent,
  SystemMessageLevel,
  PrCreatedEvent,
  PrStatusEvent,
  SetupStatusEvent,
  Env,
} from "./types.js";

// Union of all event data types (without timestamp and taskId)
type ReportableEvent =
  | Omit<AgentStartEvent, "timestamp" | "taskId">
  | Omit<AgentEndEvent, "timestamp" | "taskId">
  | Omit<AgentErrorEvent, "timestamp" | "taskId">
  | Omit<MessageStartEvent, "timestamp" | "taskId">
  | Omit<MessageDeltaEvent, "timestamp" | "taskId">
  | Omit<MessageEndEvent, "timestamp" | "taskId">
  | Omit<ToolStartEvent, "timestamp" | "taskId">
  | Omit<ToolUpdateEvent, "timestamp" | "taskId">
  | Omit<ToolEndEvent, "timestamp" | "taskId">
  | Omit<SystemCompactionEvent, "timestamp" | "taskId">
  | Omit<SystemMessageEvent, "timestamp" | "taskId">
  | Omit<PrCreatedEvent, "timestamp" | "taskId">
  | Omit<PrStatusEvent, "timestamp" | "taskId">
  | Omit<SetupStatusEvent, "timestamp" | "taskId">;

/**
 * Sign a payload with HMAC-SHA256
 */
function signPayload(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export class EventReporter {
  private gatewayUrl: string;
  private webhookSecret: string;
  private taskId: string;
  private eventQueue: AgentEvent[] = [];
  private isFlushing = false;

  constructor(env: Env) {
    this.gatewayUrl = env.GATEWAY_URL;
    this.webhookSecret = env.WEBHOOK_SECRET;
    this.taskId = env.TASK_ID;
  }

  /**
   * Report an event to the Gateway
   */
  async report(event: ReportableEvent): Promise<void> {
    const fullEvent = {
      ...event,
      timestamp: new Date().toISOString(),
      taskId: this.taskId,
    } as AgentEvent;

    this.eventQueue.push(fullEvent);
    await this.flush();
  }

  /**
   * Flush queued events to the Gateway
   */
  private async flush(): Promise<void> {
    if (this.isFlushing || this.eventQueue.length === 0) {
      return;
    }

    this.isFlushing = true;

    try {
      while (this.eventQueue.length > 0) {
        const event = this.eventQueue.shift()!;
        await this.sendEvent(event);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Send a single event to the Gateway
   */
  private async sendEvent(event: AgentEvent): Promise<void> {
    const url = `${this.gatewayUrl}/api/tasks/${this.taskId}/events`;
    const body = JSON.stringify(event);
    const signature = signPayload(this.webhookSecret, body);

    console.log(`[EventReporter] Sending ${event.type} to ${url}`);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Flightplan-Signature": `sha256=${signature}`,
        },
        body,
      });

      if (!response.ok) {
        const responseBody = await response.text();
        console.error(
          `[EventReporter] Failed to send event: ${response.status} ${response.statusText}`,
          responseBody,
        );
      } else {
        console.log(`[EventReporter] Successfully sent ${event.type}`);
      }
    } catch (error) {
      console.error(`[EventReporter] Error sending event:`, error);
      // Re-queue the event for retry
      this.eventQueue.unshift(event);
    }
  }

  /**
   * Wait for all events to be sent
   */
  async drain(): Promise<void> {
    while (this.eventQueue.length > 0 || this.isFlushing) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Send a debug/system message to the Gateway's debug panel.
   *
   * These messages appear in the expandable debug panel at the bottom
   * of the task detail page, separate from the main chat stream.
   *
   * @param message - Human-readable message
   * @param level - Message level: "info" | "warn" | "error" | "debug"
   * @param log - Optional multi-line log output for details
   */
  async sendSystemMessage(
    message: string,
    level: SystemMessageLevel = "info",
    log?: string,
  ): Promise<void> {
    await this.report({
      type: "system:message",
      message,
      level,
      log,
    });
  }
}
