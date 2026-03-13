/**
 * Tests for Round Table Output Formatting — ELLIE-703
 */
import { describe, expect, test } from "bun:test";
import {
  renderTelegram,
  renderGoogleChat,
  renderDashboard,
  renderPlain,
  renderForChannel,
  paginateMessage,
  formatRoundTableOutput,
  renderPhaseUpdate,
  renderTranscriptDetail,
  formatDuration,
  truncateText,
  attachConvergeOutput,
  CHANNEL_LIMITS,
  _makeMockFormattingInput,
  _makeMockFormatOptions,
  type FormatOptions,
  type MessageChunk,
} from "../src/round-table/output-formatting.ts";
import { _makeMockDeliverOutput } from "../src/round-table/deliver.ts";

// ── formatDuration ──────────────────────────────────────────────

describe("formatDuration", () => {
  test("formats milliseconds", () => {
    expect(formatDuration(500)).toBe("500ms");
  });

  test("formats seconds", () => {
    expect(formatDuration(2500)).toBe("2.5s");
  });

  test("formats minutes and seconds", () => {
    expect(formatDuration(125000)).toBe("2m 5s");
  });

  test("formats exact minutes", () => {
    expect(formatDuration(120000)).toBe("2m");
  });

  test("sub-second stays in ms", () => {
    expect(formatDuration(999)).toBe("999ms");
  });
});

// ── truncateText ────────────────────────────────────────────────

describe("truncateText", () => {
  test("returns text unchanged if under limit", () => {
    expect(truncateText("hello", 10)).toBe("hello");
  });

  test("truncates with ellipsis", () => {
    expect(truncateText("hello world this is long", 15)).toBe("hello world ...");
  });

  test("handles exact length", () => {
    expect(truncateText("exact", 5)).toBe("exact");
  });
});

// ── Telegram Rendering ──────────────────────────────────────────

describe("renderTelegram", () => {
  test("renders header with session ID", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions();
    const output = renderTelegram(input, opts);
    expect(output).toContain("🔵 *Round Table Complete*");
    expect(output).toContain("`rt-test-001`");
  });

  test("includes executive summary", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions();
    const output = renderTelegram(input, opts);
    expect(output).toContain("phased expansion into APAC");
  });

  test("shows agreements with confidence", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions();
    const output = renderTelegram(input, opts);
    expect(output).toContain("Key Agreements");
    expect(output).toContain("APAC expansion is strategically sound");
    expect(output).toContain("_(high)_");
  });

  test("limits agreements to top 3 with overflow indicator", () => {
    const input = _makeMockFormattingInput();
    // Mock has exactly 3 agreements, so no overflow
    const opts = _makeMockFormatOptions();
    const output = renderTelegram(input, opts);
    expect(output).not.toContain("…and");
  });

  test("shows conflicts with resolutions", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions();
    const output = renderTelegram(input, opts);
    expect(output).toContain("Conflicts");
    expect(output).toContain("Timeline disagreement");
    expect(output).toContain("Q3 selected");
  });

  test("shows escalations", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions();
    const output = renderTelegram(input, opts);
    expect(output).toContain("Escalations");
    expect(output).toContain("Budget approval");
  });

  test("shows formation details with status icons", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions();
    const output = renderTelegram(input, opts);
    expect(output).toContain("✅ `boardroom`");
    expect(output).toContain("❌ `vrbo-ops`");
  });

  test("shows criteria status — not all met", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions();
    const output = renderTelegram(input, opts);
    expect(output).toContain("⚠️ Some criteria not met");
  });

  test("hides transcripts when includeTranscripts is false", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ includeTranscripts: false });
    const output = renderTelegram(input, opts);
    expect(output).not.toContain("Formations:");
    expect(output).not.toContain("boardroom");
  });

  test("uses Telegram bold syntax (*text*)", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions();
    const output = renderTelegram(input, opts);
    expect(output).toContain("*Round Table Complete*");
    // Should NOT use Google Chat style **text**
    expect(output).not.toContain("**Round Table Complete**");
  });
});

// ── Google Chat Rendering ───────────────────────────────────────

describe("renderGoogleChat", () => {
  test("uses Google Chat bold syntax (**text**)", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "google-chat" });
    const output = renderGoogleChat(input, opts);
    expect(output).toContain("**Round Table Complete**");
  });

  test("uses Google Chat italic syntax (*text*)", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "google-chat" });
    const output = renderGoogleChat(input, opts);
    expect(output).toContain("*(high)*");
  });

  test("includes session ID", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "google-chat" });
    const output = renderGoogleChat(input, opts);
    expect(output).toContain("`rt-test-001`");
  });

  test("shows escalations", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "google-chat" });
    const output = renderGoogleChat(input, opts);
    expect(output).toContain("Budget approval");
  });

  test("is different from Telegram output", () => {
    const input = _makeMockFormattingInput();
    const tgOut = renderTelegram(input, _makeMockFormatOptions());
    const gcOut = renderGoogleChat(input, _makeMockFormatOptions({ channel: "google-chat" }));
    // They should differ in bold syntax
    expect(tgOut).not.toBe(gcOut);
  });
});

