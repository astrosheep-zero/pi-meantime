import type { PluginTheme } from "@getpaseo/plugin";
import type { TaskSummary } from "../shared/tasks.js";
import { elapsedSeconds } from "../shared/tasks.js";

export function stateColor(state: string, colors: PluginTheme["colors"]): string {
  switch (state) {
    case "running":
    case "started":
    case "queued":
    case "cancel_requested":
      return colors.statusWarning;
    case "failed":
      return colors.statusDanger;
    default:
      return colors.foregroundMuted;
  }
}

export function stateLabel(state: string): string {
  return state ? state.replaceAll("_", " ").toUpperCase() : "MISSING STATE";
}

/** Distinct process-table codes; the accessible label retains the full state. */
export function stateCode(state: string): string {
  switch (state) {
    case "running": return "R";
    case "started": return "S";
    case "queued": return "Q";
    case "completed": return "X";
    case "failed": return "E";
    case "cancel_requested": return "C?";
    case "cancelled": return "C";
    case "outcome_unknown": return "?";
    default: return state ? "?" : "—";
  }
}

/** Cross-platform monospace: iOS has no generic "monospace" alias. */
export function monoFont(platform: "ios" | "android" | "web"): string {
  return platform === "ios" ? "Menlo" : "monospace";
}

/** Snapshot only. A creation time without an end is not an elapsed duration. */
export function formatElapsed(task: TaskSummary): string | undefined {
  const seconds = elapsedSeconds(task);
  if (seconds === undefined) return undefined;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

export function completionResult(task: TaskSummary): string {
  // Never manufacture exit 0 from a successful state (or exit 1 from failure).
  const state = stateLabel(task.state).toLowerCase();
  return task.exitCode === undefined ? state : `${state} · exit ${task.exitCode}`;
}

export function taskStateLabel(task: TaskSummary): string {
  return task.exitCode === undefined ? stateLabel(task.state) : `${stateLabel(task.state)} · exit ${task.exitCode}`;
}

export function taskStateCode(task: TaskSummary): string {
  const code = stateCode(task.state);
  return task.exitCode !== undefined && (task.state === "completed" || task.state === "failed")
    ? `${code}${task.exitCode}` : code;
}
