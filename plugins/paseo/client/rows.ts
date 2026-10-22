import type { PluginTheme } from "@getpaseo/plugin";
import type { TaskSummary } from "../shared/tasks.js";
import { elapsedSeconds } from "../shared/tasks.js";

type RGB = [number, number, number];
function rgb(color: string): RGB | undefined {
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(color)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map(c => c + c).join("") : hex;
    return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)) as RGB;
  }
  const match = /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/.exec(color);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Precompute opaque colors: never fade the whole panel (including its text). */
export function mixColor(color: string, toward: string, amount: number): string {
  const a = rgb(color), b = rgb(toward);
  if (!a || !b) return color;
  return `#${a.map((value, i) => Math.round(value + (b[i]! - value) * amount).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(color: RGB): number {
  const linear = color.map(value => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

/** Preserve the theme hue, darkening/lightening only when host tokens are too pale. */
export function readableColor(color: string, colors: PluginTheme["colors"], target = 4.5): string {
  const surface = rgb(colors.surface0);
  if (!surface || !rgb(color)) return color;
  const background = luminance(surface);
  for (let step = 0; step <= 20; step++) {
    const candidate = mixColor(color, colors.foreground, step / 20);
    const value = luminance(rgb(candidate)!);
    if ((Math.max(value, background) + 0.05) / (Math.min(value, background) + 0.05) >= target) return candidate;
  }
  return colors.foreground;
}

export function secondaryColor(colors: PluginTheme["colors"]): string {
  return readableColor(mixColor(colors.foregroundMuted, colors.foreground, 0.15), colors);
}

/** Glow only reads on dark surfaces; on light ones the lamp is just ink. */
export function isDarkSurface(colors: PluginTheme["colors"]): boolean {
  const surface = rgb(colors.surface0);
  return surface ? luminance(surface) < 0.2 : false;
}

export function frameColor(colors: PluginTheme["colors"]): string {
  return mixColor(secondaryColor(colors), colors.surface0, 0.4);
}

/** Hairline between rows inside a flush card. */
export function dividerColor(colors: PluginTheme["colors"]): string {
  return mixColor(secondaryColor(colors), colors.surface0, 0.85);
}

/** Done is green when the theme has one; the pilot lamp always uses this. */
export function doneColor(colors: PluginTheme["colors"]): string {
  return readableColor(colors.statusSuccess ?? "#7fb26a", colors);
}

export function stateColor(state: string, colors: PluginTheme["colors"]): string {
  switch (state) {
    case "running":
    case "started":
    case "waiting":
    case "queued":
    case "cancel_requested":
      return readableColor(colors.statusWarning, colors);
    case "failed":
      return readableColor(colors.statusDanger, colors);
    default:
      return secondaryColor(colors);
  }
}

export function stateLabel(state: string): string {
  return state ? state.replaceAll("_", " ").toUpperCase() : "MISSING STATE";
}

/** Human-facing compact status, without task bookkeeping jargon. */
export function stateText(state: string): string {
  switch (state) {
    case "completed": return "done";
    case "cancel_requested": return "cancel requested";
    case "outcome_unknown": return "status unknown";
    default: return state ? state.replaceAll("_", " ") : "unknown";
  }
}

/** Distinct process-table codes; the accessible label retains the full state. */
export function stateCode(state: string): string {
  switch (state) {
    case "running": return "R";
    case "started": return "S";
    case "waiting": return "W";
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

/** Paseo's default codeFontSize/line-height. Plugin themes expose colors only,
 * so this aligns with the native default rather than the user's live setting. */
export const CODE_FONT_SIZE = 12;
export const CODE_LINE_HEIGHT = 18;

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
