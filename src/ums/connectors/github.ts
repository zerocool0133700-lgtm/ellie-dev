/**
 * UMS Connector: GitHub (PRs, issues, CI)
 *
 * ELLIE-302: Normalizes GitHub webhook events into UnifiedMessage format.
 */

import type { UMSConnector } from "../connector.ts";
import type { UnifiedMessageInsert } from "../types.ts";

interface GitHubWebhookEvent {
  action?: string;
  sender?: { login: string; avatar_url?: string };
  repository?: { full_name: string; html_url?: string };
  pull_request?: { number: number; title: string; body?: string; html_url?: string; state?: string };
  issue?: { number: number; title: string; body?: string; html_url?: string; state?: string };
  comment?: { id: number; body: string; html_url?: string };
  workflow_run?: { id: number; name: string; conclusion?: string; html_url?: string; head_branch?: string };
  ref?: string;
  commits?: { id: string; message: string; author: { name: string } }[];
}

export const githubConnector: UMSConnector = {
  provider: "github",

  normalize(rawPayload: unknown): UnifiedMessageInsert | null {
    const event = rawPayload as GitHubWebhookEvent;
    const eventType = detectEventType(event);
    if (!eventType) return null;

    const repo = event.repository?.full_name || "unknown";
    const providerId = buildProviderId(event, eventType);
    const content = buildContent(event, eventType, repo);

    return {
      provider: "github",
      provider_id: providerId,
      channel: `github:${repo}`,
      sender: event.sender ? { username: event.sender.login } : null,
      content,
      content_type: "notification",
      raw: rawPayload as Record<string, unknown>,
      provider_timestamp: new Date().toISOString(),
      metadata: {
        event_type: eventType,
        action: event.action,
        repo,
        pr_number: event.pull_request?.number,
        issue_number: event.issue?.number,
        url: event.pull_request?.html_url || event.issue?.html_url || event.workflow_run?.html_url,
        branch: event.ref || event.workflow_run?.head_branch,
        ci_conclusion: event.workflow_run?.conclusion,
      },
    };
  },
};

function detectEventType(event: GitHubWebhookEvent): string | null {
  if (event.pull_request) return "pull_request";
  if (event.issue && !event.comment) return "issue";
  if (event.comment) return "comment";
  if (event.workflow_run) return "ci";
  if (event.commits) return "push";
  return null;
}

function buildProviderId(event: GitHubWebhookEvent, eventType: string): string {
  const repo = event.repository?.full_name || "unknown";
  switch (eventType) {
    case "pull_request": return `github:pr:${repo}#${event.pull_request!.number}:${event.action}`;
    case "issue": return `github:issue:${repo}#${event.issue!.number}:${event.action}`;
    case "comment": return `github:comment:${event.comment!.id}`;
    case "ci": return `github:ci:${event.workflow_run!.id}:${event.workflow_run!.conclusion}`;
    case "push": return `github:push:${repo}:${event.commits?.[0]?.id?.slice(0, 8)}`;
    default: return `github:${eventType}:${Date.now()}`;
  }
}

function buildContent(event: GitHubWebhookEvent, eventType: string, repo: string): string {
  switch (eventType) {
    case "pull_request":
      return `PR #${event.pull_request!.number} ${event.action}: ${event.pull_request!.title} (${repo})`;
    case "issue":
      return `Issue #${event.issue!.number} ${event.action}: ${event.issue!.title} (${repo})`;
    case "comment":
      return `Comment on ${repo}: ${event.comment!.body.slice(0, 200)}`;
    case "ci": {
      const run = event.workflow_run!;
      return `CI ${run.conclusion || "running"}: ${run.name} on ${run.head_branch} (${repo})`;
    }
    case "push": {
      const count = event.commits?.length || 0;
      const first = event.commits?.[0]?.message || "";
      return `Push to ${event.ref}: ${count} commit${count !== 1 ? "s" : ""} — ${first.split("\n")[0]} (${repo})`;
    }
    default: return `GitHub event: ${eventType} on ${repo}`;
  }
}