// ── Dashboard (HTML) Rendering ──────────────────────────────────

describe("renderDashboard", () => {
  test("wraps in rt-result div with session data attribute", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "dashboard" });
    const output = renderDashboard(input, opts);
    expect(output).toContain('class="rt-result"');
    expect(output).toContain('data-session="rt-test-001"');
  });

  test("renders executive summary in rt-summary div", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "dashboard" });
    const output = renderDashboard(input, opts);
    expect(output).toContain('class="rt-summary"');
    expect(output).toContain("phased expansion");
  });

  test("renders agreements in a list", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "dashboard" });
    const output = renderDashboard(input, opts);
    expect(output).toContain("rt-agreements");
    expect(output).toContain("[high]");
    expect(output).toContain("APAC expansion");
  });

  test("wraps conflicts in collapsible details when > 2", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "dashboard" });
    const output = renderDashboard(input, opts);
    expect(output).toContain("rt-conflicts");
    // Mock has exactly 2 conflicts, so should NOT be collapsible
    expect(output).not.toContain("<summary><h3>Conflicts (2)</h3></summary>");
  });

  test("wraps gaps in collapsible details", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "dashboard" });
    const output = renderDashboard(input, opts);
    expect(output).toContain("rt-gaps");
    expect(output).toContain("<details>");
    expect(output).toContain("Gaps (2)");
  });

  test("includes deep-dive links for transcripts", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "dashboard" });
    const output = renderDashboard(input, opts);
    expect(output).toContain("rt-deepdive-link");
    expect(output).toContain("/round-table/sessions/rt-test-001/transcripts/boardroom");
  });

  test("uses custom transcriptBaseUrl", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "dashboard", transcriptBaseUrl: "/api/rt" });
    const output = renderDashboard(input, opts);
    expect(output).toContain("/api/rt/sessions/rt-test-001/transcripts/boardroom");
  });

  test("renders transcript output in collapsible sections", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "dashboard" });
    const output = renderDashboard(input, opts);
    expect(output).toContain('class="rt-transcript success"');
    expect(output).toContain('class="rt-transcript failed"');
    expect(output).toContain("<summary>");
  });

  test("escapes HTML in content", () => {
    const input = _makeMockFormattingInput({
      executiveSummary: 'Test <script>alert("xss")</script> output',
    });
    const opts = _makeMockFormatOptions({ channel: "dashboard" });
    const output = renderDashboard(input, opts);
    expect(output).not.toContain("<script>");
    expect(output).toContain("&lt;script&gt;");
  });

  test("shows criteria status with class", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "dashboard" });
    const output = renderDashboard(input, opts);
    expect(output).toContain("rt-criteria-not-met");
  });
});

// ── Plain Text Rendering ────────────────────────────────────────

describe("renderPlain", () => {
  test("renders with ASCII header", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "plain" });
    const output = renderPlain(input, opts);
    expect(output).toContain("=== Round Table Result ===");
  });

  test("includes session ID", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "plain" });
    const output = renderPlain(input, opts);
    expect(output).toContain("Session: rt-test-001");
  });

  test("shows agreements with confidence tags", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "plain" });
    const output = renderPlain(input, opts);
    expect(output).toContain("AGREEMENTS:");
    expect(output).toContain("[high]");
  });

  test("shows conflicts with arrow resolution", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "plain" });
    const output = renderPlain(input, opts);
    expect(output).toContain("CONFLICTS:");
    expect(output).toContain("-> Q3 selected");
  });

  test("shows formation status tags", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "plain" });
    const output = renderPlain(input, opts);
    expect(output).toContain("[OK] boardroom");
    expect(output).toContain("[FAIL] vrbo-ops");
  });

  test("shows criteria status", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "plain" });
    const output = renderPlain(input, opts);
    expect(output).toContain("STATUS: Some criteria not met");
  });
});

// ── renderForChannel dispatcher ─────────────────────────────────

describe("renderForChannel", () => {
  test("dispatches to telegram", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "telegram" });
    const output = renderForChannel(input, opts);
    expect(output).toContain("*Round Table Complete*");
  });

  test("dispatches to google-chat", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "google-chat" });
    const output = renderForChannel(input, opts);
    expect(output).toContain("**Round Table Complete**");
  });

  test("dispatches to dashboard", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "dashboard" });
    const output = renderForChannel(input, opts);
    expect(output).toContain('class="rt-result"');
  });

  test("dispatches to plain", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions({ channel: "plain" });
    const output = renderForChannel(input, opts);
    expect(output).toContain("=== Round Table Result ===");
  });
});

