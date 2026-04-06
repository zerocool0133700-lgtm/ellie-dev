# Side Navigation Bar UI

> Dashboard URL: `https://dashboard.ellie-labs.dev/`
> Source: `ellie-home/app/layouts/default.vue`
> Themes: `ellie-home/app/utils/themes.ts`

## Overview

The side navigation bar is the primary navigation element of the Ellie Home dashboard. It's a fixed sidebar on desktop (collapsed icon-only at `md`, expanded with labels at `lg`) and a bottom tab bar on mobile. All labels and icons are theme-driven — the same routes display differently depending on the selected "Vibe" theme.

---

## Structure

The sidebar has 5 sections from top to bottom:

1. **Logo + Title** — Pulsing emerald dot + "Ellie Home" text
2. **Navigation Links** — All dashboard pages
3. **Quick Capture** — `<QuickCaptureFab />` component
4. **Personalization Pickers** — Vibe, Style, Voice selectors (desktop only)
5. **Status + Clock** — Connection status + current time (CST)

---

## Navigation Routes

28 pages in the sidebar, each mapped to a theme-aware `NavKey`:

| Route | NavKey | Forest Theme | Clean Theme | Description |
|-------|--------|-------------|-------------|-------------|
| `/` | `canopy` | Canopy 🌱 | Home 🏠 | Main dashboard / overview |
| `/agents` | `creatures` | Creatures 🐛 | Assistants 🤖 | Agent profiles and management |
| `/agents/compliance` | `growth` | Growth 🌱 | Compliance 📈 | Agent compliance and outcomes |
| `/models` | `sunlight` | Sunlight ☀ | Models ⚡ | LLM model registry |
| `/gtd` | `trails` | Trails 👣 | Tasks ☑ | GTD task management |
| `/conversations` | `the_land` | The Land 🌏 | Knowledge 📚 | Conversation history and memory |
| `/work` | `logs` | Logs 🪵 | Activity 📄 | Work sessions and activity |
| `/forest` | `forest` | Forest 🌲 | Structure 📂 | Forest knowledge graph |
| `/incidents` | `storms` | Storms ⛈ | Incidents 🚨 | Incident tracking |
| `/entities` | `roots` | Roots 🍂 | Accounts 👤 | Entity management |
| `/analytics` | `rings` | Rings 🔘 | Analytics 📈 | Usage analytics |
| `/actions` | `seeds` | Seeds 🌾 | Events 🔔 | Action items and events |
| `/credentials` | `hollow` | Hollow 🔳 | Vault 🔐 | Credential vault (The Hollow) |
| `/skills` | `flowers` | Flowers 🌸 | Skills ⭐ | Skill management |
| `/groves` | `groves` | Groves 🌳 | Groups 👥 | Grove / group management |
| `/knowledge` | `knowledge` | Wisdom 📖 | Knowledge 📚 | Knowledge base |
| `/ellie-chat` | `wind` | Wind 🌬 | Messages 💬 | Real-time chat with agents |
| `/psy` | `mycelium` | Mycelium 🧠 | Profile 🧠 | Psychological / cognitive profile |
| `/ellie` | `heartwood` | Heartwood 🌳 | System ⚙ | Ellie core system page |
| `/jobs` | `burrows` | Burrows 🐰 | Jobs 🐰 | Job queue and tracking |
| `/marketplace` | `marketplace` | Nursery 🌿 | Templates 📦 | Marketplace / templates |
| `/river` | `river` | River 🌊 | Prompts 📄 | River vault (prompt architecture) |
| `/capture` | `capture` | Capture 📦 | Inbox 📥 | Capture pipeline inbox |
| `/containers` | `containers` | Terrariums 🌐 | Containers 📦 | Docker container management |
| `/scheduled-tasks` | `schedules` | Seasons ⏰ | Schedules ⏰ | Cron / scheduled tasks |
| `/context-metrics` | `clearing` | Clearing 🖼 | Workspace 🖼 | Context compression metrics |
| `/knowledge-canvas` | `canvas` | Web 🔸 | Graph 🔸 | Knowledge graph visualization |
| `/admin` | `admin` | Roots ⚙ | Admin ⚙ | System administration |

### Active State Logic

- Exact match for `/` (home)
- Prefix match for sub-routes (e.g., `/agents/compliance` highlights `/agents/compliance`, not `/agents`)
- More-specific sibling routes take precedence (prevents parent highlighting when on child route)

### Capture Badge

The `/capture` route shows a live count badge when items are pending in the capture pipeline:
- Emerald pill with white text
- Count from `useCaptureStatus()` composable
- Updates on mount and route change

---

## Theme System (6 Themes)

Every navigation label and icon changes based on the selected "Vibe" theme:

