import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { View } from "react-native";
import { mixColor, secondaryColor } from "./rows.js";

/**
 * The one card chrome for every pi-meantime surface — timeline cards, wait
 * cards and the board all share this frame. `flush` removes inner padding so
 * rows own their padding and hairline dividers run edge to edge.
 */
export function Card({ colors, children }: { colors: PluginTheme["colors"]; children: ReactNode }) {
  return (
    <View style={{
      borderRadius: 10,
      overflow: "hidden",
      borderWidth: 1,
      borderColor: mixColor(secondaryColor(colors), colors.surface0, 0.88),
      backgroundColor: mixColor(colors.surface1, colors.surface0, 0.45),
    }}>
      {children}
    </View>
  );
}
