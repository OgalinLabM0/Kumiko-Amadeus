# Memory System Productization Plan

## Purpose

This document is the single handover source for turning Kumiko-Amadeus's current "many-memory-features" state into a stable, product-grade long-term memory system.

The goal is not to keep adding more recall tricks. The goal is to rebuild memory into a reliable product chain that:

- gets exact things exact
- gets fuzzy things fuzzy but natural
- carries follow-up questions correctly
- admits uncertainty when evidence is missing
- stops mixing speakers, timestamps, and topics

This file is meant to be the development anchor for the next phase of work so progress does not depend on long chat history.

---

## Product Goal

The mature version is not "omniscient memory."

The mature version is:

- exact where exactness is required
- approximate where approximation is natural
- evidence-driven
- robust across follow-up questions
- stable under large histories
- debuggable from logs

Success means the system can handle queries like:

- `3月17号23:46我说了什么`
- `最开始的第一句是什么`
- `昨天晚上我们聊了什么`
- `那次邮寄甜点的事还记得吗`
- `可能是美国时间的`
- `前后5分钟吧`
- `那大致的话题呢`

without speaker confusion, false substitution, or random fallback.

---

## Current Diagnosis

The current system already has useful pieces, but they are not yet assembled into a product-grade chain.

### What already exists

- recent-context reply path
- exact history lookup path
- temporal history lookup path
- local RAG semantic recall path
- notebook / anchors / summary buffer
- local SQLite vector storage
- local embedding pipeline
- virtualized main chat rendering

### What still makes it feel unfinished

- query routing is still partly heuristic and brittle
- follow-up questions do not inherit query intent reliably
- exact lookup, temporal lookup, and fuzzy semantic recall are not yet fully isolated
- some storage units are not good "memory evidence units"
- there is no single raw-history truth source yet
- logs exist, but the system is still too easy to misroute without obvious user-facing correction
- there is no stable evaluation suite, so regressions are easy

### Core product truth

The current problem is not simply "RAG is weak."

The real problem is:

- memory evidence exists
- but the system is still not consistently choosing the correct memory lane
- and it is not always using the retrieved evidence in a strict enough way

---

## Final Architecture

The mature memory system should be split into five layers.

## 1. Raw History

This is the single source of truth for original messages.

Use cases:

- `3月17号23:46我说了什么`
- `最开始的第一句`
- `昨天你几点说刚到家`

Rules:

- never answered by fuzzy recall
- always speaker-faithful
- always timestamp-faithful
- all exact lookup evidence must come from here

## 2. Temporal Episodes

This layer stores naturally segmented time-window conversation episodes.

Use cases:

- `昨天晚上我们聊了什么`
- `3月17号中午大概的话题`
- `那天凌晨那段在说什么`

Rules:

- optimized for time-range retrieval
- structured around natural sections, not arbitrary turn counts
- can summarize a window without losing speaker order

## 3. Semantic Recall

This is the actual RAG layer for theme-based recall.

Use cases:

- `邮寄甜点那次`
- `秀一吹长号那次`
- `说我拖延睡觉那次`

Rules:

- used only when the user does not provide stable time anchors
- optimized for topic recall, not exact quoting

## 4. Relationship Memory

This stores stable long-range facts and relationship state.

Includes:

- preferences
- dislikes
- promises
- repeated patterns
- emotional facts
- relationship temperature
- durable personal facts

Rules:

- not treated as raw dialogue
- not used as verbatim evidence
- influences tone, continuity, and behavior

## 5. Query Router

This is the most important product layer.

Its job is to decide which lane the question belongs to:

- exact lookup
- temporal lookup
- semantic recall
- recent context only

This is the boundary between "feature pile" and "finished product."

---

## Non-Negotiable Product Rules

These rules should stay true in all phases.

1. Exact queries must never be answered by fuzzy recall.
2. If evidence is missing, the system must say so clearly.
3. `User:` and `Kumiko:` must never be swapped.
4. Follow-up questions must inherit the previous query session unless topic shift is clear.
5. Low-confidence memory must not be presented as certainty.
6. Recent-vector fallback must never override strict historical lookup.
7. Logs and internal prefixes must never leak into visible chat bubbles.
8. Hidden messages are still history unless explicitly deleted.
9. Rebuild of message-linked vectors should keep existing summary chunks unless user explicitly asks for full wipe.

---

## Phase A - Stop The Bleeding

This phase exists to stop the most obvious incorrect behavior.

### A1. Establish one raw-history truth source

