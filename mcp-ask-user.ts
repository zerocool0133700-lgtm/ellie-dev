#!/usr/bin/env bun
/**
 * Ask-User MCP Server — ELLIE-1267
 *
 * Exposes an `ask_user_question` tool to dispatched Claude Code agents.
 * When called, POSTs to the relay's /api/ask-user/question endpoint
 * which long-polls until the user answers.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const RELAY_URL = process.env.RELAY_URL || "http://localhost:3001";

const server = new McpServer({
  name: "ask-user",
  version: "1.0.0",
});

server.tool(
  "ask_user_question",
  "Ask the user a question and wait for their response. Use this when you need clarification, a decision, or approval from the user before proceeding. The question will be sent to the user via their active messaging channel (Telegram/Google Chat/dashboard) with your name attributed. You will block until the user responds or the request times out (5 minutes).",
  {
    question: z.string().describe("The question to ask the user. Be specific and concise."),
    agent_name: z.string().describe("Your agent name (e.g. 'james', 'kate', 'brian')"),
    work_item_id: z.string().optional().describe("The ELLIE-XXX ticket ID you're working on, if any"),
    urgency: z.enum(["low", "normal", "high"]).optional().describe("How urgent is this question? 'high' = blocking critical work"),
    options: z.array(z.string()).optional().describe("Optional list of suggested answers for the user to choose from"),
  },
  async ({ question, agent_name, work_item_id, urgency, options }) => {
    try {
      const res = await fetch(`${RELAY_URL}/api/ask-user/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, agent_name, work_item_id, urgency, options }),
      });

      if (!res.ok) {
        const text = await res.text();
        return { content: [{ type: "text" as const, text: `Error asking question: ${res.status} ${text}` }], isError: true };
      }

      const data = await res.json() as { answer?: string; error?: string; question_id?: string };

      if (data.error) {
        return { content: [{ type: "text" as const, text: `Question failed: ${data.error}` }], isError: true };
      }

      return {
        content: [{ type: "text" as const, text: data.answer || "No answer received" }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Failed to reach relay: ${msg}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
