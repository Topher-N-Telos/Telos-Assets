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
