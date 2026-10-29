import type { PluginTheme } from "@getpaseo/plugin";

type Slate = Omit<PluginTheme["colors"], "accentForeground">;

/**
 * Meantime's own console palette: neutral Braun carbon, deliberately no
 * relative of notesoup's paper or Square's terracotta, so a meantime card
 * reads as a precision instrument rather than another sheet of stationery.
 * Every token is opaque and self-contained — these cards never borrow the
 * host's surface ramp, only its appearance and its accentForeground.
 */
const PALETTE: Record<"dark" | "light", Slate> = {
  dark: {
    surface0: "#101012", // recessed output well
    surface1: "#19191c", // card, lifted off the timeline
    surface2: "#222226",
    border: "#2e2e33",
    foreground: "#e8e8eb",
    foregroundMuted: "#8a8a93",
    statusSuccess: "#34d399",
    statusWarning: "#f59e0b",
    statusDanger: "#f87171",
    accent: "#a1a1aa",
  },
  light: {
    surface0: "#f3f4f6",
    surface1: "#ffffff",
    surface2: "#e9ebef",
    border: "#dcdee3",
    foreground: "#18181b",
    foregroundMuted: "#71717a",
    statusSuccess: "#059669",
    statusWarning: "#d97706",
    statusDanger: "#dc2626",
    accent: "#52525b",
  },
};

/** WCAG relative luminance, the same sRGB curve rows.ts judges contrast with;
 * kept local so the palette depends on nothing that renders. */
function luminance(color: string): number | undefined {
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(color)?.[1];
  if (!hex) return undefined;
  const full = hex.length === 3 ? [...hex].map(c => c + c).join("") : hex;
  const [r, g, b] = [0, 2, 4].map(i => {
    const s = parseInt(full.slice(i, i + 2), 16) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
}

/**
 * Appearance is read off the host's own ink: a foreground brighter than
 * surface0 can only be a dark theme, and the reverse a light one. A host that
 * hands over something other than hex keeps its palette untouched — guessing
 * an appearance would be worse than inheriting.
 */
export function meantimeTheme(theme: PluginTheme): PluginTheme {
  const surface = luminance(theme.colors.surface0);
  const ink = luminance(theme.colors.foreground);
  if (surface === undefined || ink === undefined) return theme;
  return { colors: {
    ...(ink > surface ? PALETTE.dark : PALETTE.light),
    accentForeground: theme.colors.accentForeground,
  } };
}
