/**
 * UMS Connector Tests: Microsoft Graph — ELLIE-708
 */

import { describe, test, expect } from "bun:test";
import { microsoftGraphConnector } from "../src/ums/connectors/microsoft-graph.ts";
import { microsoftGraphFixtures as fx } from "./fixtures/ums-connector-payloads.ts";

describe("microsoftGraphConnector", () => {
  test("provider is 'microsoft-graph'", () => {
    expect(microsoftGraphConnector.provider).toBe("microsoft-graph");
  });

  // ── Mail ─────────────────────────────────────────────────

  describe("mail", () => {
    test("normalizes Outlook mail", () => {
      const result = microsoftGraphConnector.normalize(fx.mail);
      expect(result).not.toBeNull();
      expect(result!.provider).toBe("microsoft-graph");
      expect(result!.provider_id).toBe("mail:graph-mail-001");
      expect(result!.channel).toBe("outlook-mail:graph-conv-001");
      expect(result!.content).toContain("Budget Review");
      expect(result!.content).toContain("Please review the attached budget");
      expect(result!.content_type).toBe("text");
      expect(result!.sender).toEqual({ name: "CFO", email: "cfo@contoso.com" });
      expect(result!.metadata).toMatchObject({
        graph_service: "mail",
        subject: "Budget Review",
        is_read: false,
        has_attachments: true,
        importance: "high",
        flag_status: "flagged",
      });
    });
  });

  // ── Calendar ─────────────────────────────────────────────

  describe("calendar", () => {
    test("normalizes Outlook calendar event", () => {
      const result = microsoftGraphConnector.normalize(fx.calendar);
      expect(result).not.toBeNull();
      expect(result!.provider_id).toBe("calendar:graph-cal-001");
      expect(result!.channel).toBe("outlook-calendar:primary");
      expect(result!.content).toContain("Meeting: Board Meeting");
      expect(result!.content).toContain("with Dave, CFO");
      expect(result!.content).toContain("@ Main Conference Room");
      expect(result!.content_type).toBe("event");
      expect(result!.sender).toEqual({ name: "CEO", email: "ceo@contoso.com" });
      expect(result!.metadata).toMatchObject({
        graph_service: "calendar",
        title: "Board Meeting",
        all_day: false,
        show_as: "busy",
        meeting_url: "https://teams.microsoft.com/meet/abc",
        attendee_count: 2,
      });
    });

    test("skips cancelled calendar events", () => {
      expect(microsoftGraphConnector.normalize(fx.cancelledCalendar)).toBeNull();
    });
  });

  // ── Teams ────────────────────────────────────────────────

  describe("teams", () => {
    test("normalizes Teams chat message", () => {
      const result = microsoftGraphConnector.normalize(fx.teams);
      expect(result).not.toBeNull();
      expect(result!.provider_id).toBe("teams:teams-msg-001");
      expect(result!.channel).toBe("teams:chat:chat-001");
      expect(result!.content).toBe("Hey team, quick update");
      expect(result!.content_type).toBe("text");
      expect(result!.sender).toEqual({ name: "Alice", id: "user-alice" });
      expect(result!.metadata).toMatchObject({
        graph_service: "teams",
        is_channel: false,
        chat_id: "chat-001",
      });
    });

    test("normalizes Teams channel message", () => {
      const result = microsoftGraphConnector.normalize(fx.teamsChannel);
      expect(result).not.toBeNull();
      expect(result!.channel).toBe("teams:team-001:channel-general");
      expect(result!.content).toContain("Announcement");
      expect(result!.content).toContain("Channel post here");
      expect(result!.metadata!.is_channel).toBe(true);
      expect(result!.metadata!.team_id).toBe("team-001");
    });

    test("skips system event messages", () => {
      expect(microsoftGraphConnector.normalize(fx.teamsSystem)).toBeNull();
    });
  });

  // ── Todo ─────────────────────────────────────────────────

  describe("todo", () => {
    test("normalizes MS Todo task", () => {
      const result = microsoftGraphConnector.normalize(fx.todo);
      expect(result).not.toBeNull();
      expect(result!.provider_id).toBe("todo:todo-001");
      expect(result!.channel).toBe("ms-todo:list-work");
      expect(result!.content).toContain("Review PR");
      expect(result!.content).toContain("Check the UMS connector tests");
      expect(result!.content_type).toBe("task");
      expect(result!.metadata).toMatchObject({
        graph_service: "todo",
        status: "inProgress",
        importance: "high",
        list_id: "list-work",
      });
      expect(result!.metadata!.linked_resources).toHaveLength(1);
      expect(result!.metadata!.linked_resources[0]).toMatchObject({
        app: "GitHub",
        name: "PR #42",
      });
    });
  });

  // ── OneDrive ─────────────────────────────────────────────

  describe("onedrive", () => {
    test("normalizes OneDrive file change", () => {
      const result = microsoftGraphConnector.normalize(fx.onedrive);
      expect(result).not.toBeNull();
      expect(result!.provider_id).toBe("onedrive:drive-001");
      expect(result!.channel).toBe("onedrive:drive-main");
      expect(result!.content).toBe('File modified: "Q1-Budget.xlsx"');
      expect(result!.content_type).toBe("notification");
      expect(result!.sender).toEqual({ name: "CFO", email: "cfo@contoso.com" });
      expect(result!.metadata).toMatchObject({
        graph_service: "onedrive",
        file_name: "Q1-Budget.xlsx",
        is_folder: false,
        change_type: "modified",
      });
    });

    test("normalizes OneDrive folder change", () => {
      const result = microsoftGraphConnector.normalize(fx.onedriveFolder);
      expect(result).not.toBeNull();
      expect(result!.content).toBe('Folder created: "New Project" (3 items)');
      expect(result!.metadata!.is_folder).toBe(true);
      expect(result!.sender).toBeNull(); // no lastModifiedBy
    });
  });

  // ── Auto-detection ───────────────────────────────────────

  describe("auto-detection", () => {
    test("auto-detects mail payload", () => {
      const result = microsoftGraphConnector.normalize(fx.autoDetectMail);
      expect(result).not.toBeNull();
      expect(result!.provider_id).toBe("mail:auto-mail-001");
      expect(result!.content).toContain("Auto-detected mail");
    });

    test("auto-detects calendar payload", () => {
      const result = microsoftGraphConnector.normalize(fx.autoDetectCalendar);
      expect(result).not.toBeNull();
      expect(result!.provider_id).toBe("calendar:auto-cal-001");
      expect(result!.content_type).toBe("event");
    });

    test("auto-detects Teams payload", () => {
      const result = microsoftGraphConnector.normalize(fx.autoDetectTeams);
      expect(result).not.toBeNull();
      expect(result!.provider_id).toBe("teams:auto-teams-001");
      expect(result!.content).toBe("Auto-detected teams message");
    });

    test("auto-detects Todo payload", () => {
      const result = microsoftGraphConnector.normalize(fx.autoDetectTodo);
      expect(result).not.toBeNull();
      expect(result!.provider_id).toBe("todo:auto-todo-001");
      expect(result!.content_type).toBe("task");
    });

    test("auto-detects OneDrive payload", () => {
      const result = microsoftGraphConnector.normalize(fx.autoDetectOneDrive);
      expect(result).not.toBeNull();
      expect(result!.provider_id).toBe("onedrive:auto-drive-001");
    });

    test("returns null for unrecognized payload", () => {
      expect(microsoftGraphConnector.normalize(fx.unknownPayload)).toBeNull();
    });
  });

  // ── Edge cases ───────────────────────────────────────────

  test("returns null for empty payload", () => {
    expect(microsoftGraphConnector.normalize(fx.empty)).toBeNull();
  });

  test("returns null for null/undefined", () => {
    expect(microsoftGraphConnector.normalize(null)).toBeNull();
    expect(microsoftGraphConnector.normalize(undefined)).toBeNull();
  });
});
