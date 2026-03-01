---
name: forest-import
description: Import web content into the Forest knowledge base with auto-tagging and smart categorization
userInvocable: true
triggers: [http://, https://, import, save this, add to forest, remember this link]
---

# Forest Import — Link-to-Knowledge Pipeline

Streamline importing web content into the Forest. Send a link, get a structured preview, approve, done.

## When to Trigger

### Automatic
- User sends a message containing one or more URLs (http:// or https://)
- User says "import this", "save this to the forest", "add this link"
- User says "remember this article" or similar

### Manual
When the user explicitly asks to import a link they previously sent

## Workflow

### Step 1: Detect Links

Scan the user's message for URLs. Extract all unique links.

**Single link:** Process immediately
**Multiple links:** Ask if they want batch import or one-at-a-time

### Step 2: Fetch Content

For each link, use WebFetch to retrieve the content:

```
WebFetch(url, "Extract the main content, key points, and any actionable insights from this page. Ignore navigation, ads, and boilerplate.")
```

### Step 3: Analyze Content

Process the fetched content to determine:

**Type classification:**
- `fact` — Established research, documentation, reference material
- `finding` — Analysis, insights, observations
- `resource` — Tools, services, platforms, interactive content
- `principle` — Design guidelines, best practices, frameworks
- `perspective` — Personal narratives, simulations, experiential content

**Scope path suggestion:**
- Does it apply globally across all projects? → `2`
- Specific to ellie-dev (relay, agents, integrations)? → `2/1`
- Specific to ellie-forest (library, DB, migrations)? → `2/2`
- Specific to ellie-home (dashboard, UI)? → `2/3`
- Specific to ellie-os-app? → `2/4`

**Tag generation:**
- Extract 3-7 relevant tags from content and URL
- Include domain keywords (accessibility, dyslexia, tts, etc.)
- Add category tags (research, tool, documentation, etc.)

**Confidence rating:**
- Source credibility + content depth + relevance
- Range: 0.6 (speculative) to 0.95 (verified authoritative source)

**Related entries:**
- Query the Forest for similar existing entries
- Suggest links between related knowledge

### Step 4: Show Preview

Present a structured preview in this format:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FOREST IMPORT PREVIEW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📎 [Title from page]
🔗 [URL]

Type:       [fact|finding|resource|principle|perspective]
Scope:      [2/1] (ellie-dev) [or appropriate scope]
Tags:       #tag1 #tag2 #tag3 #tag4
Confidence: [0.85]

━━ SUMMARY ━━
[2-3 sentence overview of what this content is and why it matters]

━━ KEY POINTS ━━
- Point 1
- Point 2
- Point 3

━━ RELEVANCE TO ELLIE ━━
[1-2 sentences on how this applies to the Ellie OS projects]

━━ RELATED FOREST ENTRIES ━━
[If similar entries exist, list them]
- [Entry title] (memoryId: abc123)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Approve] [Edit] [Skip]
```

### Step 5: Handle User Response

**Approve:**
- Write to Forest using the Forest Bridge API
- Confirm with memoryId returned
- Suggest next action if applicable

**Edit:**
- Ask what to change (scope, tags, type, content summary)
- Show updated preview
- Repeat approval step

**Skip:**
- Don't import
- Move to next link if batch mode

### Step 6: Write to Forest

```bash
curl -s -X POST http://localhost:3001/api/bridge/write \
  -H "Content-Type: application/json" \
  -H "x-bridge-key: bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a" \
  -d '{
    "content": "[Summary + key points + relevance + source URL]",
    "type": "[detected type]",
    "scope_path": "[suggested scope]",
    "confidence": [0.85],
    "tags": ["tag1", "tag2", "tag3"],
    "metadata": {
      "source_url": "[URL]",
      "imported_by": "dave",
      "import_date": "[YYYY-MM-DD]",
      "category": "[category]"
    }
  }'
```

### Step 7: Confirm

```
✅ Saved to Forest
Memory ID: abc123def456
Scope: 2 (global)
Tags: #accessibility #dyslexia #research

