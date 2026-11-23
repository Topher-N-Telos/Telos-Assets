# App v130 — Scribe skill, slice 1 (text only)

Branch: `scribe-slice-1`. Implements Master 19C as written in v207/v208, first slice.

## What is in
- `ScribeScreen` in `backend/public/telos.html`, built from existing parts (ChamferBox/Btn/Field, MessageBubble, TeloGlyph) and the 8.16A skill-memory framework.
- Skill tile `scribe` flipped to `built: true`; dashboard nav case and screen render added.
- Projects (storage key `telos-v1-scribe`), 16 work types with units of completion per 19C.2D (chapter, scene, page, spread, section; single pieces mark Final).
- Creative = Sandbox: continuity check before Approve (flags, Approve anyway / Keep revising); Archive tab (canon ledger, character notes). Professional: no ledger, no check.
- Write tab: chat with the Scribe Telō (project context + ledger in the system prompt), "Add to chapter" on replies, per-project chat saved.
- Scribe skill memory bins (voice, projects, threads, recent) plus verbatim archive via `smArchiveAppend`.
- Manuscript of Approved units: copy or download .txt.
- Test: headless Chrome, 10-step flow with mocked API (all pass); `node --check` on the bundle passes.

## Not in this slice (deferred, per Master)
Images and the generator screen (19C.2A, needs Worker + 14B.2A screening, still a stub); Present mode and presenter (19C.2C); camera and voice rehearsal; Library (19C.4); Personal Canon promotion; tier project cap (19C.1B); World Roots / RDP / hearts hooks; PDF/Word/PowerPoint export.

## Notes
- Hosted copy cannot chat until a Claude relay exists (same as every other skill).
- App v129 entry is still pending merge into TELOS_App_Build_Log.md.

---

# App v131 — Scribe foundation (Master v209: 19C.2E, 19C.2F, 19C.2G handoff, 19C.6A research window)

## Added
- Versions (19C.2E): editing an approved unit opens a revision; the approved version stays canon (manuscript and co-author context use it) until the revision is approved. Approving a revision shelves the old version in history. Compare (then/now) and restore as a new draft; restoring never overwrites (the working text is kept in history first).
- Recovery (19C.2E): snapshots on approve, on leaving a project, and every 5 minutes (last 20, key `telos-v1-scribe-snap-<projectId>`); restore keeps a "Before restore" snapshot. Pending saves flush on page hide.
- Save conflicts (19C.2E): each project carries `updated`; a write checks storage first, and if another device changed the project, nothing is written and the author chooses Keep this device / Keep other / Keep both (other becomes a copy). The tab also re-reads storage on returning to visible.
- Dated, sourced facts (19C.2F): ledger entries carry `source` and `from` (a unit); continuity check and co-author context see only facts effective at the unit being worked on. Revising an approved unit flags later approved units "needs review" (flag only, cleared by the author).
- Handoff (19C.2G): on leaving a touched project, a note (stop, decisions, open questions, next beat) is generated and shown on return ("Where you left off", Update now). It is a project note, not relationship memory. It is also given to the co-author as context.
- Research window (19C.6A): the Encyclopædia opens as a sheet over Scribe, using the attached Encyclopædia Telō, its own memory bins, rules and archive. "Fact-check selection" sends only the selected passage on tap. Pin to ledger saves a "General knowledge, unverified" reference (never canon). Locked with a pointer when no Encyclopædia Telō is attached.

## Tests
Headless Chrome, mocked API: 12-step foundation flow and the 10-step slice-1 flow both pass; node --check passes.

## Still not built (Master v209, later slices)
Planning (19C.2G outline/arcs/clues/payoffs), branches (19C.2H), import with review (19C.2I), screenplay structure (19C.2J), the other skill bridges (Language Teacher, VA, Wellness, Concierge, Coding Mentor), images, Present mode, camera.

---

# App v132 — Scribe: Master v210 rulings

