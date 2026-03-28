/**
 * Dispatch Envelope — Unified tracking for coordinator + specialist dispatches.
 * Every dispatch (Messages API or CLI subprocess) gets one envelope.
 * Parent-child relationships enable full trace trees.
 */

import { log } from "./logger.ts";

const logger = log.child("dispatch-envelope");

// Model pricing (per million tokens, USD) — reuse from creature-cost-tracker
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6":   { input: 15.0, output: 75.0 },
  "claude-sonnet-4-6": { input: 3.0,  output: 15.0 },
  "claude-haiku-4-5":  { input: 0.8,  output: 4.0  },
  "opus":   { input: 15.0, output: 75.0 },
  "sonnet": { input: 3.0,  output: 15.0 },
  "haiku":  { input: 0.8,  output: 4.0  },
};

export interface DispatchEnvelope {
  id: string;
  type: "coordinator" | "specialist";
  agent: string;
  foundation: string;
  parent_id: string | null;
  started_at: string;
  completed_at: string | null;
  status: "running" | "completed" | "error" | "timeout";
  tokens_in: number;
  tokens_out: number;
  model: string;
  cost_usd: number;
  error: string | null;
  work_item_id: string | null;
}

interface CreateOpts {
  type: "coordinator" | "specialist";
  agent: string;
  foundation: string;
  parent_id?: string;
  model?: string;
  work_item_id?: string;
}

interface CompleteOpts {
  tokens_in: number;
  tokens_out: number;
  model?: string;
}

let counter = 0;

function generateId(): string {
  const ts = Date.now().toString(36);
  const seq = (counter++).toString(36).padStart(4, "0");
  const rand = Math.random().toString(36).slice(2, 6);
  return `dsp_${ts}${seq}${rand}`;
}

export function computeCost(model: string, tokensIn: number, tokensOut: number): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING["sonnet"];
  const cost =
    (tokensIn / 1_000_000) * pricing.input +
    (tokensOut / 1_000_000) * pricing.output;
  return Math.round(cost * 10000) / 10000;
}

export function createEnvelope(opts: CreateOpts): DispatchEnvelope {
  const env: DispatchEnvelope = {
    id: generateId(),
    type: opts.type,
    agent: opts.agent,
    foundation: opts.foundation,
    parent_id: opts.parent_id ?? null,
    started_at: new Date().toISOString(),
    completed_at: null,
    status: "running",
    tokens_in: 0,
    tokens_out: 0,
    model: opts.model ?? "unknown",
    cost_usd: 0,
    error: null,
    work_item_id: opts.work_item_id ?? null,
  };
  logger.debug("envelope created", { id: env.id, type: env.type, agent: env.agent });
  return env;
}

export function completeEnvelope(env: DispatchEnvelope, opts: CompleteOpts): DispatchEnvelope {
  const model = opts.model ?? env.model;
  const cost = computeCost(model, opts.tokens_in, opts.tokens_out);
  const completed: DispatchEnvelope = {
    ...env,
    status: "completed",
    completed_at: new Date().toISOString(),
    tokens_in: opts.tokens_in,
    tokens_out: opts.tokens_out,
    model,
    cost_usd: cost,
  };
  logger.debug("envelope completed", { id: env.id, cost_usd: cost, tokens_in: opts.tokens_in, tokens_out: opts.tokens_out });
  return completed;
}

export function failEnvelope(env: DispatchEnvelope, error: string): DispatchEnvelope {
  const failed: DispatchEnvelope = {
    ...env,
    status: "error",
    completed_at: new Date().toISOString(),
    error,
  };
  logger.debug("envelope failed", { id: env.id, error });
  return failed;
}
