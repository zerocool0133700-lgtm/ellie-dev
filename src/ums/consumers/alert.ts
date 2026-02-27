/**
 * UMS Consumer: Alerts
 *
 * ELLIE-307: Push subscriber — watches for high-priority events
 * (VIP senders, urgent keywords, CI failures) and triggers notifications.
 *
 * Listens to: all providers
 * Action: sends Telegram/Google Chat alerts via delivery.ts
 *
 * Cross-ref: src/delivery.ts deliverMessage() for notification delivery
 * Cross-ref: src/notification-policy.ts for routing policy
 */

import type { UnifiedMessage } from "../types.ts";
import { subscribe } from "../events.ts";
import { log } from "../../logger.ts";

const logger = log.child("ums-consumer-alert");

/** Alert rule — triggers notification when matched. */
interface AlertRule {
  name: string;
  match: (message: UnifiedMessage) => boolean;
  priority: "critical" | "high" | "normal";
  format: (message: UnifiedMessage) => string;
}

/** Configurable VIP senders — messages from these always alert. */
const VIP_SENDERS = new Set<string>([
  // Populated at runtime from config/DB
]);

/** Keywords that trigger alerts regardless of sender. */
const URGENT_KEYWORDS = [
  /\burgent\b/i, /\bemergency\b/i, /\bincident\b/i, /\boutage\b/i,
  /\bdown\b/i, /\bbroken\b/i, /\bcritical\b/i, /\bblocked\b/i,
];

const ALERT_RULES: AlertRule[] = [
  // CI failures
  {
    name: "ci-failure",
    match: (msg) => msg.provider === "github" &&
      msg.metadata?.event_type === "ci" &&
      msg.metadata?.ci_conclusion === "failure",
    priority: "critical",
    format: (msg) => `🔴 CI Failed: ${msg.content}`,
  },
  // VIP sender messages
  {
    name: "vip-sender",
    match: (msg) => {
      const sender = msg.sender;
      if (!sender) return false;
      return VIP_SENDERS.has(sender.email || "") ||
             VIP_SENDERS.has(sender.username || "") ||
             VIP_SENDERS.has(sender.name || "");
    },
    priority: "high",
    format: (msg) => {
      const who = msg.sender?.name || msg.sender?.username || msg.sender?.email || "VIP";
      return `⭐ ${who}: ${msg.content?.slice(0, 200) || "(no content)"}`;
    },
  },
  // Urgent keywords in any message
  {
    name: "urgent-keyword",
    match: (msg) => {
      if (!msg.content) return false;
      return URGENT_KEYWORDS.some(p => p.test(msg.content!));
    },
    priority: "high",
    format: (msg) => `⚠️ Urgent [${msg.provider}]: ${msg.content?.slice(0, 200) || ""}`,
  },
  // Document mentions (someone mentioned you)
  {
    name: "doc-mention",
    match: (msg) => msg.provider === "documents" && msg.metadata?.change_type === "mention",
    priority: "normal",
    format: (msg) => `📄 ${msg.content}`,
  },
];

/** Callback for delivering alerts. Set via initAlertConsumer. */
type AlertDeliveryFn = (text: string, priority: string) => Promise<void>;
let deliverAlert: AlertDeliveryFn | null = null;

/**
 * Initialize the Alert consumer.
 *
 * @param deliveryFn Callback to deliver alert text (wraps deliverMessage or similar)
 * @param vipSenders Optional set of VIP sender identifiers
 */
export function initAlertConsumer(
  deliveryFn: AlertDeliveryFn,
  vipSenders?: string[],
): void {
  deliverAlert = deliveryFn;

  if (vipSenders) {
    for (const s of vipSenders) VIP_SENDERS.add(s);
  }

  subscribe("consumer:alert", {}, async (message) => {
    try {
      await handleMessage(message);
    } catch (err) {
      logger.error("Alert consumer failed", { messageId: message.id, err });
    }
  });
  logger.info("Alert consumer initialized", { vipCount: VIP_SENDERS.size, rules: ALERT_RULES.length });
}

async function handleMessage(message: UnifiedMessage): Promise<void> {
  for (const rule of ALERT_RULES) {
    if (!rule.match(message)) continue;

    const text = rule.format(message);
    logger.info("Alert triggered", { rule: rule.name, priority: rule.priority, messageId: message.id });

    if (deliverAlert) {
      await deliverAlert(text, rule.priority);
    } else {
      logger.warn("Alert consumer: no delivery function configured", { text });
    }

    // Only fire the highest-priority matching rule
    return;
  }
}
