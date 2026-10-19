import type { PluginTheme } from "@getpaseo/plugin";
import type { TaskSummary } from "../shared/tasks.js";
import { elapsedSeconds } from "../shared/tasks.js";

export function stateColor(state: string, colors: PluginTheme["colors"]): string {
  switch (state) {
    case "running":
      return colors.accent;
    case "completed":
      return colors.statusSuccess;
    case "failed":
      return colors.statusDanger;
    case "cancelled":
    case "cancel_requested":
      return colors.statusWarning;
    default:
      return colors.foregroundMuted;
  }
}

/** Badge text for a raw pi-meantime state. */
export function stateLabel(state: string): string {
  switch (state) {
    case "cancel_requested":
      return "CANCELING";
    case "outcome_unknown":
      return "UNKNOWN";
    default:
      return state.toUpperCase();
  }
}

/** Cross-platform monospace: iOS has no generic "monospace" alias. */
export function monoFont(platform: "ios" | "android" | "web"): string {
  return platform === "ios" ? "Menlo" : "monospace";
}

export function formatElapsed(task: TaskSummary, now?: number): string | undefined {
  const seconds = elapsedSeconds(task, now);
  if (seconds === undefined) return undefined;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Hex-alpha tint of a theme color for pill/badge backgrounds. */
export function tint(color: string, alpha: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}${alpha}` : color;
}
