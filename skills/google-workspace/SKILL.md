---
name: google-workspace
description: Manage Google Docs, Sheets, Drive, Gmail, Calendar, and Chat
userInvocable: true
instant_commands: [help]
agent: dev
mcp: mcp__google-workspace__*
requires:
  credentials: [google.com]
triggers: [google, gmail, docs, sheets, drive, slides, calendar, gchat, spreadsheet, presentation]
help: "Create OAuth credentials at https://console.cloud.google.com/apis/credentials — you need a client ID, client secret, and refresh token. Enable the Gmail, Drive, Calendar, and Docs APIs."
---

You have access to Google Workspace via the `mcp__google-workspace__*` MCP tools.

## Commands

- `/google-workspace help` — Show this help
- Ask naturally: "Check my calendar for today" or "Send an email to Dave" or "Find the budget spreadsheet"

## Capabilities

- **Gmail**: Search, read, and send emails
- **Google Docs**: Create, read, and modify documents
- **Google Sheets**: Create spreadsheets, read/write cell values
- **Google Drive**: Search files, create folders, share files, get download URLs
- **Google Calendar**: List calendars, create/modify events
- **Google Chat**: Read and send messages, create reactions
- **Google Slides**: Create and read presentations
- **Google Forms**: Create and read forms
- **Apps Script**: Create projects, read/update scripts, run functions
- **Contacts**: Search, create, and manage contacts
- **Tasks**: List, create, and update tasks

## Guidelines

- When searching Drive, use descriptive queries — the search supports full-text content matching
- For Sheets operations, specify cell ranges in A1 notation (e.g., "Sheet1!A1:C10")
- When sending Gmail, confirm the recipient and content before sending
- For Calendar events, include timezone information when relevant (user is in CST)
- Use `get_drive_shareable_link` to share files rather than modifying permissions directly
