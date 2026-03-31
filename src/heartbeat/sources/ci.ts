/**
 * Heartbeat source adapter — ci (ELLIE-1164)
 *
 * Polls GitHub Actions workflow runs for new failures or completions.
 */

import type { SourceDelta, HeartbeatSnapshot } from "../types.ts";

const SOURCE_TIMEOUT = 5000;

export async function check(snapshot: HeartbeatSnapshot | null): Promise<{
  delta: SourceDelta;
  snapshotUpdate: Partial<HeartbeatSnapshot>;
}> {
  try {
    const token = process.env.GH_TOKEN || process.env.OVERNIGHT_GH_TOKEN;
    if (!token) throw new Error("No GitHub token in GH_TOKEN or OVERNIGHT_GH_TOKEN");

    const repo = process.env.GITHUB_REPO || "zerocool0133700-lgtm/ellie-dev";

    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/runs?per_page=10&status=completed`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
        signal: AbortSignal.timeout(SOURCE_TIMEOUT),
      },
    );

    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);

    const data = await res.json();
    const runs: any[] = data.workflow_runs ?? [];
    const runIds = runs.map((r: any) => r.id.toString());
    const failedRuns = runs.filter((r: any) => r.conclusion === "failure");

    const prevIds = new Set(snapshot?.ci_run_ids ?? []);
    const newIds = runIds.filter((id) => !prevIds.has(id));
    const newFailures = failedRuns.filter((r: any) => !prevIds.has(r.id.toString()));

    const changed = newIds.length > 0;
    const failCount = newFailures.length;

    return {
      delta: {
        source: "ci",
        changed,
        summary: changed
          ? failCount > 0
            ? `${failCount} new CI failure${failCount > 1 ? "s" : ""}`
            : `${newIds.length} new CI run${newIds.length > 1 ? "s" : ""} completed`
          : "No new CI activity",
        count: newIds.length,
        details: newFailures.map((r: any) => ({ id: r.id, name: r.name, conclusion: r.conclusion })),
      },
      snapshotUpdate: { ci_run_ids: runIds.slice(0, 20) },
    };
  } catch (err) {
    return {
      delta: {
        source: "ci",
        changed: false,
        summary: "Check failed",
        count: 0,
        error: (err as Error).message,
      },
      snapshotUpdate: {},
    };
  }
}
