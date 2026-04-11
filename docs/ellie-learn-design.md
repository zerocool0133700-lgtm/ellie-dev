---
name: Ellie Learn Design Session
description: Product design for student/teacher platform for learning disabilities — ready to start with Excalidraw wireframes
type: project
---

## Ellie Learn — Product Design (Starting Point)

**What:** Educational platform for teachers and students with learning disabilities (dyslexia, ADHD, dyscalculia, processing disorders).

**Core Principle:** No piece of knowledge should require reading to access. Audio-first, visual-first. Text is a fallback.

### Two Products, One Platform
- **Ellie Dev** — Dave's internal AI development environment (built)
- **Ellie Learn** — student + teacher platform (designing now)

### Student Experience Design Priorities
- **Ellie is the companion, NOT the instructor** — she walks with you, encourages you, advocates for you. Always safe, never tests or corrects.
- **Forest creatures are the instructors** — each creature is a different AI tutor for a different subject/style. Owl for reading, fox for maths, etc. Each has its own personality and teaching approach.
- Ellie advocates for the student with creatures ("Can we try that a different way?")
- If one creature's approach isn't working, Ellie walks the student to a different creature
- Voice onboarding (Ellie introduces herself by speaking)
- Audio-first everything (lessons read aloud, responses spoken)
- Visual knowledge (concepts as pictures, diagrams, icons)
- Cognitive load adaptation (detects frustration, simplifies automatically)
- Pace control (student sets pace, never rushed)
- Celebration not correction (progress celebrated, mistakes silently fixed)
- Multi-modal input (speak, draw, tap, type)

### Teacher Experience Design Priorities
- Student dashboard (progress, struggle areas, learning patterns)
- Accommodation profiles (per-student disability settings)
- Lesson builder (auto-adapts to student profiles)
- Alert system (struggling detection before student gives up)
- Visual progress reports (growth over time, not grades)

### Existing Engines That Apply
- Voice pipeline (Twilio/ElevenLabs/Groq) → Ellie speaks all content
- Empathy detector → detect frustration → simplify
- Cognitive load tracking → auto-adjust difficulty
- Relationship intelligence → build rapport over time
- Multi-agent system → different tutors per subject
- Forest knowledge graph → student's personal knowledge tree
- Quality scoring → observation-based assessment

### Design Approach — Persona-Driven
Design each persona's experience as they would interact with the system:

1. **Student** — the learner (likely child/teen with learning disability). Audio-first, visual, zero reading pressure.
2. **Teacher** — manages classrooms, sets accommodations, monitors progress, builds lessons.
3. **Parent** — sees their child's progress, gets updates, communicates with teacher. Needs reassurance, not data overload.
4. **Dave (System Builder)** — admin/ops view. Manages the platform, monitors AI behavior, tunes engines, handles onboarding of schools/teachers.

### Persona Journeys (Completed 2026-03-27)

**Student** — https://excalidraw.com/#json=LsHIRDiCj5BnU7yIZNMrQ,Qhn7dpWX51-Av4hYIzFYSw
- First Time: Ellie speaks → voice chat → profile built (no forms) → guided first lesson
- Daily Loop: greet → lesson (audio+visual) → practice (speak/draw/tap) → celebrate → repeat
- Struggle Detection: frustrated? → simplify+slow → switch mode → alert teacher

**Teacher** — https://excalidraw.com/#json=fC0ax6Q0Jg1V_R2R4Xnto,391iQXlMghfjNBm5At9I9g
- Setup: create class → invite students → accommodation profiles → assign content (or let Ellie choose)
- Daily Dashboard: class overview, alerts, growth map (visual not grades), quick actions
- Intervention: alert → session replay → decide: adjust Ellie or direct support → message parent

**Parent** — https://excalidraw.com/#json=nuAKf-9yUyhNIlE01L-mT,zbUJApDkzCQNQ-yv8UpxIA
- Onboarding: teacher invites (QR/link) → see child profile → choose update frequency → consent/privacy
- Weekly Update (core): child's tree growing, plain language wins, "listen to update" button
- Pictures: gallery of child's visual work (drawings, diagrams). Two-way — parent can share photos back that Ellie weaves into lessons
- Communication: teacher messages + voice reply (full voice in/out). Gentle heads-up when struggling + suggestions for home

