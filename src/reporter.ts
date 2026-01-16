/**
 * Event Reporter
 *
 * Sends agent events back to the Gateway via HTTP POST.
 */

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
  Env,
} from "./types.js";

// Union of all event data types (without timestamp and missionId)
type ReportableEvent =
  | Omit<AgentStartEvent, "timestamp" | "missionId">
  | Omit<AgentEndEvent, "timestamp" | "missionId">
  | Omit<AgentErrorEvent, "timestamp" | "missionId">
  | Omit<MessageStartEvent, "timestamp" | "missionId">
  | Omit<MessageDeltaEvent, "timestamp" | "missionId">
  | Omit<MessageEndEvent, "timestamp" | "missionId">
  | Omit<ToolStartEvent, "timestamp" | "missionId">
  | Omit<ToolUpdateEvent, "timestamp" | "missionId">
  | Omit<ToolEndEvent, "timestamp" | "missionId">;

export class EventReporter {
  private gatewayUrl: string;
  private gatewaySecret: string;
  private missionId: string;
  private eventQueue: AgentEvent[] = [];
  private isFlushing = false;

  constructor(env: Env) {
    this.gatewayUrl = env.GATEWAY_URL;
    this.gatewaySecret = env.GATEWAY_SECRET;
    this.missionId = env.MISSION_ID;
  }

  /**
   * Report an event to the Gateway
   */
  async report(event: ReportableEvent): Promise<void> {
    const fullEvent = {
      ...event,
      timestamp: new Date().toISOString(),
      missionId: this.missionId,
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
    const url = `${this.gatewayUrl}/api/missions/${this.missionId}/events`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.gatewaySecret}`,
        },
        body: JSON.stringify(event),
      });

      if (!response.ok) {
        const body = await response.text();
        console.error(
          `[EventReporter] Failed to send event: ${response.status} ${response.statusText}`,
          body,
        );
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
}
