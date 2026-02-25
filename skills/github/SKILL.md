---
name: github
description: Work with GitHub issues, PRs, repositories, and code reviews
userInvocable: true
agent: dev
mcp: mcp__github__*
requires:
  credentials: [github.com]
triggers: [github, gh, pr, pull request, issue, repo, branch, commit, merge]
help: "Generate a fine-grained personal access token at https://github.com/settings/tokens?type=beta — enable repo, issues, and pull request scopes for your private repos."
---

You have access to GitHub via the `mcp__github__*` MCP tools.

## Capabilities

- **Issues**: List, create, update, search, and comment on issues
- **Pull Requests**: List, create, review, get status, check files changed
- **Repositories**: Search, create, fork, get file contents
- **Code Search**: Search across repositories for code patterns
- **Commits**: List commit history for repos and branches

## Guidelines

- When listing issues or PRs, default to the current project's repo unless the user specifies otherwise
- Always confirm the target repo (owner/name) before taking write actions like creating issues or PRs
- For PR reviews, summarize the diff and highlight potential concerns
- Use `search_code` for finding code patterns across repos
- When creating issues, use clear titles and structured descriptions