**Dave (System Builder)** — https://excalidraw.com/#json=1K0QSRyle8tMa6GjZJKvu,rV_LZ77A4HZeoHkPYGSJbA
- Onboarding: create org → invite teachers → configure engines → map curriculum
- Ops Dashboard: health, AI quality, usage, safety flags, session logs, engine tuning, content pipeline, agent monitor
- Incident Response: safety alert → review session + kill switch + sandbox mode
- Chat: direct conversation with any Ellie instance to diagnose issues
- Sandbox: isolate a suspect Ellie — disconnected from students, still running, observable and testable
- Growth: A/B test lesson approaches → roll out what works

### Key Design Decisions
- Student never types, never fails — system adapts before failure
- Teacher never grades — Ellie observes and reports growth visually
- Parent gets a weekly postcard, not a dashboard — reassurance not data
- Kill switch is non-negotiable for system builder
- The tree is the universal language across all personas
- Audio option on everything — any user might have a reading disability. LD is often hereditary — the parent may have the same disability as the child. Parent experience MUST be voice-drivable end to end, not just "listen to update" buttons.
- Per-school engine tuning — no one-size-fits-all

### Student Onboarding — The Forest Walk (Designed 2026-03-27)
https://excalidraw.com/#json=eh1vYFKO5BMIZpEdtAcz1,GgrXw2mmJJdkfzrSOUB7pg

Three scenes, first-person view, Ellie avatar walks beside the student:
1. **The Path** — Ellie appears, introduces herself, ambient forest sounds. Student just listens.
2. **Getting to Know You** — Walking together, Ellie asks: name, interests, learning style, what feels tricky. Forest responds to answers (dino prints, stars, etc). Builds profile through conversation, not forms.
3. **The Clearing** — Arrive at sunny clearing. One tap plants their tree. Sapling animation with student's name. This is THEIR tree.

Underneath: voice → profile, modality prefs, accommodation profile, tree created in Forest DB.

Tech: 2D illustrated scenes with parallax, ElevenLabs voice, Web Speech API for student, Canvas/Lottie for tree animation.

### The Forest — Full Map (Designed 2026-03-27)
https://excalidraw.com/#json=vkvdItWzpVcYBZbB257qu,0mWFqtnZkUDrCdPUm0LLhA

**Your Tree** at the centre, Ellie always beside you.

**Creature Homes** (structured learning — each = separate AI agent):
- Owl (Reading & Stories), Fox (Maths & Logic), Bear (Science & Nature)
- Turtle (Writing & Words), Robin (Music & Rhythm), Deer (Art & Drawing)

**Forest Places** (play & expression):
- Games Clearing — puzzles, number games, pattern matching (reinforces creature lessons as play)
- Art Studio — free draw, guided drawing, illustrate stories, express learning (saved to portfolio → parent Pictures)
- Music Grove — rhythm games, song creation, phonics through melody, mnemonics
- Story Cave — listen to stories, create your own by voice, illustrated storybooks (saved to portfolio → parent Pictures)

### Launch Strategy
Start small, grow with the forest:
- **MVP creatures**: Owl (reading) + Fox (maths) — core LD needs
- **MVP places**: Games Clearing + Art Studio
- Add creatures and places as product proves itself — each new creature = new AI agent, no architecture rework
- The forest literally grows as the business grows

### Next Step
Build the Forest Walk onboarding experience, then the daily loop with creature + places navigation.

### Ticket
ELLIE-1089 (avatar) is related — visual presence for the student experience.

---

## Part 2 — Going Deeper

Part 1 mapped the forest. Part 2 plants the roots — the daily experience that makes kids come back, the creatures that make learning feel alive, the social layer that makes it fun to share, and the adult view that keeps parents and teachers connected without being intrusive.

---

### The Study Companion — Ellie Learn's v1 Entry Point

The forest map, the creatures, the onboarding walk — those are the world. But the thing that makes Ellie Learn a **daily habit** is the study companion. This is the product surface that lives on a kid's tablet or laptop, the thing they open after school the way they'd open YouTube or Roblox.

#### What the Study Companion Is

A persistent, always-available **learning partner** that sits between the student and whatever they're working on. Not a tutor app you open for "maths time." A companion that's just... there.

- **Homework mode** — student has an assignment. Ellie helps them through it. Not by giving answers — by walking alongside. "Read it to me," "What do you think this is asking?", "Want me to break that into smaller pieces?"
- **Practice mode** — no assignment, just growth. Ellie suggests a visit to a creature based on what needs strengthening. "Owl noticed you've been crushing short stories — want to try a longer one today?" The student can say no. Always.
- **Free explore mode** — student wanders the forest. Visits creatures, plays in the clearing, draws in the studio. No structure, no pressure. Ellie walks with them but doesn't steer.