- Approval (19C.2K): continuity findings now carry a type. A contradiction with a locked fact needs a one-line intentional exception (stored on the unit, last 20 kept) before approval; voice, repetition, atmosphere and unearned-beat findings are advice and can be approved directly. Hard limits are not part of this check and are not exceptions.
- Research window (19C.6A): control renamed "Review for accuracy". A selected passage now asks for confirmation ("This passage will go into your Encyclopædia conversation, and the Encyclopædia keeps a memory...") before it is sent, and the Encyclopædia memory update is told to record subjects and questions only, never the text of the work.
- Not yet built from v210: story-time markers (19C.2F), archive/restore and downgrade read-only handling (19C.1B), Personal Canon / publication rules (19C.3; no canon promotion or Library exists in the app yet).
- Tests: foundation flow now 13 steps (adds exception flow and passage confirmation), slice-1 flow 10 steps; both pass.

---

# App v133 — Scribe: remaining buildable parts of Master v210

- Archive and restore (19C.1B): archived projects leave the list and can be restored. Tier cap and read-only downgrade handling are NOT built: the app has no user subscription tier to read yet.
- Story time (19C.2F): optional numeric story position per unit; "true from" uses it when set, reading order when not (tested: a later fact stays out of an earlier chapter, and reaches it once the chapter is given a later story position).
- Plan tab (19C.2G): outline beats, character arcs, planted clues, planned payoffs, open threads, linked to units; clue/payoff pairing; loose ends listed as advice only; plan is given to the co-author as context.
- Alternate branches (19C.2H): fork a Creative project into a separate copy (stays Sandbox, not a project of its own for caps); "Send to main as draft" moves one unit across as a new draft that must pass the continuity check before approval. Branch ledger changes never merge.
- Screenplay structure (19C.2J): scene heading, action and dialogue blocks; formatted text is generated from them so counts, approval and the manuscript keep working; scenes link to storyboard scenes, and the storyboard shows the reverse link.
- Not built, waiting on other parts: import with review (19C.2I needs the 14B.2A screening module, still a stub), images, Present mode, camera rehearsal, the other skill bridges (later build per v210), Personal Canon / Library rules (no canon promotion in the app yet), exports to PDF/Word/PowerPoint.
- Tests: three headless suites (10, 13 and 9 steps) all pass.

## App v134 - Import with review, Word/print export
Import-with-review and export (see Master 19C.2I). Tested (run_test4).

## App v135 - Present mode, voice rehearsal, Q and A
Slides view, filler-word and pace metrics, audience question. Tested (run_test5). Not built: PowerPoint export, camera/posture analysis.

## App v136 - Skill bridges
Scribe to Language Teacher (professional work only) and Wellness Coach (warm-up request, no text). Items sit in per-skill inbox keys, shown exactly as sent. Wellness tested both sides (run_test6); the Language Teacher receiving card is syntax-checked only.
Not built: VA, Coding Mentor, Concierge bridges (those skills are not in the app).

## App v137 - Scribe image generation (19C.2A)
ILLUSTRATE button per unit opens a generator through the existing Echo image service (/api/echo/options, quote, generate, /api/jobs). Prompt pre-filled from the unit's latest text and character notes, editable, with "suggest another"; characters removable; style defaults to the avatar's; price shown from the server quote; 18+ and approval boxes required; images attach to the unit (max 12) and can be removed. Tested with mocked API (run_test7). Not verified against the live Worker. Uses Echo's world rules (world picked from the Telosian or avatar species) and its existing minor-terms block; no separate Scribe screening exists.

## App v138 - Project types in an even grid
Three-column grid, equal-height buttons, last button in a row group spans the leftover cells; "Toast or ceremonial speech" shown as "Toast or speech".

## App v139 - Start tab and authorship mode (Master 19C.2L, v211)
START tab (first tab, opens by default on an empty project): idea box, starter pack (title, premise, cast, outline), each part editable and accepted or discarded separately; accepted cast goes to the Archive marked "from Scribe", accepted outline items become Draft units (and Plan beats for Creative work), accepted premise is kept on the project and given to the co-author as context. Authorship switch per project: Co-author (default) or Ghostwriter. Ghostwriter adds a brief box and WRITE THIS FOR ME on each unit; the result is shown as Scribe's draft and only enters the unit when the author chooses USE AS DRAFT or ADD AFTER MY TEXT (earlier text is kept in history); units never self-approve. Provenance ("Scribe drafted this on ...") is stored on the unit and shown only to the author. Not built: ghostwriting for screenplay scenes (the scene editor stores blocks); a visible credit never exists by design. Tested: run_test8 (10 steps) plus all earlier suites.
