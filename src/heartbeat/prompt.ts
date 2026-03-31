/**
 * Heartbeat Prompt Template — ELLIE-1164
 */

import type { SourceDelta } from "./types.ts";

const ICONS: Record<string, string> = {
  email: "📧",
  ci: "🔧",
  plane: "📋",
  calendar: "📅",
  forest: "🌲",
  gtd: "✅",
};

export function buildHeartbeatPrompt(deltas: SourceDelta[], intervalMinutes: number): string {
  const now = new Date().toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
  const changedDeltas = deltas.filter((d) => d.changed);

  if (changedDeltas.length === 0) return "";

  const lines = changedDeltas.map((d) => `- ${ICONS[d.source] || "•"} ${d.summary}`);

  return `Heartbeat check at ${now} CST.

Changes since last check (${intervalMinutes} min ago):
${lines.join("\n")}

Review and act as needed per the current playbook.`;
}