#### The Daily Loop

This is the rhythm that builds the habit:

1. **Greeting** — Ellie says hi. Remembers yesterday. "You were halfway through that story with Owl — want to finish it, or do something different today?" Warm, specific, never generic.
2. **Check-in** — Quick, conversational. "How's today feeling? Big energy or chill mode?" This sets the session's intensity. No sliders or settings — just a conversation.
3. **Activity** — Whatever mode the student picks (homework, practice, explore). Ellie adapts in real time. Frustrated? Simplify. Flying? Challenge gently. Done? Celebrate.
4. **Wrap-up** — "Nice session! Your tree grew a new branch today." Visual progress. The tree animates. Maybe a new leaf, maybe a flower. Something the student can see and feel.
5. **Tomorrow hook** — "Owl's got a new story ready for you tomorrow — it's got dragons." Gentle pull to come back. Never guilt, never obligation.

#### Why This Is v1

Everything else — the full forest map, all six creatures, the social layer — builds on top of this loop. If the study companion works, the rest follows. If a kid opens this every day and feels good about it, we've won.

The study companion is also where the **accessibility engines prove themselves**. Voice-first interaction. Frustration detection adjusting difficulty in real time. Cognitive load tracking preventing overwhelm. Multi-modal input so the kid can speak, draw, or tap instead of type. Every engine Dave's already built gets its first real workout here.

#### Technical Shape

- Runs as a web app (PWA for tablet install)
- Persistent WebSocket connection to Ellie (same architecture as Ellie Chat)
- Session state tracked in Forest DB — the student's tree, current activity, progress
- Creature interactions are agent dispatches under the hood (Owl = reading agent, Fox = maths agent)
- Ellie is the coordinator agent, same as in Ellie Dev — she routes to creatures and advocates for the student
- ElevenLabs voice for Ellie and all creatures (each creature gets a distinct voice)
- Web Speech API for student voice input
- Canvas/Lottie for tree growth animations and creature interactions

---

### Creature Specialization and Depth

Part 1 introduced the creatures as subject-area tutors. That's the skeleton. Here's the muscle — how each creature actually teaches, what their personality feels like, and why a kid would want to visit them.

#### Design Principle: Creatures Are Characters, Not Interfaces

Every creature has:
- **A personality** — not just a subject. Kids don't say "I want to do maths." They say "I want to see Fox."
- **A teaching philosophy** — each creature approaches learning differently, matching different cognitive styles
- **A home** — a place in the forest that feels like them, with its own atmosphere
- **A voice** — distinct from Ellie's, consistent across sessions
- **A relationship with the student** — they remember, they adapt, they have opinions
- **A relationship with Ellie** — Ellie can advocate ("Fox, can we try that with pictures instead?") and the creature responds naturally

#### The Launch Pair — Owl and Fox

**Owl — Reading & Stories**
- **Personality:** Wise, gentle, unhurried. Speaks in complete thoughts. Pauses to let things land. The kind of teacher who never rushes you through a sentence.
- **Home:** A tall tree with a cosy hollow. Bookshelves carved into the bark. Warm light. Quiet. The kind of place where stories feel safe.
- **Teaching approach:** Story-first. Every reading skill is taught through narrative, not drills. Phonics through character names. Comprehension through "what do you think happens next?" Vocabulary through context, never flash cards.
- **For dyslexic learners:** Owl reads aloud first, always. The student follows along with highlighted text — or doesn't. Words appear one at a time if needed. No full pages of text. Ever. Owl uses rhythm and repetition naturally ("The fox ran fast. The fox ran far. The fox ran free" — pattern recognition builds decoding skills without drilling).
- **Adaptation:** If the student is visual, Owl illustrates as they read. If auditory, Owl performs the story with voices. If the student wants to create, Owl helps them tell their own story first, then teaches through it.