Current problem:

- parts of the system still reason from different representations of history
- exact lookup and context expansion need a single authoritative source

Target:

- all original messages live in SQLite `messages`
- exact lookup and raw-context expansion read from there
- any legacy in-memory or key-value history becomes transitional cache only

### Required schema

Create or migrate a `messages` table with at least:

- `id`
- `role`
- `text`
- `timestamp`
- `is_hidden`
- `quote_id`
- `image_id`
- `emotion`
- `created_at`
- `updated_at`

Optional but useful:

- `conversation_segment_id`
- `source_import_batch`
- `deleted_at`
- `edit_version`

### A2. Hard-separate the four query lanes

The router must classify into:

1. `exact_lookup`
2. `temporal_lookup`
3. `semantic_recall`
4. `recent_only`

### Router rules

- explicit timestamp queries go to `exact_lookup`
- "what was the topic around that time" queries go to `temporal_lookup`
- theme-only recall goes to `semantic_recall`
- non-memory conversation stays `recent_only`

### A3. Remove dangerous fallbacks

Must remove or keep disabled:

- recent-vector substitution when strict lookup fails
- fuzzy semantic substitution after a no-match exact query
- role-agnostic recall answering "who said what"

### A4. Add query-session inheritance

Create a short-lived `query session` object.

It should store:

- query type
- start timestamp
- end timestamp
- search role
- original user query
- last matched result count
- last evidence source
- confidence level

This session should be inherited by follow-ups like:

- `再试一次`
- `可能是美国时间的`
- `前后5分钟`
- `那大概呢`
- `那大致的话题呢`

Only clear it when:

- topic shift is explicit
- enough unrelated turns pass
- user asks something unrelated

### A5. Skip retry guard for strict memory turns

Strict memory turns should not trigger stylistic retry behavior.

Reason:

- it adds delay
- it increases the chance of losing evidence fidelity
- it makes memory testing feel unreliable

---

## Phase B - Rebuild Memory Storage Units

This phase changes what kinds of evidence the system stores.

Current problem:

- too many stored items are poor memory units
- some grouped fragments are useful, but not safe for exact speaker questions
- `turn_pair` and `mixed rebuild_fragment` can pollute role-sensitive answers

### New storage unit taxonomy

Use these memory entry types:

## 1. `message`

Single raw utterance, best for exact speaker lookup.

Use when:

- exact quote-like recall
- role-sensitive recall
- precise time recall

## 2. `episode`

Time-window or naturally segmented dialogue chunk.

Use when:

- "what did we talk about around that time"
- time-range summary retrieval

## 3. `semantic_chunk`

Topic-centric semantic chunk.

Use when:

- no stable time anchor
- user remembers theme but not timestamp

## 4. `background`

Low-value but non-deleted memory residue.

Use when:

- minor hints may still help
- but should never dominate a result

### Required ranking rules

- exact speaker queries prefer `message`
- time-window queries prefer `episode`
- theme recall prefers `semantic_chunk`
- `background` is supplement-only

### Required anti-pollution rules

- `turn_pair` must not be primary evidence for `我说了什么 / 你说了什么`
- mixed multi-speaker entries must be marked `mixed`
- grouped fragments must preserve internal speaker order, not only an anchor role

### Memory tier rules

Keep the three-tier idea, but only as ranking support:

- `core`
- `episodic`
- `background`

These tiers should not replace the storage unit taxonomy.

Recommended interpretation:

- `message` can exist in `core` or `background`
- `episode` usually in `episodic`
- `semantic_chunk` often in `core` or `episodic`
- `background` tier is never primary-answer evidence

---

## Phase C - Temporal Parser Productization

Current problem:

- main-model JSON parsing is brittle
- local heuristics are too coarse
- some user phrases produce whole-day windows when they should produce narrow windows

### Final design: dual-engine parser

## Engine 1: deterministic local parser

Handles:

- `3月17号`
- `昨天`
- `前天`
- `今天`
- `12点左右`
- `11点50也算`
- `美国时间`
- `我说 / 你说 / 我们聊`
- `前后5分钟`

## Engine 2: main-model parser fallback

Only for:

- vague natural language that local parser cannot reliably normalize

### Unified output format

Both engines must produce:

- `isTemporalQuery`
- `startTimestampJST`
- `endTimestampJST`
- `searchRole`
- `precision`
  - `exact_minute`
  - `approximate_minutes`
  - `hour_window`
  - `day_window`
- `source`
  - `local_heuristic`
  - `main_model`

