# Forest Bird Design 🐦

**Designer:** Georgia
**Created:** February 21, 2026
**Purpose:** Define the different types of birds in the Forest system and what each one does

---

## What Are Birds?

Birds are **messengers** in the Forest. When an agent (like James or Ellie) needs information from a different tree, they send a bird to go get it. The bird flies over, finds what they need, and brings it back — all without the agent having to stop their work and wait.

Think of it like sending a text message and getting a notification when someone replies, instead of standing there waiting for the answer.

---

## Bird Types

### 1. [Name TBD]

**What it does:**
(What kind of information does this bird carry?)

**When you send it:**
(When would an agent use this bird?)

**How it moves:**
(Does it fly fast? Slow? In circles?)

**What it looks like:**
(Color, size, any special features?)

**Example:**
(Give a real scenario where this bird would be useful)

---

### 2. [Name TBD]

**What it does:**

**When you send it:**

**How it moves:**

**What it looks like:**

**Example:**

---

### 3. [Name TBD]

**What it does:**

**When you send it:**

**How it moves:**

**What it looks like:**

**Example:**

---

## Bird Behavior

**How do birds know where to go?**
(How do they find the right tree/branch/leaf?)

**What happens if they can't find what they're looking for?**
(Do they come back with an error? Try another tree?)

**Can you send multiple birds at once?**
(Can an agent send 3 birds to 3 different trees at the same time?)

**How do they notify you when they return?**
(Sound? Message? Light up?)

---

## Special Birds

Are there any **rare** or **special** birds that only get used in specific situations?

**Examples:**
- Emergency alert bird (very fast, only for urgent stuff)
- Research bird (goes to the shared knowledge tree and gathers lots of info)
- Coordination bird (sent between agents to sync up on a project)

---

## Notes for Georgia

- You can draw pictures of the birds if you want!
- Think about what makes each bird different — not just what it looks like, but how it acts
- The bird names can be real bird species (like "Swift" or "Raven") or made-up names that match what they do
- Remember: these birds help the agents talk to each other without stopping their work

---

## Implementation Notes (for Dave/Ellie)

Once Georgia designs the birds:
- Map bird types to database schema (creature_type, behavior, speed, etc.)
- Implement dispatch logic (async pattern, notification on return)
- Build visualization in Forest UI
- Integrate with agent-specific trees for real-time coordination

This is the creature system foundation — other creature types (not birds) can follow the same pattern later.
