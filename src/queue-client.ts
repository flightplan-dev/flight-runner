/**
 * Queue Client
 *
 * Fetches queued messages from the Gateway and updates their status.
 * Uses HMAC signatures for authentication.
 */

import { createHmac } from "crypto";
import type { Env } from "./types.js";

// =============================================================================
// Types
// =============================================================================

export interface QueuedMessage {
  id: string;
  text: string;
  behavior: "steer" | "followUp" | "abort";
  senderId: string;
  senderName: string;
  createdAt: string;
}

interface QueueResponse {
  messages: QueuedMessage[];
}

// =============================================================================
// Queue Client
// =============================================================================

/**
 * Sign a payload with HMAC-SHA256
 */
function signPayload(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export class QueueClient {
  private gatewayUrl: string;
  private webhookSecret: string;
  private missionId: string;

  constructor(env: Env) {
    this.gatewayUrl = env.GATEWAY_URL;
    this.webhookSecret = env.WEBHOOK_SECRET;
    this.missionId = env.MISSION_ID;
  }

  /**
   * Fetch pending messages from the queue
   */
  async fetchPendingMessages(): Promise<QueuedMessage[]> {
    const url = `${this.gatewayUrl}/api/missions/${this.missionId}/queue`;

    // For GET requests, sign the missionId as the body
    const signature = signPayload(this.webhookSecret, this.missionId);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Flightplan-Signature": `sha256=${signature}`,
        },
      });

      if (!response.ok) {
        const responseBody = await response.text();
        console.error(
          `[QueueClient] Failed to fetch queue: ${response.status} ${response.statusText}`,
          responseBody
        );
        return [];
      }

      const data: QueueResponse = await response.json();
      return data.messages;
    } catch (error) {
      console.error(`[QueueClient] Error fetching queue:`, error);
      return [];
    }
  }

  /**
   * Mark a message as delivered (picked up for processing)
   */
  async markDelivered(messageId: string): Promise<boolean> {
    return this.updateStatus(messageId, "delivered");
  }

  /**
   * Mark a message as processed (successfully handled by agent)
   */
  async markProcessed(messageId: string): Promise<boolean> {
    return this.updateStatus(messageId, "processed");
  }

  /**
   * Update a message's status
   */
  private async updateStatus(
    messageId: string,
    status: "delivered" | "processed"
  ): Promise<boolean> {
    const url = `${this.gatewayUrl}/api/missions/${this.missionId}/queue/${messageId}`;
    const body = JSON.stringify({ status });
    const signature = signPayload(this.webhookSecret, body);

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
          `[QueueClient] Failed to update message ${messageId}: ${response.status}`,
          responseBody
        );
        return false;
      }

      return true;
    } catch (error) {
      console.error(`[QueueClient] Error updating message ${messageId}:`, error);
      return false;
    }
  }
}
