---
name: quality-review
description: Structured quantitative code review with dimension scoring (0-4) and severity taxonomy (P0-P3)
triggers:
  - review this
  - code review
  - quality check
  - is this ready to ship
  - critique this
requirements: []
always_on: false
---

# Quality Review Skill

Produce a structured, quantitative code review using Brian's quality scoring framework.

## When to Use
- When asked to review code, PRs, or architectural changes
- When Dave asks "is this ready to ship?"
- Before merging significant changes

## Process
1. Read and understand the code changes
2. Score each of the 7 dimensions (0-4)
3. Classify findings by severity (P0-P3)
4. Apply quality gate (60% threshold, P0 blocks)
5. Output structured review with verdict

## Dimensions
- **Correctness** (1.5x): Logic errors, edge cases, off-by-one
- **Security** (1.5x): Injection, auth, secrets, validation
- **Maintainability** (1.0x): Readability, naming, structure, DRY
- **Test Coverage** (1.0x): Critical paths, edge cases, error paths
- **Performance** (0.8x): Complexity, allocations, queries
- **Error Handling** (0.8x): Degradation, messages, recovery
- **Architecture** (0.7x): Fit, coupling, patterns

## Severity
- **P0 Blocking**: Security hole, data loss, crash — Must fix before merge
- **P1 Major**: Broken feature, edge case, flaw — Fix before release
- **P2 Minor**: Quality, inconsistency — Track for follow-up
- **P3 Polish**: Style, naming, rare case — Optional