### Critical rule

If the user gives:

- a date
- a time
- an approximate modifier

the parser must not silently collapse into whole-day range unless the time expression is truly absent.

### Examples of intended behavior

- `3月17号12点`
  - narrow exact hour window
- `3月17号大约12点`
  - plus/minus 5 to 15 minutes
- `美国时间3月17号中午`
  - user timezone noon mapped to JST
- `昨天晚上`
  - evening period window
- `3月17号前后5分钟`
  - narrow center window based on prior query session

### JSON robustness requirements

The main-model parser must:

- strip code fences
- repair trailing commas
- extract JSON object from text
- reject partial garbage
- log parser source and normalization result

If model parsing fails:

- do not collapse into generic chat
- return structured parser failure
- then try local/session fallback before giving up

---

## Phase D - Answer Composition Must Be Evidence-Driven

Current problem:

- even when evidence exists, the final answer layer can still over-generalize or drift
- confidence is not made explicit enough

### Final answer composer behavior

The composer receives:

- route type
- evidence list
- evidence strength
- speaker certainty
- time certainty

Then selects response strategy.

### Evidence strength levels

## Strong

- exact raw messages
- precise role match
- narrow time range

Output style:

- direct answer
- quote-like paraphrase allowed
- strong confidence tone

## Medium

- temporal episode summary
- topic-consistent semantic chunk

Output style:

- soft certainty
- "好像是..."
- "我记得大概是..."

## Weak

- background-only or broad thematic hint

Output style:

- explicit uncertainty
- no direct quote claims

## None

Output style:

- clear admission of missing evidence
- no substitution

### Prohibited answer behavior

- inventing exact lines from weak evidence
- swapping speaker roles
- using broad theme recall to answer timestamp-specific questions
- leaking internal prefixes like:
  - `> [回复 用户]`
  - log markers
  - system protocol labels

---

## Phase E - Summary System Repositioning

Chosen direction:

- `coreMemory` is a recent summary buffer
- not a permanent total-memory canon

### Keep

- notebook
- anchors
- relationship facts
- episodes

### Do not pretend

- `coreMemory` should not behave like a timeless source of truth

### Summary timestamp rule

Every summary block must represent:

- `segment_start_time -> summary_completed_time`

not:

- a tiny last-message slice
- a misleading several-seconds-only interval

### Suggested metadata

Each summary segment should contain:

- `segment_id`
- `segment_start_time`
- `segment_end_time`
- `summary_completed_time`
- `is_complete`
- `topic_label`
- `summary_text`

---

## Phase F - Performance Productization

The memory system has to feel usable, not just technically correct.

### Required work

- parse large JSON imports in main process or worker
- keep restore pipeline staged and interrupt-friendly
- keep virtualized main chat rendering
- make RAG rebuild run as background task with visible progress stages
- avoid blocking first open

### Rebuild progress should expose stages

Suggested stages:

1. loading source history
2. grouping fragments
3. generating embeddings
4. writing SQLite rows
5. building indexes
6. finalizing statistics

### Required logs

At minimum:

- current stage
- processed count
- total count
- elapsed time
- final statistics

---

## Phase G - Evaluation Suite

This is the most important productization step after routing.

Without a fixed test set, the system will keep oscillating.

### Build an evaluation set with 80 to 120 cases

Categories:

- exact timestamp recall
- exact speaker recall
- session-start recall
- temporal window recall
- semantic topic recall
- follow-up carryover
- relationship fact recall
- graceful "I don't know"

### Recommended metrics

- `Exact@1`
- `Temporal Recall`
- `Role Accuracy`
- `Follow-up Carry`
- `No-Hallucination Rate`
- `Timezone Conversion Accuracy`

### Required regression rule

No memory-routing change should be accepted unless:

- exact and temporal tests do not regress
- role accuracy does not regress
- hallucination rate does not worsen

---

## Detailed Implementation Order

## Phase A - Stabilize routing and truth source

### Step A1

Introduce SQLite `messages` as raw truth source.

Files likely involved:

- `components/App.tsx`
- `services/db.ts`
- `electron-main.cjs`
- `electron-rag.cjs`
- `services/localRagService.ts`
- `types.ts`

Acceptance:

- exact lookup only reads original messages
- manual insert/delete/edit updates message truth source
- context expansion uses message truth source

### Step A2

Hard-separate exact / temporal / semantic / recent routes.

Files:

- `components/App.tsx`
- `services/geminiService.ts`