// ── Pagination ──────────────────────────────────────────────────

describe("paginateMessage", () => {
  test("returns single chunk for short messages", () => {
    const chunks = paginateMessage("Short message", "telegram");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].page).toBe(1);
    expect(chunks[0].totalPages).toBe(1);
    expect(chunks[0].content).toBe("Short message");
  });

  test("splits at message length limit", () => {
    const longText = "A".repeat(5000);
    const chunks = paginateMessage(longText, "telegram");
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].totalPages).toBe(chunks.length);
  });

  test("adds page numbers to multi-page output", () => {
    const longText = "A".repeat(5000);
    const chunks = paginateMessage(longText, "telegram");
    expect(chunks[0].content).toMatch(/^\(1\/\d+\)/);
    expect(chunks[1].content).toMatch(/^\(2\/\d+\)/);
  });

  test("prefers splitting at paragraph boundaries", () => {
    // Create text that's over the limit with a paragraph break in the last 20%
    const partA = "A".repeat(3500);
    const partB = "B".repeat(1000);
    const text = `${partA}\n\n${partB}`;
    const chunks = paginateMessage(text, "telegram");
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // First chunk should end before the paragraph break
    const firstContent = chunks[0].content.replace(/^\(\d+\/\d+\)\n/, "");
    expect(firstContent.endsWith("A")).toBe(true);
  });

  test("dashboard has higher limit than telegram", () => {
    expect(CHANNEL_LIMITS.dashboard).toBeGreaterThan(CHANNEL_LIMITS.telegram);
  });

  test("no pagination needed for dashboard-sized content", () => {
    const text = "A".repeat(5000); // over telegram limit but under dashboard
    const chunks = paginateMessage(text, "dashboard");
    expect(chunks).toHaveLength(1);
  });
});

// ── formatRoundTableOutput (main entry) ─────────────────────────

describe("formatRoundTableOutput", () => {
  test("returns FormattedResult with primary and chunks", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions();
    const result = formatRoundTableOutput(input, opts);
    expect(result.primary).toBeTruthy();
    expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    expect(result.channel).toBe("telegram");
  });

  test("short output is not paginated", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions();
    const result = formatRoundTableOutput(input, opts);
    expect(result.wasPaginated).toBe(false);
    expect(result.chunks).toHaveLength(1);
  });

  test("truncates when pagination is disabled", () => {
    const longSummary = "X".repeat(5000);
    const input = _makeMockFormattingInput({ executiveSummary: longSummary });
    const opts = _makeMockFormatOptions({ paginate: false });
    const result = formatRoundTableOutput(input, opts);
    expect(result.primary.length).toBeLessThanOrEqual(CHANNEL_LIMITS.telegram);
    expect(result.wasPaginated).toBe(false);
  });

  test("paginates long output when enabled", () => {
    const longSummary = "X".repeat(5000);
    const input = _makeMockFormattingInput({ executiveSummary: longSummary });
    const opts = _makeMockFormatOptions({ paginate: true });
    const result = formatRoundTableOutput(input, opts);
    expect(result.wasPaginated).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(1);
  });

  test("primary is the first chunk", () => {
    const input = _makeMockFormattingInput();
    const opts = _makeMockFormatOptions();
    const result = formatRoundTableOutput(input, opts);
    expect(result.primary).toBe(result.chunks[0].content);
  });
});

// ── Phase Updates ───────────────────────────────────────────────

describe("renderPhaseUpdate", () => {
  test("telegram — started", () => {
    const output = renderPhaseUpdate("telegram", "rt-1", "convene", "started", "Analyzing query...");
    expect(output).toContain("🔄 *Round Table — Convene*");
    expect(output).toContain("`rt-1`");
    expect(output).toContain("Analyzing query");
  });

  test("telegram — completed", () => {
    const output = renderPhaseUpdate("telegram", "rt-1", "discuss", "completed");
    expect(output).toContain("✅ *Round Table — Discuss*");
  });

  test("telegram — failed", () => {
    const output = renderPhaseUpdate("telegram", "rt-1", "converge", "failed", "Synthesis failed");
    expect(output).toContain("❌ *Round Table — Converge*");
    expect(output).toContain("Synthesis failed");
  });

  test("google-chat uses ** for bold", () => {
    const output = renderPhaseUpdate("google-chat", "rt-1", "deliver", "completed");
    expect(output).toContain("**Round Table — Deliver**");
  });

  test("dashboard uses HTML", () => {
    const output = renderPhaseUpdate("dashboard", "rt-1", "convene", "started");
    expect(output).toContain('class="rt-phase-update');
    expect(output).toContain("<strong>Convene</strong>");
  });

  test("plain uses brackets", () => {
    const output = renderPhaseUpdate("plain", "rt-1", "discuss", "completed");
    expect(output).toContain("[COMPLETED] Round Table — Discuss");
  });

  test("capitalizes phase name", () => {
    const output = renderPhaseUpdate("plain", "rt-1", "convene", "started");
    expect(output).toContain("Convene");
    expect(output).not.toContain("convene");
  });
});

