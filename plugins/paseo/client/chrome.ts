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
 * The frost rail every meantime card shares: a thin, compact glass strip that
 * reads as one instrument. A corner wash carries the tone; the surface itself is
 * a near-flat cool gradient with a hairline border and a single soft shadow.
 * Next to Square's square-edged matte slip, this is the rounded frosted piece.
 * Web reads `backgroundImage`; Fabric only listens to `experimental_backgroundImage`
 * and silently drops the other spelling, so the recipe is emitted per platform.
 */
export function glassChrome(colors: Colors, platform: "ios" | "android" | "web", tone?: Tone): ViewStyle {
  const dark = isDarkSurface(colors);
  const images: string[] = [];
  if (tone !== undefined) {
    const tint = toneRgb(tone, colors);
    images.push(`radial-gradient(180px 60px at 0% 50%, rgba(${tint},${dark ? 0.08 : 0.05}), rgba(${tint},0) 75%)`);
  }
  images.push(dark
    ? "linear-gradient(115deg, rgba(255,255,255,0.05), rgba(255,255,255,0.015))"
    : "linear-gradient(115deg, rgba(241,246,245,0.9), rgba(247,249,252,0.92) 45%, rgba(237,241,246,0.9))");
  return {
    borderRadius: 5.5,
    borderWidth: 0.5,
    borderColor: dark ? "rgba(157,180,203,0.19)" : "rgba(103,125,149,0.21)",
    backgroundColor: dark ? colors.surface1 : colors.surface0,
    ...(platform === "web"
      ? { backgroundImage: images.join(", ") }
      : { experimental_backgroundImage: images.join(", ") }),
    boxShadow: dark
      ? "0 1px 2px rgba(0,0,0,0.12)"
      : "0 1px 2px rgba(30,45,65,0.035)",
    paddingHorizontal: 10,
    paddingVertical: 6,
  };
}
