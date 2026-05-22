# STATE — agentic_rc_cli

> **Frozen:** 2026-05-22 08:20 (Europe/Berlin)
> **Branch:** develop
> **Last commit:** `fd4d867` · fix(eval): probing must inspect response for @Error
> **Version:** v0.7.0 staged (pivot), pre-commit

## Last work-unit — v0.7.0 pivot

We **deleted the UI-interaction layer entirely**. After comparing v0.6.2
empirically against [Marionette MCP](https://pub.dev/packages/marionette_mcp),
the conclusion was unambiguous: Marionette's architectural choice (run
inside the app via a tiny `MarionetteBinding` extending
`WidgetsFlutterBinding`) gives it real `GestureBinding.handlePointerEvent`,
hit-test filtering, custom-widget config, multi-touch, screenshots — all
things we can never have through eval because of `@visibleForTesting` +
the hub-library re-export problem documented in v0.6.x.

Rather than try to clone Marionette, we **doubled down on what's actually
ours**: non-invasive remote control + structured observability.

**Removed (8 tools + 11 files):**

- `rc_flutter_tap`, `rc_flutter_widget_geometry`, `rc_flutter_wait_for_widget`,
  `rc_flutter_enter_text` (gesture / text-input)
- `rc_flutter_widget_tree`, `rc_flutter_widget_find`,
  `rc_flutter_widget_properties` (inspector)
- `rc_flutter_screenshot` (Marionette has it natively)
- Source: `src/flutter/gesture_dart.ts`, `src/flutter/inspector.ts`, 8
  tool handlers in `src/tools/flutter/*.ts`
- Tests: `test/gesture-dart.test.ts`, `test/inspector.test.ts`
- Demos: `scripts/flutter-tap-demo.mjs`, `scripts/flutter-login-demo.mjs`,
  `scripts/flutter-inspector-demo.mjs`, `scripts/eval-debug.mjs`
- Learnings: `inspector-tree-keys.md`, `screenshot-availability.md`,
  `framework-rebuild-pacing.md`

**Kept (14 tools):**

- PTY layer (8): `rc_start`, `rc_send_keys`, `rc_read_screen`,
  `rc_read_stream`, `rc_wait_for`, `rc_status`, `rc_stop`, `rc_resize`
- Flutter/Dart-VM observability (6): `rc_flutter_endpoints`,
  `rc_flutter_connect`, `rc_flutter_drain_errors`,
  `rc_flutter_drain_logs`, `rc_flutter_hot_reload`, `rc_flutter_eval`
  (read-only)

**Docs rewritten:**

- README: explicit "we are not an agentic UI testing framework, use
  Marionette for that, here is the boundary" framing up top
- SKILL.md (project-local + global): "When to use this skill vs
  Marionette MCP" section right after the intro; the canonical loop is
  now the **observability** loop (rebuild → drain errors → fix), not a
  UI interaction loop
- CLAUDE.md: pruned learnings trigger map; added "what this repo is NOT"
  section to prevent future drift back into UI testing
- vm-service-eval-quirks.md + eval-diagnostic-discipline.md: kept and
  re-pointed at `rc_flutter_eval` as the surviving eval-driven tool

**Gates:** typecheck ✅, 25/25 unit tests ✅, smoke (14 tools, generic
PTY happy path) ✅. SERVER_VERSION 0.6.1 → 0.7.0.

## Next intended step

The pivot is done — the next moves are **stabilisation + user-facing**:

1. **Push v0.7.0 + tag the cut.** Anything that uses the removed tools
   externally will break loudly with `Unknown tool`. That's by design.
2. **Re-run user's Flutter Web test session** with Marionette + this
   tool together (the hybrid pattern documented in the new SKILL.md).
   Validate that the boundary feels right in real use.
3. **Optionally:** publish to npm under `@moinsen/agentic-rc-mcp` so
   `npx` install works without the repo clone. ~15 min.
4. **Optionally:** small CHANGELOG.md summarising v0.5 → v0.6 → v0.7
   evolution including the pivot rationale. ~20 min.

## Open friction

- `rc_flutter_eval` is still subject to all 5 eval-scope constraints in
  `vm-service-eval-quirks.md`. The library-probe handles the worst case
  (Flutter Web `web_entrypoint.dart`) by falling back to material; for
  user-app symbols that only resolve in `main.dart` scope, eval may fail
  with `@Error`. That's acceptable: `rc_flutter_eval` is documented as
  read-only inspection, not UI driving.
- Sessions are tied to the MCP-server process. Killing Claude Code kills
  all sessions (clean, no zombies).
- No CHANGELOG yet; git log + this file is the only summary.

## Live context for the agent

- **Active spec areas:** none — v0.7.0 is steady-state. Any new tool
  added here MUST be evaluated against "does Marionette already do
  this?" before starting. If yes, redirect users; don't add it.
- **Empirical Dart-eval constraints** captured in
  [`docs/learnings/vm-service-eval-quirks.md`](docs/learnings/vm-service-eval-quirks.md).
  Apply when extending `rc_flutter_eval` or when an agent's eval call
  fails.
- **Forensic learnings retained:** `vm-service-eval-quirks.md`,
  `flutter-hot-reload-pipeline.md`, `flutter-endpoint-sniffing.md`,
  `eval-diagnostic-discipline.md`. The three removed (inspector-tree-keys,
  screenshot-availability, framework-rebuild-pacing) were tool-specific
  and went with their tools.
- **Demo discipline:** the three remaining live demos
  (`flutter-drive.mjs`, `flutter-error-detect.mjs`,
  `flutter-vm-agentic-loop.mjs`) cover the kept tool surface. Run them
  if you touch anything Flutter-side. `npm run smoke` covers PTY.

## How to resume

1. Read this file.
2. `git log -5 --oneline` and `git status -s` — drift check since
   2026-05-22 08:20.
3. **If the user asks about UI interaction / tap / scroll / text input
   on Flutter**: point them at Marionette MCP. Don't add the tools back
   here. Reference SKILL.md "When to use Marionette MCP instead".
4. **If the user asks for a new generic remote-control feature** (new
   PTY capability, new VM-service-stream subscription, new structured
   observability surface): that's in scope. Build it.
5. Recent calibration: v0.7.0 pivot — code deletion + doc rewrite +
   verification — came in ~45 min wall-time. The empirical agent
   velocity for a focused refactor with clear scope continues to be
   under 1 hour.