**Fox — Maths & Logic**
- **Personality:** Quick, playful, clever. Loves puzzles and games. Thinks out loud. The kind of friend who makes hard things feel like a fun challenge, not a test.
- **Home:** A den under tree roots. Cluttered with interesting objects — pinecones sorted by size, pebbles arranged in patterns, sticks forming shapes. It looks like a maths classroom designed by a kid who loves treasure.
- **Teaching approach:** Manipulation and play. Numbers are objects you move, not symbols you memorise. Addition is combining piles of acorns. Fractions are splitting a berry pie. Geometry is building with sticks.
- **For dyscalculic learners:** Fox never writes equations first. Everything starts physical (visual objects on screen that the student moves). Number sense before notation. Estimation before precision. "About how many?" before "What's the answer?" Fox uses multiple representations — the same problem shown as objects, as a picture, as a story, as a pattern. The one that clicks is the one they use.
- **Adaptation:** Fox adjusts the game, not the lesson. Struggling with multiplication? It becomes a treasure hunt where you need groups of items. Flying through addition? Fox introduces sneaky subtraction inside the same game. The difficulty curve is invisible.

#### The Next Four — Future Creatures

These aren't built yet, but the design intent matters now because it shapes the agent architecture.

**Bear — Science & Nature**
- Slow, curious, observational. Lives in a cave with collections — rocks, feathers, pressed leaves. Teaches through exploration and "what if?" questions. "What happens if we put this in water?" Science as wonder, not memorisation. For kids who struggle with reading-heavy science, Bear makes everything an experiment you can see and hear.

**Turtle — Writing & Words**
- Patient, methodical, encouraging. Lives by a calm pond. Teaches writing through voice-first composition — the student speaks, Turtle helps them shape it. For dyslexic and dysgraphic learners, the pen is the last step, not the first. Turtle helps with structure through conversation: "You want to tell them about your dog? Great — what's the first thing you want them to know?" Speech-to-text with Turtle's gentle editing suggestions.

**Robin — Music & Rhythm**
- Energetic, musical, rhythmic. Lives in a nest high up, surrounded by instruments. Teaches phonics through song, times tables through rhythm, memory through melody. For kids where traditional repetition fails, Robin makes mnemonics musical. Also a regulation tool — music for calming down, music for energising, music for transitions.

**Deer — Art & Drawing**
- Quiet, creative, expressive. Lives in a meadow with wildflowers and art supplies. Teaches through visual expression — draw your understanding, illustrate the concept, design the solution. For kids who think in pictures, Deer lets them answer in pictures. Maths through diagrams. Science through illustration. Comprehension through comics.

#### Creature Interactions

Creatures don't just teach in isolation. They reference each other:

- Fox might say "Owl told me you're reading a story about a pirate ship — want to figure out how many gold coins would fit in the treasure chest?"
- Owl might say "Fox mentioned you're great with patterns — I've got a story where the pattern matters"
- Ellie orchestrates these connections. Under the hood, this is cross-agent context sharing through the Forest knowledge graph. Each creature writes observations about the student to the student's tree. Other creatures read that tree.

This means a student's progress in reading **informs** how maths is taught, and vice versa. The whole forest knows the student, not just individual creatures.

#### Adding New Creatures

The architecture is designed for this. Each creature is:
- A new agent in the multi-agent system (same as adding a new agent in Ellie Dev)
- A new entry in the Forest DB (species, personality, teaching parameters)
- A new home on the forest map (visual asset + navigation point)
- A new voice profile in ElevenLabs

No platform rework. The forest literally grows.

---

### The Social Layer — Learning Together

Kids don't learn in isolation. They show off, they compete, they collaborate, they copy each other (and learn by doing it). The social layer makes the forest feel alive with other kids — without any of the toxicity of social media.

#### Design Principle: Safe Social, Not Social Media

This is not a feed. Not a timeline. Not likes and followers. It's:
- **Showing, not performing** — "Look what I made" not "Rate my thing"
- **Collaborative, not competitive** — building together, not ranking against each other
- **Opt-in everything** — nothing is shared unless the student chooses to share it
- **Teacher-visible** — the teacher sees all social interactions in their class (safety net, not surveillance)
- **No DMs between students** — all sharing is in shared spaces, never private channels

#### Forest Sharing — The Portfolio Wall

Every creature interaction can produce something shareable:
- A story written with Owl
- A puzzle solved with Fox
- A drawing from the Art Studio
- A song created in the Music Grove
- A science observation from Bear's cave

The student can pin any of these to their **Portfolio Wall** — a visual space attached to their tree. Other students in their class can visit each other's trees and see what's pinned.

No comments section. No likes. Just visiting. If a kid sees something cool on someone's wall, they can:
- **"Try it too"** — Ellie takes them to the same activity so they can make their own version
- **"Tell them it's cool"** — a pre-set reaction (a leaf, a star, a acorn) placed on the wall. No free-text reactions. Positive only.

