# Real Pi process crash and official session recovery

This isolated fixture launches the installed official Pi CLI twice through a real Python PTY. The first process is deliberately killed with SIGKILL after a completed control and an unfinished background task have written their snapshots. The second process opens the exact saved session using the official `--session` option and probes the production extension through real provider-issued `bg_task` calls.

No production source, SDK file, real provider account, or external service is changed. The provider and synthetic business endpoint are one localhost HTTP server. The driver and all of its children must run in one execution call so that localhost networking is shared.

## Run

From the project root, using a new run name each time:

```sh
PI_E2E_NODE="$(command -v node)" \
  python e2e-restart/run-restart.py proof-new
python e2e-restart/render-status.py proof-new
python e2e-restart/verify-restart.py proof-new
```

The driver refuses to overwrite a run directory. It creates a synthetic HOME, agent configuration, sessions, and task storage under `evidence/restart/<run-name>`. It signals only child processes/process groups that it created. Every normal or exceptional path attempts cleanup of those owned children.

## What is proven

- An actual official Pi process is killed, not merely an in-process runtime replaced.
- The exact session ID and file are resumed in a new official Pi process.
- An unfinished recovered task reports unknown outcome, no local running controller and unavailable result.
- A cancel request for that recovered task is rejected instead of fabricating cancellation.
- The completed control's stored result remains readable and byte-identical.
- Original business HTTP calls are not replayed after restart.
- Before-crash exit is a planned SIGKILL; after-restart exit is a normal `/quit`.
- Actual host versions and source/SDK hashes are recorded for both processes.
- After resume, the driver types `/bg status` through the actual PTY and captures
  the visible recovered-unknown and completed task panel at 140 columns by 48 rows.
  `render-status.py` reconstructs terminal cells from the captured cursor/erase
  commands, saves text, and renders an explicitly labeled image. It uses the
  already-available Python `wcwidth` and Pillow packages. This is a text rendering
  of a real ANSI capture, not a native application screenshot.

## Limits

This does not test power/storage failure, fsync durability, cross-process database consistency, or a real remote service's cancellation/rollback semantics. It observes recovery from snapshots already written by this one Pi process. After a run, inspect its `verification.json` and recorded source/SDK hashes for the exact results. Generated evidence is not committed to this repository.
