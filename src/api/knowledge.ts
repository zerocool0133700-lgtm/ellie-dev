/**
 * Knowledge API — ingest and purge endpoints.
 *
 * POST   /api/knowledge/ingest  — base64-in-JSON upload, runs the pipeline
 * DELETE /api/knowledge/purge   — remove a previously-ingested file
 *
 * Style note: Node http (IncomingMessage / ServerResponse), NOT Fetch API.
 * Mirrors the existing /api/ingest/file block at http-routes.ts:6942.
 *
 * See: docs/superpowers/specs/2026-04-06-knowledge-surface-and-ingestion-design.md
 */

import type { IncomingMessage, ServerResponse } from "http";
import { promises as fs } from "fs";
import * as path from "path";
import { log } from "../logger.ts";
import { runIngestion, type IngestionEvent } from "../ingestion-pipeline";
import { broadcastToEllieChatClients } from "../relay-state.ts";
import { authenticateBridgeKey } from "./bridge.ts";

const logger = log.child("api:knowledge");

const RIVER_VAULT_ROOT = process.env.RIVER_ROOT || "/home/ellie/obsidian-vault/ellie-river";

// Server-side enforcement: max 50 in-flight ingestions per process
const MAX_IN_FLIGHT = 50;
let inFlight = 0;

/**
 * Build a tiny mock ApiResponse so we can reuse authenticateBridgeKey
 * (which expects an Express-ish res object) on top of raw Node res.
 * Same pattern used in http-routes.ts around line 6999.
 */
function mockApiResFor(res: ServerResponse) {
  return {
    status: (code: number) => ({
      json: (data: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      },
    }),
    json: (data: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    },
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

export async function handleIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const authRes = mockApiResFor(res);
  const bridgeKey = await authenticateBridgeKey(
    req.headers["x-bridge-key"] as string | undefined,
    authRes as any,
    "write",
  );
  if (!bridgeKey) return; // 401/403 already sent

  if (inFlight >= MAX_IN_FLIGHT) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "too many in-flight ingestions" }));
    return;
  }

  let body: { filename?: string; content?: string; target_folder?: string; proposal_id?: string };
  try {
    body = (await readJsonBody(req)) as any;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  const { filename, content, target_folder, proposal_id } = body;
  if (!filename || !content || !target_folder) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "filename, content (base64), and target_folder are required" }));
    return;
  }

  const buffer = Buffer.from(content, "base64");

  inFlight++;
  try {
    const result = await runIngestion({
      filename,
      target_folder,
      buffer,
      proposal_id,
      onEvent: (event: IngestionEvent) => {
        broadcastToEllieChatClients({
          type: "ingest_event",
          ...event,
          ts: Date.now(),
        });
      },
    });

    if (result.status === "done") {
      broadcastToEllieChatClients({
        type: "ingest_complete",
        ingestion_id: result.ingestion_id,
        river_path: result.river_path,
        forest_chunk_count: result.forest_chunk_count,
        target_folder,
        file_name: filename,
        source_hash: result.source_hash,
        ts: Date.now(),
      });
    }

    res.writeHead(result.status === "failed" ? 500 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } finally {
    inFlight--;
  }
}

export async function handlePurge(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const authRes = mockApiResFor(res);
  const bridgeKey = await authenticateBridgeKey(
    req.headers["x-bridge-key"] as string | undefined,
    authRes as any,
    "write",
  );
  if (!bridgeKey) return;

  let body: { river_path?: string; ingestion_id?: string; target_folder?: string };
  try {
    body = (await readJsonBody(req)) as any;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  if (!body.river_path && !body.ingestion_id && !body.target_folder) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "must provide river_path, ingestion_id, or target_folder" }));
    return;
  }

  const removed = { river_md: 0, raw_files: 0, forest_chunks: 0 };

  if (body.river_path) {
    const fullPath = path.join(RIVER_VAULT_ROOT, body.river_path);
    try {
      await fs.unlink(fullPath);
      removed.river_md++;
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
        return;
      }
    }
    // TODO: Forest chunk cleanup by river_doc_path metadata.
    // No bridge helper exists yet for "delete memories where metadata.river_doc_path = X".
    logger.info("purged river MD; forest chunks left in place (TODO)", { river_path: body.river_path });
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true, removed }));
}
