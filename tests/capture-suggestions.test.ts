import { describe, it, expect, beforeEach } from "bun:test";
import {
  getOrCreateState,
  advanceTurn,
  getCurrentTurn,
  shouldSuggest,
  buildSuggestionMessageDeterministic,
  createSuggestion,
  parseUserResponse,
  handleResponse,
  evaluateForSuggestion,
  DEFAULT_SUGGESTION_CONFIG,
  _clearState,
} from "../src/capture/capture-suggestions.ts";

beforeEach(() => _clearState());

function createMockSql(returnValue: any = [{ id: "cap-1" }]) {
  const calls: any[] = [];
  const fn: any = function (...args: any[]) {
    calls.push(args);
    return Promise.resolve(returnValue);
  };
  fn.calls = calls;
  return fn;
}

describe("ELLIE-778: Agent-initiated capture suggestions", () => {
  describe("state management", () => {
    it("creates fresh state for new conversation", () => {
      const state = getOrCreateState("conv-1");
      expect(state.conversation_id).toBe("conv-1");
      expect(state.suggestions_this_turn).toBe(0);
      expect(state.total_suggestions).toBe(0);
      expect(state.declined_count).toBe(0);
      expect(state.active_suggestion).toBeNull();
    });

    it("returns same state on subsequent calls", () => {
      const s1 = getOrCreateState("conv-1");
      s1.total_suggestions = 3;
      const s2 = getOrCreateState("conv-1");
      expect(s2.total_suggestions).toBe(3);
    });

    it("tracks turns", () => {
      expect(getCurrentTurn("conv-1")).toBe(0);
      advanceTurn("conv-1");
      expect(getCurrentTurn("conv-1")).toBe(1);
      advanceTurn("conv-1");
      expect(getCurrentTurn("conv-1")).toBe(2);
    });

    it("resets per-turn counter on advance", () => {
      const state = getOrCreateState("conv-1");
      state.suggestions_this_turn = 1;
      advanceTurn("conv-1");
      expect(state.suggestions_this_turn).toBe(0);
    });
  });

  describe("shouldSuggest", () => {
    it("allows suggestion for fresh conversation", () => {
      const result = shouldSuggest("conv-1", null);
      expect(result.allowed).toBe(true);
    });

    it("suppresses in brain_dump mode", () => {
      const result = shouldSuggest("conv-1", "brain_dump");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("brain_dump");
    });

    it("suppresses in review mode", () => {
      expect(shouldSuggest("conv-1", "review").allowed).toBe(false);
    });

    it("suppresses in planning mode", () => {
      expect(shouldSuggest("conv-1", "planning").allowed).toBe(false);
    });

    it("enforces per-turn cap", () => {
      const state = getOrCreateState("conv-1");
      state.suggestions_this_turn = 1;
      expect(shouldSuggest("conv-1", null).allowed).toBe(false);
    });

    it("enforces per-conversation cap", () => {
      const state = getOrCreateState("conv-1");
      state.total_suggestions = 5;
      expect(shouldSuggest("conv-1", null).allowed).toBe(false);
    });

    it("enforces min turns between suggestions", () => {
      const state = getOrCreateState("conv-1");
      advanceTurn("conv-1"); // turn 1
      state.last_suggestion_at = 1;
      advanceTurn("conv-1"); // turn 2
      expect(shouldSuggest("conv-1", null).allowed).toBe(false); // only 1 turn gap, need 3
    });

    it("increases gap after declines", () => {
      // Make an initial suggestion at turn 1
      advanceTurn("conv-1"); // turn 1
      createSuggestion("conv-1", "cap-x", "workflow", "test", 0.9);
      handleResponse("conv-1", "decline"); // declined_count = 1
      const state = getOrCreateState("conv-1");
      state.last_suggestion_at = 1;
      state.suggestions_this_turn = 0;
      state.declined_count = 2; // simulate 2 declines
      // effective gap = 3 + (2 * 2) = 7 turns
      for (let i = 0; i < 5; i++) advanceTurn("conv-1"); // now turn 6
      expect(shouldSuggest("conv-1", null).allowed).toBe(false); // gap = 6-1=5, need 7
      advanceTurn("conv-1"); // turn 7
      advanceTurn("conv-1"); // turn 8, gap = 8-1=7
      expect(shouldSuggest("conv-1", null).allowed).toBe(true);
    });

    it("blocks when pending suggestion exists", () => {
      const state = getOrCreateState("conv-1");
      state.active_suggestion = {
        capture_id: "cap-1",
        content_type: "workflow",
        raw_content: "test",
        confidence: 0.9,
        suggested_at: Date.now(),
      };
      expect(shouldSuggest("conv-1", null).allowed).toBe(false);
    });
  });

  describe("buildSuggestionMessageDeterministic", () => {
    it("returns message for each content type", () => {
      for (const type of ["workflow", "decision", "policy", "process", "integration", "reference"] as const) {
        const msg = buildSuggestionMessageDeterministic(type);
        expect(msg.length).toBeGreaterThan(10);
        expect(msg).toContain("?"); // All are questions
      }
    });

    it("returns consistent message for same type", () => {
      const a = buildSuggestionMessageDeterministic("decision");
      const b = buildSuggestionMessageDeterministic("decision");
      expect(a).toBe(b);
    });
  });

  describe("createSuggestion", () => {
    it("sets active suggestion on state", () => {
      createSuggestion("conv-1", "cap-1", "workflow", "raw text", 0.85);
      const state = getOrCreateState("conv-1");
      expect(state.active_suggestion).not.toBeNull();
      expect(state.active_suggestion!.capture_id).toBe("cap-1");
      expect(state.active_suggestion!.content_type).toBe("workflow");
      expect(state.suggestions_this_turn).toBe(1);
      expect(state.total_suggestions).toBe(1);
    });
  });

  describe("parseUserResponse", () => {
    it("parses accept responses", () => {
      for (const r of ["yes", "y", "sure", "yeah", "ok", "please", "do it", "go ahead"]) {
        expect(parseUserResponse(r)).toBe("accept");
      }
    });

    it("parses decline responses", () => {
      for (const r of ["no", "n", "nah", "nope", "not now", "skip", "later"]) {
        expect(parseUserResponse(r)).toBe("decline");
      }
    });

    it("returns null for unrelated text", () => {
      expect(parseUserResponse("Tell me about the weather")).toBeNull();
      expect(parseUserResponse("What time is it")).toBeNull();
    });

    it("is case insensitive", () => {
      expect(parseUserResponse("YES")).toBe("accept");
      expect(parseUserResponse("No")).toBe("decline");
    });
  });

  describe("handleResponse", () => {
    it("accept returns refine action", () => {
      createSuggestion("conv-1", "cap-1", "decision", "raw", 0.9);
      const result = handleResponse("conv-1", "accept");
      expect(result.action).toBe("refine");
      expect(result.suggestion!.capture_id).toBe("cap-1");
      expect(getOrCreateState("conv-1").active_suggestion).toBeNull();
    });

    it("decline returns queue_silent and increments decline count", () => {
      createSuggestion("conv-1", "cap-1", "decision", "raw", 0.9);
      const result = handleResponse("conv-1", "decline");
      expect(result.action).toBe("queue_silent");
      expect(getOrCreateState("conv-1").declined_count).toBe(1);
    });

    it("ignore returns queue_silent", () => {
      createSuggestion("conv-1", "cap-1", "decision", "raw", 0.9);
      const result = handleResponse("conv-1", "ignore");
      expect(result.action).toBe("queue_silent");
    });

    it("returns none when no active suggestion", () => {
      const result = handleResponse("conv-1", "accept");
      expect(result.action).toBe("none");
      expect(result.suggestion).toBeNull();
    });
  });

  describe("evaluateForSuggestion", () => {
    it("suggests when pattern detected and caps allow", async () => {
      const mockSql = createMockSql();
      const result = await evaluateForSuggestion(
        mockSql,
        "We decided to use Postgres because it handles JSON better than the alternatives we tested",
        "telegram",
        "conv-1",
        null,
        { confidence_threshold: 0.5, min_message_length: 10, cooldown_seconds: 0 },
      );
      expect(result.suggest).toBe(true);
      expect(result.message).toBeTruthy();
      expect(result.capture_id).toBe("cap-1");
    });

    it("does not suggest when caps block", async () => {
      const mockSql = createMockSql();
      const state = getOrCreateState("conv-1");
      state.total_suggestions = 5; // at cap
      const result = await evaluateForSuggestion(
        mockSql,
        "We decided to use Redis because it fits our caching requirements perfectly",
        "telegram",
        "conv-1",
        null,
        { confidence_threshold: 0.5, min_message_length: 10, cooldown_seconds: 0 },
      );
      expect(result.suggest).toBe(false);
    });

    it("does not suggest in suppressed mode", async () => {
      const mockSql = createMockSql();
      const result = await evaluateForSuggestion(
        mockSql,
        "We decided to use Postgres because of better JSON support and consistency guarantees",
        "telegram",
        "conv-1",
        "brain_dump",
        { confidence_threshold: 0.5, min_message_length: 10, cooldown_seconds: 0 },
      );
      expect(result.suggest).toBe(false);
    });

    it("does not suggest for non-detectable content", async () => {
      const mockSql = createMockSql();
      const result = await evaluateForSuggestion(
        mockSql,
        "Hey how are you doing today",
        "telegram",
        "conv-1",
        null,
      );
      expect(result.suggest).toBe(false);
    });

    it("handles SQL failure gracefully", async () => {
      const mockSql: any = function () { return Promise.reject(new Error("DB down")); };
      const result = await evaluateForSuggestion(
        mockSql,
        "We decided to use Postgres because it handles our JSON workload better than anything else",
        "telegram",
        "conv-1",
        null,
        { confidence_threshold: 0.5, min_message_length: 10, cooldown_seconds: 0 },
      );
      expect(result.suggest).toBe(false);
    });
  });
});
