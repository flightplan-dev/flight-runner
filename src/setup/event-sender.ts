/**
 * Event Sender for Setup Process
 *
 * Sends setup:status events to the Gateway to persist environment setup state.
 * This is a lightweight version of EventReporter that doesn't require the full Env schema.
 */

import { createHmac } from "crypto";
import type { SetupStatusType, ServiceInfo } from "../types.js";

interface SetupEventConfig {
  gatewayUrl: string;
  webhookSecret: string;
  taskId: string;
}

interface SetupStatusPayload {
  status: SetupStatusType;
  step?: string;
  error?: string;
  services?: ServiceInfo[];
  devServer?: {
    port: number;
    pid?: number;
  };
  devServerUrl?: string;
}

/**
 * Sign a payload with HMAC-SHA256
 */
function signPayload(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export class SetupEventSender {
  private config: SetupEventConfig | null = null;

  constructor() {
    // Try to read config from environment
    const gatewayUrl = process.env.GATEWAY_URL;
    const webhookSecret = process.env.WEBHOOK_SECRET;
    const taskId = process.env.TASK_ID;

    if (gatewayUrl && webhookSecret && taskId) {
      this.config = { gatewayUrl, webhookSecret, taskId };
      console.log(`[SetupEventSender] Configured to send events to ${gatewayUrl}`);
    } else {
      console.log(
        "[SetupEventSender] Missing GATEWAY_URL, WEBHOOK_SECRET, or TASK_ID - events will not be sent to Gateway",
      );
    }
  }

  /**
   * Check if the sender is configured (has Gateway credentials)
   */
  isConfigured(): boolean {
    return this.config !== null;
  }

  /**
   * Send a setup status event to the Gateway
   */
  async sendStatus(payload: SetupStatusPayload): Promise<void> {
    if (!this.config) {
      console.log("[SetupEventSender] Not configured, skipping event");
      return;
    }

    const event = {
      type: "setup:status" as const,
      timestamp: new Date().toISOString(),
      taskId: this.config.taskId,
      ...payload,
    };

    const url = `${this.config.gatewayUrl}/api/tasks/${this.config.taskId}/events`;
    const body = JSON.stringify(event);
    const signature = signPayload(this.config.webhookSecret, body);

    console.log(`[SetupEventSender] Sending setup:status (${payload.status}) to Gateway`);

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
          `[SetupEventSender] Failed to send event: ${response.status} ${response.statusText}`,
          responseBody,
        );
      } else {
        console.log(`[SetupEventSender] Successfully sent setup:status (${payload.status})`);
      }
    } catch (error) {
      console.error(`[SetupEventSender] Error sending event:`, error);
      // Don't throw - setup should continue even if event sending fails
    }
  }
}