Acceptance:

- strict history failure never drops into fuzzy substitution
- route logs clearly indicate selected lane

### Step A3

Add stable `query session` carryover.

Files:

- `components/App.tsx`
- possibly `types.ts`

Suggested `QuerySession` fields:

- `type`
- `sourceQuery`
- `startTimestampJST`
- `endTimestampJST`
- `searchRole`
- `createdAt`
- `lastUsedAt`
- `confidence`
- `resultCount`

Acceptance:

- follow-up queries inherit the prior memory query session
- explicit topic shift clears the session

## Phase B - Rebuild memory storage units

### Step B1

Define entry kinds and persist them.

Suggested enum:

- `message`
- `episode`
- `semantic_chunk`
- `background`
- `mixed`

Files:

- `electron-rag.cjs`
- `services/ragMemoryFilter.ts`
- `types.ts`

Acceptance:

- role-sensitive lookup no longer relies on `turn_pair`
- mixed fragments are labeled clearly

### Step B2

Add episode builder.

Input:

- raw messages
- natural boundaries
- temporal windows

Output:

- episode rows for time-window retrieval

Acceptance:

- a day/time query can answer from episode evidence even when semantic RAG is skipped

## Phase C - Temporal parser productization

### Step C1

Expand deterministic parser coverage.

Must support:

- explicit user timezone references
- approximate minute windows
- relative follow-up refinements

Files:

- `services/geminiService.ts`

Acceptance:

- `3月17号大约12点`
  does not expand to whole day
- `美国时间`
  correctly remaps to JST

### Step C2

Normalize parser outputs and confidence.

Acceptance:

- both parsers produce same output shape
- logs show parser source and precision class

## Phase D - Answer composer

### Step D1

Add evidence-strength-based response policy.

Files:

- `services/geminiService.ts`

Acceptance:

- exact evidence leads to exact-style answer
- weak evidence leads to uncertainty phrasing
- no evidence leads to explicit admission

## Phase E - Performance

### Step E1

Move large import parsing fully off render-critical path.

Files:

- `components/App.tsx`
- `electron-main.cjs`
- maybe worker/helper module

### Step E2

Keep RAG rebuild taskified and measurable.

Acceptance:

- rebuild no longer feels frozen
- import no longer blocks chat UI for long stretches

## Phase F - Evaluation

### Step F1

Create fixed evaluation data.

Suggested file:

- `docs/memory-eval-cases.json`

### Step F2

Create local evaluation runner.

Suggested file:

- `scripts/run-memory-eval.ts`

Acceptance:

- repeatable scoring after each memory change

---

## Logging Standard For Debugging

Every memory-relevant turn should log:

- `MEMORY ROUTE`
- `querySessionUsed`
- `querySessionAugmented`
- `parserSource`
- `parserPrecision`
- `lookupMode`
- `lookupRangeJst`
- `lookupSpeaker`
- `lookupMatches`
- `ragBlocks`

Recommended extra log line:

- `[MEMORY EVIDENCE STRENGTH] strong|medium|weak|none`

This will reduce future "it feels wrong but why?" loops.

---

## What Must Not Be Changed Carelessly

- hidden messages are not deletion
- rebuild of message vectors should not wipe summary chunks unless explicitly requested
- fuzzy recall must not be allowed to replace exact recall
- output cleanup must continue stripping internal protocol leaks
- recent summary buffer must remain secondary to exact evidence

---

## Implementation Status Summary (2026-03-25)

This section records what has actually been implemented so progress no longer depends on chat history.

### Overall status

- `Phase A`: completed
- `Phase B`: completed in product terms
- `Phase C`: completed in product terms
- `Phase D`: completed in product terms
- `Phase E`: substantially completed
- `Phase F` (Evaluation): intentionally skipped by product decision; real usage is the validation method for now

In other words:

- the memory-system mainline is now implemented
- remaining work is optional polish, performance tuning, or future naturalness refinement

### What was concretely implemented

#### 1. Raw history became the effective truth source

Implemented:

- original messages are persisted in renderer-side raw history storage and, on desktop, mirrored into Electron main-process SQLite `messages`
- raw-history loading now merges the desktop SQLite mirror, renderer Dexie `messages`, and live state so strict recall is less likely to miss a just-sent or just-restored message because one store lagged behind
- exact lookup and raw-support retrieval were redirected toward original message evidence instead of vector rows
- desktop raw-context expansion now tries the SQLite `messages` mirror before falling back to vector-row neighborhood expansion
- renderer Dexie `messages` still exists as a compatibility copy while desktop truth-source convergence continues

