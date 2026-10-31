import type { PluginTheme } from "@getpaseo/plugin";
import type { ViewStyle } from "react-native";
import type { TaskSummary } from "../shared/tasks.js";
import { isDarkSurface, rgb } from "./rows.js";

type Colors = PluginTheme["colors"];
export type Tone = "ok" | "bad" | "run" | "neutral";
export type WaitOutcome = "timeout" | "interrupted";
const FALLBACK_RGB: Record<Tone, string> = { ok: "127,178,106", bad: "239,125,107", run: "233,180,90", neutral: "141,153,168" };

export function taskTone(task: Pick<TaskSummary, "state" | "exitCode">, outcome?: WaitOutcome): Tone {
  if (outcome) return outcome === "timeout" ? "run" : "neutral";
  if (task.state === "failed" || (task.exitCode !== undefined && task.exitCode !== 0)) return "bad";
  if (task.state === "completed") return "ok";
  if (["running", "started", "waiting", "queued", "cancel_requested"].includes(task.state)) return "run";
  return "neutral";
}
export function toneColor(tone: Tone, colors: Colors): string {
  return tone === "ok" ? (colors.statusSuccess ?? "#7fb26a")
    : tone === "bad" ? (colors.statusDanger ?? "#ef7d6b")
    : tone === "run" ? (colors.statusWarning ?? "#e9b45a")
    : (colors.accent ?? "#8d99a8");
}
export function toneRgb(tone: Tone, colors: Colors): string {
  return rgb(toneColor(tone, colors))?.join(",") ?? FALLBACK_RGB[tone];
}

/**
 * The one chassis every meantime card shares: self-luminous glass. A corner
 * wash carries the tone; a vertical sheen plus inset highlights fake the
 * optics (RN has no backdrop-filter). Web reads `backgroundImage`; Fabric
 * only listens to `experimental_backgroundImage` and silently drops the
 * other spelling, so the recipe is emitted per platform.
 */
export function glassChrome(colors: Colors, platform: "ios" | "android" | "web", tone?: Tone): ViewStyle {
  const dark = isDarkSurface(colors);
  const images: string[] = [];
  if (tone === "run") {
    // A live task breathes across the whole card, not just a corner.
    images.push(`linear-gradient(135deg, rgba(${toneRgb(tone, colors)},${dark ? 0.07 : 0.05}), rgba(${toneRgb(tone, colors)},0) 70%)`);
  } else if (tone !== undefined) {
    const tint = toneRgb(tone, colors);
    images.push(`radial-gradient(240px 90px at 0% 0%, rgba(${tint},0.03), rgba(${tint},0) 75%)`);
  }
  images.push(dark
    ? "linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0.02))"
    : "linear-gradient(180deg, rgba(255,255,255,0.94), rgba(245,247,251,0.9))");
  return {
    borderRadius: 9,
    borderWidth: 0.5,
    borderColor: dark ? "rgba(255,255,255,0.09)" : "rgba(178,188,204,0.68)",
    backgroundColor: dark ? colors.surface1 : colors.surface0,
    ...(platform === "web"
      ? { backgroundImage: images.join(", ") }
      : { experimental_backgroundImage: images.join(", ") }),
    boxShadow: dark
      ? "inset 0 1px 0 rgba(255,255,255,0.09), 0 1px 2px rgba(0,0,0,0.22), 0 6px 14px -6px rgba(0,0,0,0.3)"
      : "inset 0 1px 0 rgba(255,255,255,0.98), inset 0 -1px 0 rgba(255,255,255,0.55), 0 1px 2px rgba(15,20,30,0.04), 0 6px 14px -6px rgba(15,20,30,0.08)",
    paddingHorizontal: 11.5,
    paddingVertical: 8.5,
  };
}
