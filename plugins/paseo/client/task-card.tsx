import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { MeantimeCardData } from "../shared/tasks.js";
import { SectionLabel, TaskLine } from "./task-view.js";

export function MeantimeTaskCard({ item, theme, layout }: PluginTimelineItemProps<MeantimeCardData>) {
  const { colors } = theme;
  const data = item.data;
  const styles = useMemo(() => ({
    card: {
      backgroundColor: colors.surface1,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 10,
      paddingVertical: layout.compact ? 8 : 10,
      paddingHorizontal: layout.compact ? 10 : 12,
      gap: 10,
    },
    footer: { color: colors.foregroundMuted, fontSize: 10.5 },
  }), [colors, layout.compact]);

  const header = data.source === "handle"
    ? "Background task"
    : `meantime${data.action ? ` · ${data.action}` : ""}`;

  return (
    <View style={styles.card}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name="Layers" size={11} color={colors.foregroundMuted} />
          <SectionLabel text={header} colors={colors} />
        </View>
        {data.phase === "streaming" ? (
          <Text style={{ color: colors.accent, fontSize: 10.5, fontWeight: "600", letterSpacing: 1 }}>LIVE</Text>
        ) : null}
      </View>
      {data.tasks.map(task => (
        <TaskLine key={task.id} task={task} colors={colors} layout={layout} />
      ))}
      {data.moreOffset !== undefined
        ? <Text style={styles.footer}>More tasks not shown (offset {data.moreOffset})</Text>
        : null}
    </View>
  );
}