Practical result:

- exact timestamp questions are no longer supposed to depend on fuzzy RAG
- role-sensitive questions are much harder to answer from mixed or synthetic recall units
- desktop exact lookup and context expansion are less likely to desync from the current visible chat state

#### 2. Query routing was split into real lanes

Implemented lanes:

- `exact_lookup`
- `temporal_lookup`
- `semantic_recall`
- `recent_only`

Also implemented:

- short-lived `query session` carryover for follow-up historical questions
- `query session` is now persisted locally and restored after app restart while it is still inside the active idle window
- safeguards so unstable temporal parsing does not blindly propagate to later follow-ups
- removal of dangerous recent-vector substitution for strict history turns
- manual history mutation / restore clears the carried session so stale context is not reused

Practical result:

- follow-up questions like `美国时间的`, `前后5分钟`, `那大致的话题呢` now have a real route/session mechanism instead of only free-form heuristics
- short restart gaps are less likely to drop the user's historical query context mid-debugging or mid-recall refinement

#### 3. Temporal episodes were added as a first-class evidence layer

Implemented:

- SQLite `episodes` storage
- episode builder and sync pipeline
- temporal queries can use:
  - raw messages
  - episodes
  - no-evidence path

Practical result:

- time-window questions can answer from section-level evidence instead of only from per-message logs or fuzzy semantic recall

#### 4. Semantic recall was restructured around memory evidence units

Implemented taxonomy:

- `message`
- `episode`
- `semantic_chunk`
- `background`
- `mixed`

Also implemented:

- role-sensitive filtering to suppress `turn_pair`/mixed evidence in `who said what` style queries
- evidence grouping and strength ordering for semantic recall

Practical result:

- semantic recall is now more clearly topic recall
- exact questions are less likely to be hijacked by theme-only matches

#### 5. Temporal parser was productized

Implemented normalized parser contract:

- `source`
- `precision`
- `confidence`
- `status`

Implemented behaviors:

- deterministic/local heuristic parser
- main-model parser fallback
- normalized diagnostics flow
- parser status and confidence now influence:
  - query session reuse
  - evidence mode selection
  - no-evidence policy

Practical result:

- temporal parsing is no longer just "best effort JSON"
- the system can distinguish:
  - parse success
  - parse fallback
  - parse instability
  - true no-match in the selected time window

#### 6. Answer composition became evidence-driven

Implemented shared evidence formatting:

- `[MEMORY_EVIDENCE_ENVELOPE]`
- `[MEMORY_RESPONSE_PLAN]`

Implemented answer-side fields and policies:

- evidence strength
- speaker certainty
- time certainty
- quote policy
- route boundary
- substitution blocking
- conflict flags
- response strategy

Important implementation decision:

- high-risk answer boundaries are enforced mostly through structured plan + local composer
- not by endlessly increasing prompt verbosity

Important UI/naturalness rule now enforced:

- local fixed fallback bubbles must not appear in visible chat
- if a guardrail fallback would have triggered, it is logged only
- the model is encouraged to express uncertainty naturally in-character

Practical result:

- exact / temporal / semantic routes now have clearer answer boundaries
- no-evidence answers are more likely to be honest without sounding like protocol output

#### 7. Summary system was repositioned as a recent buffer

Implemented:

- `coreMemory` is now treated as a rolling recent-summary buffer
- summary segment metadata exists internally:
  - `segment_id`
  - `segment_start_time`
  - `segment_end_time`
  - `summary_completed_time`
  - `is_complete`
  - `topic_label`
  - `summary_text`
- `recentSummarySegments` are persisted
- `coreMemory` is rebuilt from recent summary segments, not only overwritten by the latest summary
- load/restore paths now self-heal the summary buffer from persisted segment metadata

Important UI rule preserved:

- these metadata fields are internal
- user-facing UI still stays simple and does not dump raw metadata fields

Practical result:

- recent summary memory is now closer to a real rolling archive buffer instead of a fragile single string

#### 8. Performance/productization work that was completed

Implemented:

- large backup import parsing for desktop JSON/ZIP moved into the Electron main process
- restore pipeline stays staged instead of doing all parsing on the render-critical path
- main chat rendering is virtualized
- RAG rebuild exposes staged progress and measurable phases
- rebuild progress is shown in the Settings RAG section where rebuild is actually triggered
- chat header RAG icon remains status-only

Practical result:

