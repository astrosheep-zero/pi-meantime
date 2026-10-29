# Same-name execute wrapping: integration gate

Status: **not suitable as a replacement for the existing proxy implementation**. The proposal works mechanically but fails the existing post-hook retention contract. No production entry point imports this probe.

Run from the package root:

```sh
node --experimental-strip-types scripts/same-name-gate.mjs
```

This deliberately exits 1 at the result-retention assertion on the pinned Pi 1.3.0 SDK. It uses real SDK nested dispatch, the real QuickJS codemode extension, native Bash, and production `TaskRuntime`/`TaskStore`. It makes no model or network request and removes its temporary session and task files.

## Evidence

The probe mutates the registered AgentTool in `prepareLoadout`: it decorates the parameter schema, captures the original `execute`, and replaces it with `TaskRuntime.run`. It does not register a competing tool under the target name.

Verified:

- Original name and strict input schema work; the control property is stripped before original execution.
- Permission rejection prevents original execution.
- Background execution returns a task handle while the producer keeps running.
- A real codemode script calls the original name through the patched object.
- Native Bash uses the same mechanism.
- Source re-registration executes v2, hidden exposure withdraws it, restoration executes v2 again.

A fixture `tool_result` handler replaces `RAW_FIXTURE` with `REDACTED_FIXTURE` and changes the authoritative outcome to `isError: true`. Actual results:

| Path | Returned to caller | Stored task result | Stored error flag |
| --- | --- | --- | --- |
| Foreground | `REDACTED_FIXTURE`, error true | `v1:RAW_FIXTURE` | false |
| Background | Running task handle | `v1:RAW_FIXTURE` | false |

On the background path, the original result hook receives the task handle. No second hook invocation occurs when the producer completes. Reading the stored result through `meantime` would invoke hooks for **meantime**, which does not repair a hook that targets the original tool name.

Session replacement/reload and MCP detachment were not exercised by this gate; it already fails the result contract. Earlier registry-lifecycle probes alone do not establish result-pipeline parity.

## Cause and consequence

Pi's `runToolCall` validates and runs pre-call hooks, awaits the selected `execute`, then invokes `afterToolCall`. Wrapping only `execute` places `TaskRuntime` persistence **before** that last step. Returning a handle completes the host call, so a later producer result cannot enter its original post-call pipeline.

This was already a documented limitation of the special Bash path in DESIGN.md. Applying that implementation to arbitrary third-party tools broadens the limitation to tools whose existing proxies currently retain post-hook results and authoritative outcome flags. This is a behavioral regression, not just an unsupported shared-reference assumption.

A renderer only changes presentation. Schema injection only changes validation. Watching `tool_execution_end` cannot supply a post-hook background result that the host never produced. Dispatching the same tool again is a second call, with duplicate permissions and possible side effects; manually redispatching extension hooks requires host internals and lifecycle handling. Neither is a transparent fix for this implementation.

## Required integration boundary

A host-supported background wrapper must retain a `next` operation encompassing **native execution and final result hooks**, and keep that operation alive after returning the task handle. Pre-call permission checks must finish before detachment; sequential execution policy, cancellation ownership, final outcome flags, and session replacement must remain explicit. A host API that wraps only `execute` repeats this defect, even if it is officially supported.

Until that boundary exists or different semantics are explicitly chosen, keep the existing production adapter. Do not silently fall back to `_bg` or publish the proposed mutation adapter as transparent.
