import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { MeantimeCardData } from "../shared/tasks.js";
import { taskRowSpec } from "./rows.js";

export function MeantimeTaskCard({ item, theme, layout }: PluginTimelineItemProps<MeantimeCardData>) {
  const { colors } = theme;
  const data = item.data;
  const styles = useMemo(() => ({
    card: {
      backgroundColor: colors.surface1,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: layout.compact ? 8 : 10,
      gap: 6,
    },
    header: { color: colors.foregroundMuted, fontSize: 12 },
    rowHeading: { color: colors.foreground, fontSize: 13, flexShrink: 1 },
    rowMeta: { color: colors.foregroundMuted, fontSize: 12 },
    detail: { color: colors.foregroundMuted, fontSize: 12 },
  }), [colors, layout.compact]);

  const header = data.source === "handle"
    ? "Background task started"
    : `meantime${data.action ? ` ${data.action}` : ""}`;

  return (
    <View style={styles.card}>
      <Text style={styles.header}>{header}{data.phase === "streaming" ? " …" : ""}</Text>
      {data.tasks.map(task => {
        const row = taskRowSpec(task, colors);
        return (
          <View key={task.id} style={{ gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ color: row.color, fontSize: 12 }}>●</Text>
              <Text style={styles.rowHeading} numberOfLines={1}>{row.heading}</Text>
              {row.elapsed ? <Text style={styles.rowMeta}>{row.elapsed}</Text> : null}
              <Text style={[styles.rowMeta, { color: row.color }]}>{row.state}</Text>
            </View>
            {row.command ? <Text style={styles.detail} numberOfLines={1}>{row.command}</Text> : null}
            {row.progress ? <Text style={styles.detail} numberOfLines={1}>{row.progress}</Text> : null}
            {row.outputPath ? <Text style={styles.detail} numberOfLines={1}>{row.outputPath}</Text> : null}
            {row.note ? <Text style={styles.detail}>{row.note}</Text> : null}
          </View>
        );
      })}
      {data.moreOffset !== undefined
        ? <Text style={styles.detail}>More tasks not shown (offset {data.moreOffset})</Text>
        : null}
    </View>
  );
}
