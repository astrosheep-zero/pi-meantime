import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { View } from "react-native";
import { glassChrome, type Tone } from "./chrome.js";

// Tone helpers live in chrome.js next to the recipe; re-exported here so
// existing imports from ./card.js keep working.
export { taskTone, toneColor, toneRgb } from "./chrome.js";
export type { Tone, WaitOutcome } from "./chrome.js";

type Colors = PluginTheme["colors"];
type Layout = { platform: "ios" | "android" | "web" };

/** The plain glass panel (inventory lists, the board). */
export function Card({ colors, layout, children, grouped = false }: { colors: Colors; layout: Layout; children: ReactNode; grouped?: boolean }) {
  return <View style={[glassChrome(colors, layout.platform), grouped && { paddingVertical: 0 }]}>{children}</View>;
}

/** The same glass panel with the task's tone washing the top-left corner. */
export function TintedCard({ colors, tone, layout, children, grouped = false }: { colors: Colors; tone: Tone; layout: Layout; children: ReactNode; grouped?: boolean }) {
  return <View style={[glassChrome(colors, layout.platform, tone), grouped && { paddingVertical: 0 }]}>{children}</View>;
}
