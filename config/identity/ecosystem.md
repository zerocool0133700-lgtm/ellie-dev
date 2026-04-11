# LEOS Ecosystem

Three consumer products sharing the Ellie OS platform layer (identity, agents, knowledge, Forest).

## Ellie Life (scope 2/5, code: ellie-app/plugins/life/)
- Daily life management: tasks, shopping lists, health, family, errands
- Health module with adaptive tracking (activity mentions → meal logging → smartwatch integration)
- Life categories: work, home, health, family, errands (not productivity categories)
- Add-on modules at $2.99/mo each: Health & Wellness, Family & Home, Money & Budget
- Base product: onboarding, home dashboard, chat with persistent memory, life organization, communication filtering
- Status: ~85% complete per Dave's assessment

## Ellie Learn (scope 2/6, code: ellie-app/plugins/learn/)
- Lifelong learning for people with learning disabilities (children through adults)
- Creature tutors: Owl (wisdom/deep understanding), Fox (quick/adaptive), Bear (patient/foundational)
- Cognitive engines: PSY (psychological profiling), phases, health assessment, context-mode
- Per-school Forest DB + shared Memory DB architecture
- 56 endpoints, 16 tables, 12 pages built in one session (2026-04-05)
- Architecture doc: ellie-app/docs/ellie-learn-module-architecture.md (~858 lines)
- Design doc: ellie-dev/docs/ellie-learn-design.md (Part 1 + Part 2)
- 4 persona journeys designed: dyslexic child, ADHD teen, adult career changer, elderly learner
- Status: ~70% complete, more complex issues remaining (teaching is harder than task management)

## Ellie Work (scope 2/7)
- Profession-aware AI partner for specific verticals
- Target use cases: accountant (spreadsheets, tax codes), medical billing clerk (CPT codes, payer rules), vet office (scheduling, records)
- Core differentiator: AI that understands YOUR specific job, not generic "AI for work"
- Status: Early concept phase, vision defined

## Cross-Product Connections
- Learn builds capabilities → Work applies them professionally → Life manages everything else
- Shared platform: Ellie OS provides identity, agents, knowledge Forest, memory pipeline
- Same user's knowledge flows across all three products

## Key Reference Documents
- Ecosystem design spec: ellie-dev/docs/superpowers/specs/2026-04-04-ellie-app-ecosystem-design.md
- Learn module architecture: ellie-app/docs/ellie-learn-module-architecture.md
- Learn design (Parts 1+2): ellie-dev/docs/ellie-learn-design.md
- App codebase: ellie-app/ (Tauri desktop app with plugin-based module system)
