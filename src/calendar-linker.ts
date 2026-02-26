/**
 * Calendar-Conversation Linker — ELLIE-250
 *
 * Detects when calendar events are mentioned in conversation messages.
 * Stores links in conversation metadata for cross-reference.
 *
 * Uses keyword matching against upcoming events — no LLM call needed.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";

const logger = log.child("calendar-linker");

interface CalendarEvent {
  external_id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  attendees: Array<{ name?: string; email?: string }> | null;
  location: string | null;
}

interface CalendarLink {
  event_id: string;
  event_title: string;
  event_start: string;
  matched_on: string;  // what triggered the match
  linked_at: string;
}

/** Words too generic to use for matching event titles. */
const STOP_WORDS = new Set([
  "meeting", "call", "sync", "chat", "check", "review", "update",
  "the", "a", "an", "to", "for", "with", "on", "at", "in", "and",
  "is", "it", "my", "we", "our", "this", "that", "are", "be",
]);

/**
 * Extract meaningful keywords from an event title.
 * Returns lowercase tokens that are at least 3 chars and not stop words.
 */
function eventKeywords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Check if a user message mentions any upcoming calendar events.
 * Returns matched events with the matching keywords.
 */
function findEventMentions(
  message: string,
  events: CalendarEvent[],
): Array<{ event: CalendarEvent; matchedOn: string }> {
  const msgLower = message.toLowerCase();
  const matches: Array<{ event: CalendarEvent; matchedOn: string }> = [];

  for (const event of events) {
    if (!event.title) continue;

    // Check 1: Exact title substring match (case-insensitive)
    if (event.title.length >= 5 && msgLower.includes(event.title.toLowerCase())) {
      matches.push({ event, matchedOn: `title:"${event.title}"` });
      continue;
    }

    // Check 2: Keyword overlap — at least 2 meaningful keywords from the title
    const keywords = eventKeywords(event.title);
    if (keywords.length >= 2) {
      const matched = keywords.filter(kw => msgLower.includes(kw));
      if (matched.length >= 2) {
        matches.push({ event, matchedOn: `keywords:${matched.join("+")}` });
        continue;
      }
    }

    // Check 3: Attendee name mentioned (if talking about a person + meeting context)
    if (event.attendees?.length) {
      const meetingWords = ["meeting", "call", "sync", "chat", "standup", "1:1", "catch up", "session"];
      const hasMeetingContext = meetingWords.some(w => msgLower.includes(w));

      if (hasMeetingContext) {
        for (const att of event.attendees) {
          const name = att.name?.toLowerCase();
          if (name && name.length >= 3 && msgLower.includes(name)) {
            matches.push({ event, matchedOn: `attendee:"${att.name}"` });
            break;
          }
        }
      }
    }
  }

  return matches;
}

/**
 * Fetch upcoming calendar events from the Forest database.
 * Falls back gracefully if the table doesn't exist or is empty.
 */
async function getUpcomingEvents(supabase: SupabaseClient): Promise<CalendarEvent[]> {
  try {
    const now = new Date().toISOString();
    const threeDaysOut = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from("calendar_events")
      .select("external_id, title, start_time, end_time, attendees, location")
      .gte("start_time", now)
      .lte("start_time", threeDaysOut)
      .order("start_time", { ascending: true })
      .limit(20);

    if (error || !data) return [];
    return data as CalendarEvent[];
  } catch {
    return [];
  }
}

/**
 * Detect calendar event mentions in a message and link them to the conversation.
 * Stores links in conversation metadata under `calendar_links`.
 *
 * Designed to run fire-and-forget after saving each user message.
 */
export async function detectAndLinkCalendarEvents(
  userMessage: string,
  supabase: SupabaseClient,
  conversationId: string,
): Promise<void> {
  // Skip short messages unlikely to reference events
  if (userMessage.length < 15) return;

  const events = await getUpcomingEvents(supabase);
  if (events.length === 0) return;

  const mentions = findEventMentions(userMessage, events);
  if (mentions.length === 0) return;

  // Read existing metadata
  const { data: convo } = await supabase
    .from("conversations")
    .select("metadata")
    .eq("id", conversationId)
    .single();

  const metadata = (convo?.metadata || {}) as Record<string, unknown>;
  const existingLinks = (metadata.calendar_links || []) as CalendarLink[];
  const existingIds = new Set(existingLinks.map(l => l.event_id));

  // Add new links (deduplicate)
  const newLinks: CalendarLink[] = [];
  for (const { event, matchedOn } of mentions) {
    if (existingIds.has(event.external_id)) continue;
    newLinks.push({
      event_id: event.external_id,
      event_title: event.title,
      event_start: event.start_time,
      matched_on: matchedOn,
      linked_at: new Date().toISOString(),
    });
  }

  if (newLinks.length === 0) return;

  // Update conversation metadata
  const updatedLinks = [...existingLinks, ...newLinks];
  await supabase
    .from("conversations")
    .update({ metadata: { ...metadata, calendar_links: updatedLinks } })
    .eq("id", conversationId);

  for (const link of newLinks) {
    console.log(`[calendar-link] Linked "${link.event_title}" to conversation ${conversationId.slice(0, 8)} (${link.matched_on})`);
  }
}
