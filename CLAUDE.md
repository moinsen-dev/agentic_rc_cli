# CLAUDE.md — agentic_rc_cli

Project-local conventions for any Claude session working in this repo.

## What this project is

An MCP server (`agentic-rc-mcp`) that gives a Claude / MCP agent
**non-invasive remote control + structured observability** for
long-running interactive local programs — PTY control + Flutter VM
Service stream subscription. Built so the agent doesn't have to ask
"could you press X for me?" or "could you paste that log block?".

For **agentic UI testing of Flutter apps** (tap, scroll, text input,
widget-tree introspection, gesture injection), use
[**Marionette MCP**](https://pub.dev/packages/marionette_mcp) instead.
It requires a tiny app-side binding but in exchange gives real
`GestureBinding` pointer events, hit-test filtering, custom-widget
configuration. **We deliberately don't ship UI-interaction tools** —
v0.6 had them, v0.7 removed them after evaluating Marionette.
See [STATE.md](STATE.md) for the rationale.

Architecture: `src/` is TypeScript MCP-server code, `flutter_example/`
is a real Flutter app for live verification, `scripts/` holds
end-to-end demo scripts that JSON-RPC-drive a fresh server over stdio.

## Resume protocol

Read [`STATE.md`](STATE.md) before doing anything substantive after a
fresh session start. Then run `git log -5 --oneline` and `git status -s`
to detect drift since the last freeze.

## Learnings — progressive disclosure

Topic-specific findings that bit us once and shouldn't bite us again live in
`docs/learnings/<topic>.md`. Each is short (~50-80 lines), focused, and
loaded **on demand** via the Read tool — never read defensively.

| When you're about to… | Read | Don't read it when… |
|---|---|---|
| build a new Dart expression for `rc_flutter_eval` · debug "Expression compilation error" (RPC 113) · the eval result comes back `{kind: "@Error"}` · investigate why an eval works on macOS but fails on Web | [`docs/learnings/vm-service-eval-quirks.md`](docs/learnings/vm-service-eval-quirks.md) | the work is purely PTY / generic Bash — no Dart eval involved |
| triggering hot reload from code · seeing "Error while starting Kernel isolate task" from `reloadSources` RPC · wondering why `rc_flutter_hot_reload` uses PTY `r` instead of the VM service | [`docs/learnings/flutter-hot-reload-pipeline.md`](docs/learnings/flutter-hot-reload-pipeline.md) | not modifying the reload tool / pipeline |
| adding support for a new device target · `rc_flutter_endpoints` returns `vm_service_ws: null` on a new platform · sniffer regex doesn't match Flutter's output for some device | [`docs/learnings/flutter-endpoint-sniffing.md`](docs/learnings/flutter-endpoint-sniffing.md) | endpoints already detect cleanly on the device you care about |
| adding a new MCP tool that calls `svc.evaluate(…)` · debugging a tool that returns `raw_eval: null` without `eval_kind` · before merging any new eval-driven handler | [`docs/learnings/eval-diagnostic-discipline.md`](docs/learnings/eval-diagnostic-discipline.md) | the work is purely PTY-based with no eval call |

**Self-learning rule:** when a non-obvious workaround / quirk / constraint
surfaces during work in this repo, write a new file under
`docs/learnings/`, add a row to the table above, and commit it with the
code change that revealed it. Same forensic discipline as
`~/.claude/refs/`.

**Removed in v0.7.0** (kept here as historical pointers):
the `inspector-tree-keys.md`, `screenshot-availability.md`, and
`framework-rebuild-pacing.md` learnings covered tools (`rc_flutter_tap`,
`rc_flutter_widget_*`, `rc_flutter_screenshot`, `rc_flutter_enter_text`)
that no longer ship — see git history if you need them.

## Verification gates

Before suggesting a commit:

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest — should be 25 passing post-v0.7 trim
npm run smoke       # 14-tool list + generic PTY happy path
```

End-to-end Flutter demos (each spawns its own fresh MCP server):

```bash
node scripts/flutter-drive.mjs           # PTY: spawn flutter, hot reload, quit
node scripts/flutter-error-detect.mjs    # PTY: scrape Dart exception text
node scripts/flutter-vm-agentic-loop.mjs # VM service: structured error stream + eval + hot reload
```

If you touched anything Flutter-side, **at minimum** run the demo whose
surface area overlaps. If you touched the PTY layer, smoke + flutter-drive
is enough.

## Commits

- Imperative subject: `feat(flutter): …` / `fix(eval): …` / `docs: …`.
- Body: 2-5 line "what & why".
- One commit = one verifiable unit.
- Co-Authored-By: Claude on agent-written commits (default).
- Push to `origin develop` after local verification per
  `~/.claude/refs/moinsen-conventions.md`.

## Versioning

- Bump in `src/index.ts` (`SERVER_VERSION`) for every user-facing change.
- Currently 0.7.0 (post-cleanup pivot).

## Distribution

- `.claude/skills/agentic-rc/SKILL.md` is the canonical skill. It's
  auto-loaded by Claude Code in this repo + installed globally via
  `npm run install:skill`. Keep both copies in sync — the install script
  is one-way (repo → global) so editing the global copy directly is a
  mistake.

## What this repo is **not** (since v0.7.0)

- **Not an agentic UI testing framework for Flutter.** Marionette MCP
  is that, and it does it better because it runs INSIDE the app.
  Don't recreate gestures, widget tree introspection, hit-testing, or
  text-input simulation here. Point users at Marionette.
- Not a generic Flutter test framework. We don't compete with
  `integration_test`.
- Not network-remote. stdio only.
- Not Windows-tested. Should work via ConPTY; nobody's tried.