- large-history import and rebuild are much more usable than before
- rebuild is less likely to feel frozen or invisible

#### 9. Engineering cleanup that was completed

Implemented:

- `package.json` now has `description` and `author`
- `SettingsPanel` no longer dynamically imports `db` while also statically importing it elsewhere
- Vite manual chunking was added so the main bundle is split more sanely

Practical result:

- the earlier build warnings around package metadata, mixed `db` import mode, and oversized monolithic front-end chunk were cleaned up

#### 10. Exact-history hardening after real usage review

Implemented:

- strict speaker-sensitive exact lookup no longer falls back to the other speaker's nearby context when the requested speaker has no hit at that exact minute
- exact no-match states now include explicit outcomes such as `NO_TARGET_SPEAKER_MATCH_AT_SESSION_START` and `NO_TARGET_SPEAKER_MATCH_AT_EXACT_TIME`
- exact timestamp lookup now has a narrow raw-message fallback `Match_Mode: NEARBY_TARGET_SPEAKER_WINDOW` (currently ±90 seconds) for minute-boundary misses
- nearby-window exact matches still stay on raw-message evidence, but answer planning now lowers time certainty so the model says "around then" instead of pretending same-minute certainty when that precision was not actually recovered
- prompt rules now treat any `Result: NO_*` exact-history status as a hard no-evidence state that must not be replaced by fuzzy memory or theme recall

Practical result:

- speaker-sensitive questions like `我当时说了什么 / 你当时说了什么` are less likely to collapse into "I only found my own line" style wrong-speaker answers
- minute-boundary misses are more likely to recover the correct nearby raw utterance without silently crossing into semantic substitution
- real usage edge cases now feed back into exact-history behavior directly instead of only through vague RAG-weight tuning

### What was intentionally not done

- formal evaluation suite / runner

Reason:

- product decision: real usage feedback is preferred for now

This means the roadmap is considered complete without Phase F, unless future maintenance later requires a repeatable automated memory regression harness.

### What still remains, if work continues later

These are no longer "mainline missing architecture" items. They are optional follow-up work:

- further naturalness tuning so Kumiko feels even less AI-like under memory constraints
- more performance polish on first-open / large-restore edge cases
- keep collapsing remaining dual-store desktop raw-history paths until main-process SQLite `messages` can become the sole desktop raw-history source instead of a mirrored convergence layer
- optional future evaluation tooling if real-world regressions become hard to track manually

### Current conclusion

The roadmap is effectively complete for product purposes.

More precisely:

- the long-term memory system has been rebuilt into a routed, evidence-driven product chain
- the remaining work is mostly refinement, plus any future decision to finish collapsing the last dual-store desktop truth-source paths

---

## Definition of Done

The memory system can be considered product-grade when all of the following are true:

1. Exact timestamp questions are answered from raw evidence only.
2. Speaker-sensitive questions do not swap `User` and `Kumiko`.
3. Time-window questions consistently use time-window evidence.
4. Follow-up historical questions inherit previous query context reliably, including after short app restarts while the session is still fresh.
5. Semantic recall no longer hijacks strict history tests.
6. "No evidence" answers are honest and natural.
7. Large-history import and rebuild are smooth enough to feel usable.
8. Evaluation suite stays green across refactors, or evaluation is intentionally replaced by real-world usage review as a product choice.
9. Exact-minute speaker questions either hit exact raw evidence, use a clearly labeled narrow nearby raw-message fallback, or fail honestly without substituting the other speaker.

---

## Immediate Next-Day Starting Point

The earlier "next-day" items around persistent `query session` and desktop SQLite `messages` promotion are now implemented in product terms.

When development resumes later, do not restart by tuning RAG weights again.

Start here:

1. validate real-world exact-history cases such as same-minute dual-speaker turns, minute-boundary misses, and follow-up refinements after restart
2. keep reducing remaining desktop dual-store raw-history paths until main-process SQLite `messages` can be treated as the single desktop raw-history authority
3. if strict-history regressions start recurring, add a minimal fixed regression set for exact speaker/time cases before broader memory tuning
4. only after that, revisit semantic RAG weighting or further naturalness polish

If work starts anywhere else first, there is a high risk of repeating the current cycle:

- more heuristics
- more regressions
- more "it stores a lot but still answers wrong"

---

## One-Sentence Summary

From this point on, memory should no longer be treated as "just another RAG feature"; it must be rebuilt as a full long-term memory product system with strict evidence routing, stable query carryover, and measurable regression control.
