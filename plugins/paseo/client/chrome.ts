import type { PluginTheme } from "@getpaseo/plugin";
import type { ViewStyle } from "react-native";
import type { TaskSummary } from "../shared/tasks.js";
import { isDarkSurface, rgb, secondaryColor } from "./rows.js";

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
    : secondaryColor(colors);
}
export function toneRgb(tone: Tone, colors: Colors): string {
  return rgb(toneColor(tone, colors))?.join(",") ?? FALLBACK_RGB[tone];
}

/**
 * The rail every meantime card shares. It sits in one timeline family with
 * Square's slate slip and notesoup's paper note: same 4px corner, same hairline,
 * no drop shadow. Meantime is the frequent one, so it is the lightest of the
 * three — a cool slate veil in Square's family, a shade off the surface, with
 * colour only in the pip and the clock. In light mode there is no tone wash at
 * all: on a pale surface any tint dyes the whole rail.
 * Web reads `backgroundImage`; Fabric only listens to `experimental_backgroundImage`
 * and silently drops the other spelling, so the recipe is emitted per platform.
 */
export function glassChrome(colors: Colors, platform: "ios" | "android" | "web", tone?: Tone): ViewStyle {
  const dark = isDarkSurface(colors);
  const images: string[] = [];
  // Light mode gets no tone wash at all: on a pale surface any tint dyes the
  // whole rail (green reads mint, red reads pink). Tone lives in pip and clock.
  if (tone !== undefined && dark) {
    const tint = toneRgb(tone, colors);
    images.push(`radial-gradient(140px 40px at 0% 50%, rgba(${tint},0.04), rgba(${tint},0) 75%)`);
  }
  images.push(dark
    ? "linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.035))"
    : "linear-gradient(180deg, rgba(52,68,84,0.028), rgba(52,68,84,0.045))");
  return {
    borderRadius: 4,
    borderWidth: 0.5,
    borderColor: dark ? "rgba(255,255,255,0.09)" : "rgba(52,68,84,0.12)",
    borderTopColor: dark ? "rgba(255,255,255,0.13)" : "rgba(52,68,84,0.09)",
    backgroundColor: dark ? colors.surface1 : colors.surface0,
    ...(platform === "web"
      ? { backgroundImage: images.join(", ") }
      : { experimental_backgroundImage: images.join(", ") }),
    paddingHorizontal: 10,
    paddingVertical: 7,
  };
}