// ── Transcript Detail ───────────────────────────────────────────

describe("renderTranscriptDetail", () => {
  const successTranscript = {
    slug: "boardroom",
    success: true,
    output: "Strategic analysis: expansion is viable",
    durationMs: 2500,
  };

  const failedTranscript = {
    slug: "think-tank",
    success: false,
    output: "",
    error: "Agent timeout after 30s",
    durationMs: 30000,
  };

  test("telegram — success transcript", () => {
    const output = renderTranscriptDetail("telegram", "rt-1", successTranscript);
    expect(output).toContain("*Formation: boardroom*");
    expect(output).toContain("✅ Completed");
    expect(output).toContain("2.5s");
    expect(output).toContain("Strategic analysis");
  });

  test("telegram — failed transcript", () => {
    const output = renderTranscriptDetail("telegram", "rt-1", failedTranscript);
    expect(output).toContain("❌ Failed");
    expect(output).toContain("Agent timeout");
  });

  test("google-chat uses ** bold", () => {
    const output = renderTranscriptDetail("google-chat", "rt-1", successTranscript);
    expect(output).toContain("**Formation: boardroom**");
  });

  test("dashboard uses HTML", () => {
    const output = renderTranscriptDetail("dashboard", "rt-1", successTranscript);
    expect(output).toContain('class="rt-transcript-detail"');
    expect(output).toContain('data-formation="boardroom"');
    expect(output).toContain("<pre");
  });

  test("dashboard shows error for failed transcript", () => {
    const output = renderTranscriptDetail("dashboard", "rt-1", failedTranscript);
    expect(output).toContain('class="rt-error"');
    expect(output).toContain("Agent timeout");
  });

  test("plain uses ASCII", () => {
    const output = renderTranscriptDetail("plain", "rt-1", successTranscript);
    expect(output).toContain("=== Formation: boardroom ===");
    expect(output).toContain("Status: Completed");
  });

  test("truncates long transcript output in telegram", () => {
    const longTranscript = { ...successTranscript, output: "X".repeat(5000) };
    const output = renderTranscriptDetail("telegram", "rt-1", longTranscript);
    // Should be truncated to ~3500 chars
    expect(output.length).toBeLessThan(5000);
    expect(output).toContain("...");
  });
});

// ── attachConvergeOutput ────────────────────────────────────────

describe("attachConvergeOutput", () => {
  test("attaches converge output for rich rendering", () => {
    const deliver = _makeMockDeliverOutput();
    const converge = _makeMockFormattingInput()._convergeOutput;
    const attached = attachConvergeOutput(deliver, converge);
    expect(attached._convergeOutput).toBe(converge);
    expect(attached.executiveSummary).toBe(deliver.executiveSummary);
  });

  test("rendering with attached converge shows agreements", () => {
    const deliver = _makeMockDeliverOutput();
    const converge = _makeMockFormattingInput()._convergeOutput;
    const attached = attachConvergeOutput(deliver, converge);
    const opts = _makeMockFormatOptions();
    const output = renderTelegram(attached, opts);
    expect(output).toContain("Key Agreements");
    expect(output).toContain("APAC expansion");
  });

  test("rendering without attached converge falls back gracefully", () => {
    const deliver = _makeMockDeliverOutput();
    const opts = _makeMockFormatOptions();
    const output = renderTelegram(deliver, opts);
    // Should still render without crashing, just without agreement details
    expect(output).toContain("Round Table Complete");
  });
});

// ── Channel Limits ──────────────────────────────────────────────

describe("CHANNEL_LIMITS", () => {
  test("telegram limit is 4096", () => {
    expect(CHANNEL_LIMITS.telegram).toBe(4096);
  });

  test("google-chat limit is 4096", () => {
    expect(CHANNEL_LIMITS["google-chat"]).toBe(4096);
  });

  test("dashboard limit is much higher", () => {
    expect(CHANNEL_LIMITS.dashboard).toBe(50_000);
  });

  test("all channels have limits defined", () => {
    expect(CHANNEL_LIMITS.telegram).toBeDefined();
    expect(CHANNEL_LIMITS["google-chat"]).toBeDefined();
    expect(CHANNEL_LIMITS.dashboard).toBeDefined();
    expect(CHANNEL_LIMITS.plain).toBeDefined();
  });
});