This is now available to all Ellie agents across all projects.
```

If related entries were found, optionally ask: "Want me to link this to the related entries I found?"

## Batch Mode

When multiple links are provided:

1. **Fetch all in parallel** (if 5 or fewer links)
2. **Analyze all**
3. **Show all previews together** in a numbered list
4. **Ask for batch approval**: "Approve all? / Approve selected / Review one-by-one"

**Batch approval:**
- User can say "approve all", "approve 1 3 5", "skip 2 and 4"
- Write approved entries to Forest
- Show summary: "3 of 5 imported. Skipped: 2, 4"

## Smart Features

### Auto-Category Detection

Recognize common content types:

| Pattern | Category | Type |
|---------|----------|------|
| readingrockets.org, understood.org, cast.org | accessibility-research | fact |
| github.com/*/README | tool-documentation | resource |
| youtube.com, vimeo.com | video-content | resource |
| medium.com, substack.com | blog-post | finding |
| arxiv.org, scholar.google.com | academic-research | fact |
| docs.* | official-documentation | fact |

### Duplicate Detection

Before writing, query the Forest for the same URL:

```bash
curl -s -X POST http://localhost:3001/api/bridge/read \
  -H "x-bridge-key: bk_..." \
  -H "Content-Type: application/json" \
  -d '{"query": "[exact URL]", "scope_path": "2"}'
```

If found: "This link is already in the Forest (memoryId: xyz). Want to update it or skip?"

### Context Awareness

If the import happens during active work on a ticket (e.g., ELLIE-256):
- Auto-tag with work item ID
- Add to metadata: `"work_item_id": "ELLIE-256"`
- Suggest scope based on ticket's project

### Link Extraction from Conversations

If the user says "import the links we talked about", scan the last 10 messages for URLs and offer to batch import them.

## Rules

- **Never auto-import without showing a preview** — always get approval first
- **Preserve the original URL** — always include source_url in metadata
- **Be generous with tags** — 5-7 tags is better than 2-3 for discoverability
- **Default to global scope if uncertain** — easier to scope down later than to miss cross-project value
- **Summarize, don't copy-paste** — content should be 2-4 paragraphs max, focused on key insights
- **Make it scannable** — use bullets, headers, bold key terms
- **Flag low-quality sources** — if content is thin, promotional, or low-credibility, note it in the preview

## Edge Cases

**Link is paywalled or requires login:**
→ "I can't fetch this content (paywall/login required). Want to manually paste the key points and I'll structure it for the Forest?"

**Link is a PDF, video, or non-HTML:**
→ "This is a [PDF/video]. I can save the link and metadata to the Forest, but I can't extract content automatically. Want to add a manual summary?"

**Link is dead (404):**
→ "This link is broken. Want to save it anyway with a note that the source is unavailable?"

**Content is extremely long (>10k words):**
→ "This is a long article. I'll extract the key points, but if you want the full text indexed, I can save a longer summary."

**User sends a link with no context:**
→ Fetch it and show the preview. Don't ask "what's this for?" — analyze and present, let them approve or edit.

## Examples

### Example 1: Single Link

**User:** "https://www.readingrockets.org/topics/assistive-technology/articles/text-speech-technology-what-it-and-how-it-works"

**Assistant:**
> Fetching that article now...

[Shows preview with type: fact, scope: 2, tags: #accessibility #dyslexia #tts #research]

> Ready to import. Approve?

**User:** "yes"

**Assistant:**
> ✅ Saved to Forest (memoryId: abc123)
>
> This is now available to all agents when working on accessibility features.

### Example 2: Batch Import

**User sends 3 accessibility links**

**Assistant:**
> Found 3 links — I'll analyze them and show you a batch preview.

[Fetches all, shows numbered previews]

> Approve all 3? Or select specific ones?

**User:** "approve all"

**Assistant:**
> ✅ All 3 saved to Forest
>
> - TTS technology (abc123)
> - Learning differences (def456)
> - AT toolkit (ghi789)
>
> These form a solid accessibility framework now available across all projects.

### Example 3: Duplicate

**User sends a link already in the Forest**

**Assistant:**
> This link is already in the Forest from Feb 26.
>
> **Existing entry:**
> "Text-to-speech technology research from Reading Rockets..." (memoryId: abc123)
>
> Want to update it, skip, or create a new entry with different framing?

## Success Criteria

- User can send a link and get it into the Forest in under 30 seconds
- Previews are accurate and useful — type, scope, tags feel right
- Batch mode handles 5+ links smoothly
- No duplicate entries for the same URL unless intentionally updated
- Tags make entries discoverable via Forest search

## Future Enhancements

- **Auto-summarization via audio:** Offer to generate a 60-second audio summary of imported content
- **Link collections:** Group related links into a "grove" (e.g., "Accessibility Research Feb 2026")
- **Scheduled imports:** "Import the top 3 articles from [RSS feed] every Monday"
- **Integration with bookmarks:** Import from browser bookmarks, Pocket, Raindrop