| Theme | Name | Metaphor | Example: `/ellie-chat` |
|-------|------|----------|----------------------|
| `forest` | Forest | Alive, organic, growing | Wind 🌬 |
| `clean` | Clean | Professional, no metaphor | Messages 💬 |
| `space` | Space | Command your station | Comms 📡 |
| `ocean` | Ocean | Navigate the deep | Signals 🔸 |
| `medical` | Medical | Clinical precision | Pages 📟 |
| `business` | Business | Results-driven corporate | Inbox 📩 |

### Full Theme Comparison (Selected Routes)

| NavKey | Forest | Clean | Space | Ocean | Medical | Business |
|--------|--------|-------|-------|-------|---------|----------|
| `canopy` | Canopy | Home | Mission Control | Lighthouse | Vitals | Dashboard |
| `creatures` | Creatures | Assistants | Crew | Sea Life | Care Team | Staff |
| `trails` | Trails | Tasks | Missions | Voyages | Rounds | Pipeline |
| `hollow` | Hollow | Vault | Airlock | Chest | Lockbox | Safe |
| `wind` | Wind | Messages | Comms | Signals | Pages | Inbox |
| `storms` | Storms | Incidents | Mayday | Squalls | Codes | Escalations |
| `forest` | Forest | Structure | Station | Reef | Anatomy | Org Chart |
| `admin` | Roots | Admin | Command | Helm | Admin | Settings |

---

## Personalization Pickers

Three dropdown selectors at the bottom of the sidebar (desktop only, hidden on mobile):

### Vibe (Theme)

- Label: "VIBE" (uppercase, tracked)
- Dropdown with all 6 themes
- Changes all navigation labels and icons immediately
- Persisted to localStorage via `useTheme()` composable

### Style (Archetype)

- Label: "STYLE" (uppercase, tracked)
- Dropdown with available archetypes
- Controls visual style / personality archetype
- Loaded from `useArchetype()` composable

### Voice (Flavor)

- Label: "VOICE" (uppercase, tracked)
- Dropdown options change based on selected archetype
- Controls voice / communication flavor
- Sub-options of the current archetype (`currentArchetype.flavors`)

---

## Quick Capture

Between navigation and personalization pickers:

- `<QuickCaptureFab />` component
- Bordered section with top divider
- Provides quick capture functionality (add items to capture pipeline)

---

## Company Switcher

Below Quick Capture (desktop only):

- `<CompanySwitcher />` component
- Bordered section with top divider
- Switch between company contexts
- Companies loaded on mount via `useCompany().loadCompanies()`

---

## Status Footer

Bottom of the sidebar:

| Element | Description |
|---------|-------------|
| **Connection dot** | Green (emerald) = Live, Amber (pulsing) = Reconnecting |
| **Status text** | "Live" or "Reconnecting" (desktop only) |
| **Clock** | Current time in CST format: "Thu, Mar 27, 10:30 AM" (desktop only, updates every 60s) |

Connection status sourced from `useRealtimeStatus()` composable (Supabase realtime).

---

## Mobile Layout

On screens narrower than `md` breakpoint:

- Sidebar is **hidden**
- Bottom tab bar appears (fixed, full width)
- Shows all nav items as icon + small label
- No personalization pickers, company switcher, or status footer
- Active route highlighted in white text

---

## Responsive Behavior

| Breakpoint | Sidebar | Label Visibility | Pickers | Mobile Nav |
|------------|---------|-----------------|---------|------------|
| `< md` | Hidden | N/A | Hidden | Bottom tabs |
| `md` | 64px (icons only) | Hidden | Hidden | Hidden |
| `lg+` | 192px (full) | Visible | Visible | Hidden |

---

## Main Content Area

The content area sits to the right of the sidebar:

- Left margin: `ml-16` at `md`, `ml-48` at `lg`
- Max width: `1600px`, centered
- Padding: `p-4`, extra bottom padding on mobile (`pb-20`) for bottom nav clearance
- `<StatusBar />` component pinned at the bottom (ELLIE-1026)

---

## Source Files

| File | Purpose |
|------|---------|
| `app/layouts/default.vue` | Layout template + nav route mapping + active state logic |
| `app/utils/themes.ts` | Theme definitions (6 themes, 28 nav keys each) |
| `app/composables/useTheme.ts` | Theme state management + localStorage persistence |
| `app/composables/useArchetype.ts` | Archetype + flavor selection |
| `app/composables/useCompany.ts` | Company switching |
| `app/composables/useRealtimeStatus.ts` | Supabase realtime connection status |
| `app/composables/useCaptureStatus.ts` | Capture pipeline badge count |
| `app/components/QuickCaptureFab.vue` | Quick capture button |
| `app/components/CompanySwitcher.vue` | Company selector dropdown |
| `app/components/status/StatusBar.vue` | Bottom status bar (ELLIE-1026) |