#### Group Activities — The Clearing

The Games Clearing from Part 1 becomes the social hub. Activities that work with multiple students:

- **Story relay** — one kid starts a story with Owl, another continues it. Each adds a chapter. Owl helps each student at their level while the story stays coherent.
- **Puzzle races** — Fox sets a puzzle. Multiple kids solve it simultaneously. Not fastest-wins — everyone who solves it gets celebrated. But they can see each other's progress ("3 of 5 friends have solved it!").
- **Group art** — a shared canvas in the Art Studio. Each kid draws in their section. Deer helps them connect the pieces into something whole.
- **Forest building** — collaborative decoration of a shared grove. Kids contribute objects, colours, creatures. The grove evolves as the class learns.

#### Class Forest

Each class has a **Class Forest** — a shared space that grows as the whole class progresses. Individual trees are arranged in a grove. The canopy fills in as more students hit milestones. Seasons change based on collective progress.

This gives the teacher a visual they can project in the classroom. "Look — our forest has grown three new branches this week." The kids see their individual contribution to something bigger.

#### Sharing With Parents

When a student creates something — a story, a drawing, a song — they can choose to **send it home**. This puts it in the parent's weekly update alongside the growth report. "Maya wrote a story about a dragon this week. Listen to it." The parent hears their kid's voice telling the story, with Owl's gentle narration woven in.

This is the bridge between the learning world and the home world. The parent doesn't see grades or scores. They see what their child made. That's the update that matters.

#### Safety Architecture

- All social features are scoped to a class. No cross-school interaction.
- Teachers can disable any social feature per-student (accommodation profiles).
- No user-generated text visible to other students — reactions are pre-set, stories are authored through creature guidance, art is visual.
- Teacher dashboard shows all social interactions. Flagging system for anything unusual.
- Parental consent required for all social features during onboarding.

---

### The Teacher & Parent Dashboard — The Adult View

Adults need to see what's happening without being inside the forest. The dashboard is their window — reassuring, insightful, never overwhelming.

#### Design Principle: Insight, Not Data

Teachers and parents don't need raw metrics. They need answers to simple questions:
- **Teacher:** "Who needs help? Who's growing? What should I adjust?"
- **Parent:** "Is my child okay? Are they learning? What can I do at home?"

Every element on the dashboard answers one of these questions. If it doesn't, it's not on the dashboard.

#### Teacher Dashboard

**The Canopy View** — the default screen. A visual overview of the whole class.

- **The Class Forest** — the same grove the students see, but with teacher annotations. Each tree shows a health indicator (thriving, steady, needs attention). Tap a tree to see that student's details.
- **Alert Strip** — across the top. Students who triggered struggle detection today. Sorted by urgency. Each alert is one sentence: "Alex got frustrated during Fox's fraction lesson — simplified twice, still struggling." One tap to see the session replay.
- **Growth Map** — not grades, not scores. A visual map of each student's branches. "Reading comprehension: growing. Number sense: strong root, branching. Writing: new sprout." Teachers see trajectory, not position. A kid at level 2 who's growing fast looks different from a kid at level 4 who's plateaued.
- **Quick Actions** — the things teachers do most: adjust a student's accommodation profile, assign a specific creature activity, message a parent, review a flagged session.

**Session Replay**

When a teacher taps an alert or wants to understand a student's experience, they can replay the session. Not a recording — a reconstruction:

- What the creature presented
- How the student responded (voice transcription, drawings, taps)
- Where Ellie intervened ("Ellie noticed frustration, simplified the task")
- Where the student succeeded and where they struggled
- Audio playback of key moments (hear the student's voice, hear the creature's response)

This is how teachers understand what's happening inside the forest without being there. It's also how they learn to trust the system — they can see exactly what the AI did and why.

**Accommodation Profiles**

Each student has an accommodation profile that the teacher manages:

- **Learning preferences** — audio-first, visual-first, kinesthetic, mixed
- **Pace settings** — default pace, frustration threshold, challenge threshold
- **Modality preferences** — voice input preferred, drawing preferred, tapping preferred
- **Disability-specific settings** — dyslexia (text size, font, highlighting, audio-always), dyscalculia (visual objects, no notation-first), ADHD (shorter activities, more breaks, movement prompts), processing disorders (extra wait time, simpler instructions, one thing at a time)
- **Social settings** — sharing enabled/disabled, group activities enabled/disabled
- **Creature preferences** — which creatures the student responds to best (auto-detected, teacher-overridable)

