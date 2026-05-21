# STATE — agentic_rc_cli

> **Frozen:** 2026-05-21 16:55 (Europe/Berlin)
> **Branch:** develop
> **Last commit:** `8ea1000` · feat: real-world hardening v0.6.0
> **Dirty:** uncommitted v0.6.1 eval-target-library fix — staging now

## Last work-unit

Shipped **v0.6.1** — the actual fundamental fix for Flutter Web that
v0.6.0's diagnostic surfaced. Flutter Web's `rootLib` is a generated
`web_entrypoint.dart` that doesn't import the framework → eval against
it can't resolve `Element` / `WidgetsBinding` / `*Button`. Every
gesture / inspector tool failed silently on Web (would have, before
v0.6.0 diagnostic; failed loudly with `eval_kind:"@Error",
eval_error:"RPC 113 Expression compilation error"` after).

**Fix:** `FlutterService.evalTargetLibraryId()` probes each candidate
library with the bare identifier `Element`. First one that compiles
wins, cached for the session. Order: `rootLib` → `material.dart` →
`widgets.dart` → `cupertino.dart`. macOS keeps using rootLib (1 probe
call), Web transparently falls back to material.dart (2-4 probe
calls).

Captured the new constraint as Constraint #5 + #4 (Dart 3 records ban)
in `docs/learnings/vm-service-eval-quirks.md`. 64/64 unit tests +
tap-demo + login-demo all green on macOS — no regression. Ready for
re-test against the user's Flutter Web app.

Previous v0.6.0 changes also still in this commit chain:

Shipped **v0.6.0** real-world hardening, based on a Flutter Web session
where four blockers surfaced. Top-4 prio agreed with user, implemented:

1. **Universal eval diagnostic** — new shared `safeEval` helper in
   [`src/tools/flutter/_eval_diagnostic.ts`](src/tools/flutter/_eval_diagnostic.ts).
   Every tool that calls `svc.evaluate(...)` now surfaces
   `eval_ok` / `eval_kind` / `eval_error` / `expression_preview` instead
   of the v0.5 opaque `reason: "empty", raw_eval: null`. Migrated tap,
   widget_geometry, wait_for_widget; enter_text already had its own
   diagnostic. Convention captured in
   [`docs/learnings/eval-diagnostic-discipline.md`](docs/learnings/eval-diagnostic-discipline.md).
2. **Tap walker: self → descendants → ancestors** (default; opt-out
   `descend:false`). Real apps wrap built-ins in custom widgets
   (`TPKButton` → `TextButton`); old walker missed them. Multiple
   descendants → `reason:"ambiguous_descendants"` + structured target
   list so the agent can disambiguate via `by:"key"` instead of
   guessing.
3. **`by: "text"` matcher** on tap/geometry/wait_for_widget. Match a
   `Text` widget whose `data` contains the value (case-insensitive
   substring). Pairs with the descendant-first walker: `by:"text",
   value:"Sign In"` finds the wrapping button via ancestor walk.
4. **widget_tree filtering & flat mode**. Default
   `include_framework:false` — framework subtrees collapse to
   `{_elided:true, framework_node_count:N}` markers (kills the 200 KB
   tree explosion). `source_prefix:"…"` for strict path filter.
   `flat:true` returns a flat list with `path` strings instead of a
   nested tree (~70% token saving combined with source_prefix).

One bug rediscovered: Dart 3 record types `({void Function() cb, …})`
are rejected by the VM-service eval frontend with RPC 113. Workaround:
use `List<dynamic>` 2-tuples for the (cb, name) pairs. Added to the
permanent list in `docs/learnings/vm-service-eval-quirks.md` (next
edit).

22 MCP tools, **64/64 unit tests** (was 57; +7 for by:text / descend /
ambiguous), tap-demo and login-demo both green end-to-end. Skill +
README + CLAUDE.md trigger updated for the new learning.

## Next intended step

Two open paths, user's preference unclear:

1. **Real Flutter Web test session** — the user reported the original
   findings while testing on Flutter Web. v0.6 fixes should make Web
   workable; the diagnostic in particular will reveal any new
   Web-specific issues. If new findings emerge → new learning file
   `docs/learnings/flutter-web-quirks.md` + trigger row in CLAUDE.md.
2. **More gesture coverage** — `rc_flutter_long_press`,
   `rc_flutter_swipe`, `rc_flutter_scroll`, `rc_flutter_dropdown_select`.
   Same pattern as tap. ~30-60 min per primitive incl. live demo.
3. **Inspector key-matching fix** — Push `widget_find by=key` to the
   Dart-eval path by default. Open since v0.5.
4. **`CHANGELOG.md`** — git log has it but no human-readable summary.
   15 min.

User flow last expressed: "lass uns alles umsetzen" → Top-4 done, now
they'll likely want the real-world re-test (path 1).

## Open friction

- `rc_flutter_screenshot` `extension_not_registered` on macOS desktop.
- Login demo patches `flutter_example/lib/main.dart`; SIGKILL skips
  cleanup (very rare; SIGINT/SIGTERM safe).
- `widget_find by=key` still uses the cached inspector path (drops keys
  on Text leaves) — workaround documented in
  [`docs/learnings/inspector-tree-keys.md`](docs/learnings/inspector-tree-keys.md).

## Live context for the agent

- **Active spec areas:** [`src/flutter/gesture_dart.ts`](src/flutter/gesture_dart.ts)
  (Dart expressions; **use `List<dynamic>` for tuples, never records**),
  [`src/tools/flutter/_eval_diagnostic.ts`](src/tools/flutter/_eval_diagnostic.ts)
  (every new eval-driven tool must go through `safeEval`).
- **Empirical Dart-eval constraints** captured in
  [`docs/learnings/vm-service-eval-quirks.md`](docs/learnings/vm-service-eval-quirks.md):
  single-line only, no `@visibleForTesting`, no Dart 3 records.
- **User-code-only widget tree by default** — pass
  `include_framework:true` only when debugging framework wrappers.
- **Demo discipline:** every new tool gets a live-driven script under
  `scripts/`. Live verification is the truth, not the unit tests.
- **User mood:** real-world feedback driven, expects rapid iteration —
  not over-design. Surface gaps with diagnostics; fix in subsequent
  passes.

## How to resume

1. Read this file.
2. `git log -5 --oneline` and `git status -s` — detect any drift since
   2026-05-21 16:05.
3. If clean and the user said "weiter": offer the four Next-intended-step
   paths in 2 sentences each, wait for them to pick. Most likely they
   want path 1 (Flutter Web real-world re-test) since v0.6 was built
   for exactly that.
4. Recent reflexion: v0.6 hardening came in ~50 min (4 features + tests
   + docs + 1 bug fix on Dart records). Naive 60 min was a tight upper
   bound; minute-unit calibration continues to hold.
