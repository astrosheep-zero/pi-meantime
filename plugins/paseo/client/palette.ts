import type { PluginTheme } from "@getpaseo/plugin";

type Slate = Omit<PluginTheme["colors"], "accentForeground">;

export const LIGHT_CHASSIS_SURFACE = "#eef1f6";

/**
 * Dark hosts keep the smoked Braun-carbon console. Light hosts get the frosted
 * quartz chassis from the light-glass-v4 direction: a pale mineral surface,
 * one white sheen, and the task's tone glowing in from the top-left corner.
 */
const PALETTE: Record<"dark" | "onLight", Slate> = {
  dark: {
    surface0: "#0f1114",
    surface1: "#13161b",
    surface2: "#1b1f26",
    border: "#252a33",
    foreground: "#f0f2f5",
    foregroundMuted: "#8a9199",
    statusSuccess: "#7fb26a",
    statusWarning: "#8ba7c4",
    statusDanger: "#ef7d6b",
    accent: "#8d99a8",
  },
  onLight: {
    surface0: LIGHT_CHASSIS_SURFACE,
    surface1: "#ecf0f6",
    surface2: "#e6eaf1",
    border: "#d7dbe3",
    foreground: "#151a23",
    foregroundMuted: "#646e7e",
    statusSuccess: "#209c56",
    statusWarning: "#4f7093",
    statusDanger: "#da3c2e",
    accent: "#7d8591",
  },
};

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

export function meantimeTheme(theme: PluginTheme): PluginTheme {
  const surface = luminance(theme.colors.surface0);
  const ink = luminance(theme.colors.foreground);
  if (surface === undefined || ink === undefined) return theme;
  return { colors: {
    ...(ink > surface ? PALETTE.dark : PALETTE.onLight),
    accentForeground: theme.colors.accentForeground,
  } };
}