These profiles feed directly into every creature's behaviour. When Owl teaches a dyslexic student, it's not the same Owl that teaches a neurotypical student. The personality is the same — the approach adapts.

**Class Analytics**

Broader patterns the teacher can spot:

- "Most of the class struggled with fractions this week" — Fox's approach might need adjusting, or the teacher might want to do a group lesson
- "Three students are excelling at reading — they might be ready for longer texts"
- "Monday sessions are shorter and more frustrated than Thursday sessions" — useful for scheduling

These insights surface automatically. The teacher doesn't query them — Ellie notices patterns and presents them. "I noticed something about your class this week..." in Ellie's voice, on the dashboard.

#### Parent Dashboard

**Design: A Weekly Postcard, Not a Dashboard**

Most parents don't need (or want) a daily dashboard. They need a weekly update that feels like a letter from their child's teacher, not a report card.

**The Weekly Update**

Arrives once a week (day configurable). Contains:

1. **The Tree** — an animation of their child's tree growing over the past week. New branches, new leaves, maybe a flower. Visual progress they can feel.
2. **The Story** — a plain-language summary of the week. "This week, Maya spent most of her time with Owl working on longer stories. She got frustrated on Tuesday but pushed through — by Thursday she was reading passages that would have been too hard last month." Written by Ellie, in Ellie's voice.
3. **Listen** — the entire update available as audio. Tap and Ellie reads it to you. Essential for parents who share their child's learning disability.
4. **The Gallery** — things the child made this week: stories, drawings, songs. Tap to see/hear each one.
5. **Home Connection** — one simple, specific suggestion for something the parent can do at home. "Maya loved the dragon story this week. If you see any dragon books at the library, she'd probably love one." Not homework. Not instruction. Just a bridge.

**On-Demand View**

For parents who want more detail, they can open a fuller view:

- The child's full tree with branches labelled
- Creature visit history ("Visited Owl 4 times, Fox 3 times this week")
- Accommodation profile (read-only — teacher manages it)
- Message the teacher (voice or text)

But the weekly postcard is the primary experience. If a parent never opens the app between postcards, they still know their kid is okay.

**The Parent-Teacher Channel**

Communication between parent and teacher flows through Ellie:

- Parent can message the teacher (voice or text). Ellie transcribes voice messages.
- Teacher can message the parent. Ellie formats it accessibly (audio option always present).
- If a struggle alert fires and the teacher decides the parent should know, the teacher sends a gentle heads-up: "Maya had a tough day with reading today. She's okay — we adjusted her pace. You might notice she's a bit tired. Extra encouragement tonight would go a long way."
- No raw data, no scores, no comparison to other students. Ever.

#### The Feedback Loop

The dashboard isn't just a view — it's a loop:

1. **Student learns** → creatures observe → observations write to student's tree
2. **Tree data surfaces** → teacher dashboard shows patterns, alerts, growth
3. **Teacher adjusts** → accommodation profile changes → creatures adapt immediately
4. **Parent sees** → weekly postcard shows growth → parent reinforces at home
5. **Home context flows back** → parent shares photos, mentions interests → Ellie weaves into lessons
6. **Cycle repeats** → each week, the system knows the student better

This is the flywheel. The more the student uses the forest, the better the creatures teach. The better the creatures teach, the more the teacher trusts the system. The more the teacher trusts, the richer the accommodation profiles. The richer the profiles, the better the student's experience. Round and round. The forest gets smarter.

---

### What Part 2 Establishes

- **The study companion is v1.** Daily loop, three modes, habit-forming. Everything else grows from this.
- **Creatures are characters.** Kids visit Fox because they like Fox, not because they need maths. Personality drives engagement. Teaching adapts underneath.
- **Social is safe and joyful.** Sharing without toxicity. Collaboration without competition. Portfolios, group activities, class forests. All opt-in, all teacher-visible.
- **Adults see insight, not data.** Teachers get a canopy view with actionable alerts. Parents get a weekly postcard with their child's voice in it. The feedback loop connects everyone without overwhelming anyone.

### Next Steps

- Wireframe the study companion daily loop (greeting → check-in → activity → wrap-up → tomorrow hook)
- Design creature home screens for Owl and Fox (the visual spaces students visit)
- Prototype the Portfolio Wall and Class Forest social views
- Wireframe the teacher Canopy View dashboard
- Design the parent Weekly Postcard format and audio flow
