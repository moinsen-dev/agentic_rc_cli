# STATE — agentic_rc_cli

> **Frozen:** 2026-05-21 14:45 (Europe/Berlin)
> **Branch:** develop
> **Last commit:** `2b26f16` · feat(flutter): text input — fill TextField via controller mutation (v0.5.0)
> **Dirty:** clean (or trivially — see git status)

## Last work-unit

Shipped **v0.5.0**: agentic text input via `rc_flutter_enter_text` —
walks to the EditableText descendant and mutates its
`TextEditingController`. Verified end-to-end with
[`scripts/flutter-login-demo.mjs`](scripts/flutter-login-demo.mjs) which
fills email + password, taps submit, and asserts the status text
("Welcome, …" → clear pw → "Invalid credentials" → append mode test).
Two non-obvious findings landed as docs/learnings entries during this:
back-to-back eval-driven mutations race the framework's mid-frame
rebuild (200 ms server-side settle in `enter_text.ts`), and the inspector
summary tree drops Key info on Text leaves (use direct Dart eval when
key-matching for reliability).

22 MCP tools total now (8 PTY + 14 Flutter). 57/57 unit tests pass. Six
live-driven demo scripts all green.

## Next intended step

Two open paths — user's preference unclear, both are reasonable:

1. **More gesture coverage** — `rc_flutter_long_press`, `rc_flutter_swipe`,
   `rc_flutter_scroll`, `rc_flutter_dropdown_select`. Same pattern as tap:
   find widget → invoke its handler / dispatch through scroll controller.
   Estimated 30-60 min per primitive incl. live demo. Easiest win-by-win.

2. **Inspector key-matching fix** — Currently `rc_flutter_widget_find
   by=key` is unreliable because the cached inspector summary drops Key
   info. We work around this with direct Dart eval (see
   [`docs/learnings/inspector-tree-keys.md`](docs/learnings/inspector-tree-keys.md)).
   Better: have `widget_find` use the Dart-eval path for `by=key` by
   default, falling back to the cache for other matchers. ~45 min.

3. **Bookkeeping**: write a `CHANGELOG.md` (we have it commit-by-commit
   in `git log` but no human-readable summary). 15 min.

User last leaned: "Lassen Sie uns mal einen Claude.md anlegen mit einer
STATE.md" — so the immediate desire was project-memory hygiene, which is
done. The next functional path is their call.

## Open friction

- `rc_flutter_screenshot` doesn't work on macOS desktop
  (`extension_not_registered`). Documented; not blocking.
- The login demo patches `flutter_example/lib/main.dart` and restores
  it. If a session is killed mid-demo, the user might find
  `main.dart.agentic-bak` lying around — the script is robust against
  SIGINT/SIGTERM but a `kill -9` would skip cleanup.
- `widget_find by=key` cache-path bug → workaround in demo via direct
  eval. See learning file.

## Live context for the agent

- **Active spec areas:** [`src/flutter/gesture_dart.ts`](src/flutter/gesture_dart.ts)
  (single source of truth for all eval-injected Dart expressions),
  [`src/tools/flutter/`](src/tools/flutter/) (MCP tool handlers).
  When adding a new gesture, both directories get a sibling file +
  registration in [`src/index.ts`](src/index.ts).
- **Empirical Dart-eval constraints** captured in
  `docs/learnings/vm-service-eval-quirks.md`. **Always single-line
  expressions** (use `singleLine()` helper). Never reference
  `@visibleForTesting` methods.
- **Demo discipline:** every new tool gets a live-driven script under
  `scripts/`. Live verification is the truth, not the unit tests.
- **User mood:** building fast, pushing through; appreciates that we
  hit each layer (lifecycle → inspector → gestures → text input) with
  a working live demo before moving on. Don't slow down for over-design.

## How to resume

1. Read this file.
2. `git log -5 --oneline` and `git status -s` — detect any drift since
   2026-05-21 14:45.
3. If clean and the user said "weiter": offer the three Next-intended-step
   paths in 2 sentences each, wait for them to pick.
4. If dirty: ask what the dirty changes are (might be human work between
   sessions).
5. Recent reflexion: every phase came in well under naive estimates
   (PTY layer ~30 min, VM service ~30 min, inspector ~25 min, gestures
   ~25 min, text input ~40 min incl. two debug bisects). Stay in
   minute-units, not hour-units, for similar work.
