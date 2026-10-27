import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { View } from "react-native";
import { mixColor, secondaryColor } from "./rows.js";

/**
 * The one card chrome for every pi-meantime surface — timeline cards, wait
 * cards and the board all share this frame. Rows own their padding, so
 * hairlines run edge to edge; the frame clips nothing (`overflow: hidden`
 * would let a freshly mounted drawer smear the pre-mount frame in a
 * virtualized list), so inner blocks round their own outer corners instead.
 */
export function Card({ colors, children }: { colors: PluginTheme["colors"]; children: ReactNode }) {
  return (
    <View style={{
      borderRadius: 10,
      borderWidth: 1,
      borderColor: mixColor(secondaryColor(colors), colors.surface0, 0.88),
      backgroundColor: mixColor(colors.surface1, colors.surface0, 0.45),
    }}>
      {children}
    </View>
  );
}
