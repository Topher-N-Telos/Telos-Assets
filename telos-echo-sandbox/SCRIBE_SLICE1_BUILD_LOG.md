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
