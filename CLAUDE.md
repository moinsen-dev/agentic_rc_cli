# CLAUDE.md — agentic_rc_cli

Project-local conventions for any Claude session working in this repo.

## What this project is

An MCP server (`agentic-rc-mcp`) that lets a Claude / MCP agent drive
long-running interactive local programs — PTY control + Flutter VM-service
+ inspector + gesture injection + text input. Built so the agent never has
to ask "could you press X for me?".

Architecture: `src/` is TypeScript MCP-server code, `flutter_example/` is a
real Flutter app we use for live verification, `scripts/` holds end-to-end
demo scripts that JSON-RPC-drive a fresh server over stdio.

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
| build a new Dart expression for `rc_flutter_eval` · debug "Expression compilation error" (RPC 113) · the eval result comes back `{kind: "@Error"}` · adding a new gesture/inspector tool that uses `WidgetsBinding`/`GestureBinding` | [`docs/learnings/vm-service-eval-quirks.md`](docs/learnings/vm-service-eval-quirks.md) | the work is purely PTY / generic Bash — no Dart eval involved |
| triggering hot reload from code · seeing "Error while starting Kernel isolate task" from `reloadSources` RPC · wondering why `rc_flutter_hot_reload` uses PTY `r` instead of the VM service | [`docs/learnings/flutter-hot-reload-pipeline.md`](docs/learnings/flutter-hot-reload-pipeline.md) | not modifying the reload tool / pipeline |
| adding support for a new device target · `rc_flutter_endpoints` returns `vm_service_ws: null` on a new platform · sniffer regex doesn't match Flutter's output for some device | [`docs/learnings/flutter-endpoint-sniffing.md`](docs/learnings/flutter-endpoint-sniffing.md) | endpoints already detect cleanly on the device you care about |
| `rc_flutter_widget_find by=key` returns empty when the widget clearly has the Key · adding a new search axis to the inspector · choosing between inspector-cache walk vs live Dart eval | [`docs/learnings/inspector-tree-keys.md`](docs/learnings/inspector-tree-keys.md) | search-by-type or search-by-source works for the current need |
| `rc_flutter_screenshot` returns `{extension_not_registered}` · adding visual-verification logic · advising user about Peekaboo / chrome-devtools fallback | [`docs/learnings/screenshot-availability.md`](docs/learnings/screenshot-availability.md) | screenshot already works for the platform you're on |
| writing a new `gesture_dart.ts` builder · introducing back-to-back eval-driven mutations · seeing "setState during build" or stack-frame-parser assertions | [`docs/learnings/framework-rebuild-pacing.md`](docs/learnings/framework-rebuild-pacing.md) | only adding a single non-mutating eval (e.g. read-only query) |
| adding a new MCP tool that calls `svc.evaluate(…)` · debugging a tool that returns `raw_eval: null` without `eval_kind` · seeing `reason: "empty"` from a tap/geometry/wait_for · before merging any new eval-driven handler | [`docs/learnings/eval-diagnostic-discipline.md`](docs/learnings/eval-diagnostic-discipline.md) | the work is purely PTY-based with no eval call |

**Self-learning rule:** when a non-obvious workaround / quirk / constraint
surfaces during work in this repo, write a new file under
`docs/learnings/`, add a row to the table above, and commit it with the
code change that revealed it. Same forensic discipline as
`~/.claude/refs/`.

## Verification gates

Before suggesting a commit:

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest — should be 57+ passing
npm run smoke       # 22-tool list + generic PTY happy path
```

End-to-end Flutter demos (each spawns its own fresh MCP server):

```bash
node scripts/flutter-drive.mjs           # hot reload over PTY
node scripts/flutter-error-detect.mjs    # exception detection via PTY
node scripts/flutter-vm-agentic-loop.mjs # structured errors via VM service
node scripts/flutter-inspector-demo.mjs  # widget tree / find / properties
node scripts/flutter-tap-demo.mjs        # 7 taps → counter 0 → 7
node scripts/flutter-login-demo.mjs      # full login flow (enter_text + tap)
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
- Currently 0.5.0 → next major surface change → 0.6.0.

## Distribution

- `.claude/skills/agentic-rc/SKILL.md` is the canonical skill. It's
  auto-loaded by Claude Code in this repo + installed globally via
  `npm run install:skill`. Keep both copies in sync — the install script
  is one-way (repo → global) so editing the global copy directly is a
  mistake.

## What this repo is **not**

- Not a generic Flutter test framework. We don't compete with
  `integration_test` — we complement it for the case where the agent
  drives the app live with no human-in-the-loop.
- Not network-remote. stdio only. Future scope, but not now.
- Not Windows-tested. Should work via ConPTY; nobody's tried.
