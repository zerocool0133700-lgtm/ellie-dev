/**
 * UMS Connector: Google Tasks
 *
 * ELLIE-300: Normalizes Google Tasks into UnifiedMessage format.
 */

import type { UMSConnector } from "../connector.ts";
import type { UnifiedMessageInsert } from "../types.ts";

interface GoogleTaskItem {
  id: string;
  title: string;
  notes?: string;
  due?: string;
  status?: string;
  updated?: string;
}

export const googleTasksConnector: UMSConnector = {
  provider: "google-tasks",

  normalize(rawPayload: unknown): UnifiedMessageInsert | null {
    const task = rawPayload as GoogleTaskItem;
    if (!task.id || !task.title) return null;

    const parts = [task.title];
    if (task.notes) parts.push(task.notes);

    return {
      provider: "google-tasks",
      provider_id: task.id,
      channel: "google-tasks:default",
      sender: null,
      content: parts.join("\n\n"),
      content_type: "task",
      raw: rawPayload as Record<string, unknown>,
      provider_timestamp: task.updated || null,
      metadata: {
        title: task.title,
        notes: task.notes,
        due_date: task.due,
        external_status: task.status,
      },
    };
  },
};
