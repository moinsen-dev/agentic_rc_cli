# Framework re-entrancy — pacing eval-driven mutations

When an eval-injected mutation triggers a Flutter rebuild, the
**next** eval call can land while the framework is still mid-frame.
The second mutation runs inside `ProxyElement.update`, fires
`notifyListeners`, a listener calls `setState`, and Flutter throws
"setState during build" — except you don't see that clean error because
Flutter's own error-reporter then asserts trying to parse the
anonymous Eval stack frame.

Discovered the hard way during enter_text's login demo round 1.

## The symptom

You see an `@Error` kind result from `rc_flutter_eval` (surfaced as
`eval_kind: "@Error"` + `eval_error: "Unhandled exception: …"` after
the diagnostics enhancement in `enter_text.ts`).

The stack trace looks like:

```
#0  _AssertionError._doThrowNew (...)
#2  StackFrame.fromStackTraceLine (...:210:12)
   ^^ Flutter's stack-frame parser asserts on 'match != null'
#21 WidgetInspectorService._reportStructuredError (...)
#22 FlutterError.reportError
#23 ChangeNotifier.notifyListeners
#24 ValueNotifier.value=
#25 TextEditingController.value=
#26 TextEditingController.text=
#27 Eval.<anonymous closure>
#28 Eval
#29 ProxyElement.update    ← we're INSIDE a build
#30 Element.updateChild
...
```

The bottom of the stack tells you: the eval ran while
`ProxyElement.update` was on the stack. That's the re-entrancy.

## The mitigation

After every state-mutating eval call, **yield ~200 ms server-side** so
the framework can finish whatever rebuild was kicked off:

```ts
// in flutter/enter_text.ts handler, after svc.evaluate(...)
await new Promise((r) => setTimeout(r, 200));
```

200 ms is enough at 60 fps + Flutter's microtask drain. Less reliable;
more is wasteful.

Same pattern applies to anything that fires `notifyListeners` or
`setState` indirectly:
- `rc_flutter_enter_text` ✅ (settles)
- `rc_flutter_tap` — does NOT currently settle (added latency would
  slow the agentic loop). The tap demo gets away with this because
  the demo script itself sleeps 300 ms between taps for the verification
  read. If a new caller does back-to-back taps without their own
  pacing, it could re-enter; consider adding the same 200 ms post-eval
  delay if that happens.

## On the agent / demo side

For **verification reads** after a state change, don't trust a fixed
sleep — poll with timeout:

```js
let status = null;
const deadline = Date.now() + 3000;
while (Date.now() < deadline) {
  await sleep(150);
  status = await readStatusText(sid);
  if (status === expected) break;
}
```

Variable rebuild cost (counter app ≪ login page with 2 TextFields)
makes fixed sleeps fragile. Polling is robust.

## The DON'T

Don't try to fix the underlying issue by suspending the Dart isolate
during eval (`pauseIsolate` + `evaluate` + `resumeIsolate`) — that
serialises everything and breaks the streaming error subscription.
The settle delay is cheaper and correct.

Don't reach for `await Future.delayed(...)` *inside* the Dart eval —
an async IIFE returns a Future which the VM service does await, but
it complicates the result parsing for marginal benefit when a 200 ms
server-side sleep does the job.

## The verification

[`scripts/flutter-login-demo.mjs`](../../scripts/flutter-login-demo.mjs)
exercises:
1. Two enter_text in quick succession (email then password) — works
   because of the 200 ms post-settle in the handler.
2. enter_text → tap → verify with polling — works because the demo
   polls instead of fixed-sleeping.

Before the settle landed, round 1 step 2 (password entry) failed
deterministically.
