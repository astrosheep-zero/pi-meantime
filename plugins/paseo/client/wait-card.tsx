import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { MeantimeCardData } from "../shared/tasks.js";
import { CODE_FONT_SIZE, CODE_LINE_HEIGHT, completionResult, mixColor, monoFont, secondaryColor } from "./rows.js";
import { TaskDetailModal } from "./task-view.js";

/** Wait status belongs to this call; task status is a returned snapshot. */
export function WaitCard({ item, theme, layout }: PluginTimelineItemProps<MeantimeCardData>) {
  const { colors } = theme;
  const [openId, setOpenId] = useState<string | null>(null);
  const muted = secondaryColor(colors);
  const mono = monoFont(layout.platform);
  return <View style={{ gap: 8 }}>{item.data.tasks.map(task => {
    const waiting = task.state === "waiting";
    const terminal = ["completed", "failed", "cancelled"].includes(task.state);
    const title = waiting ? "Waiting" : terminal ? "Finished waiting" : "Wait ended";
    const note = waiting ? "Awaiting result" : terminal ? completionResult(task)
      : task.state === "running" ? "Still running when wait ended"
      : task.state === "cancel_requested" ? "Cancellation requested"
      : "Status unavailable";
    const accent = waiting ? colors.statusWarning : muted;
    return <View key={task.id}>
      <Pressable onPress={() => setOpenId(task.id)} accessibilityRole="button" accessibilityLabel={`${title}: ${task.command ?? task.tool ?? task.id}`}
        style={({ pressed }) => ({ borderRadius: 12, overflow: "hidden", borderWidth: 1,
          opacity: pressed ? 0.85 : 1,
          borderColor: mixColor(muted, colors.surface0, 0.82),
          backgroundColor: mixColor(colors.surface1, colors.surface0, 0.45) })}>
        <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <Text style={{ fontSize: 12, color: muted, fontWeight: "500" }}>◷  Meantime</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={{ width: 5, height: 5, borderRadius: 3, borderWidth: 1, borderColor: accent, backgroundColor: waiting ? accent : "transparent" }} />
            <Text style={{ fontSize: 11, color: accent }}>{title}</Text>
          </View>
        </View>
        <View style={{ paddingHorizontal: 16, paddingBottom: 16, flexDirection: "row", gap: 11 }}>
          <Text style={{ fontFamily: mono, fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT, color: muted }}>$</Text>
          <Text style={{ flex: 1, fontFamily: mono, fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT, color: colors.foreground }}>{task.command ?? task.tool ?? task.id}</Text>
        </View>
        <View style={{ borderTopWidth: 1, borderTopColor: mixColor(muted, colors.surface0, 0.9), paddingHorizontal: 16, paddingVertical: 12 }}>
          <Text style={{ color: muted, fontSize: 11 }}>↳  {note}</Text>
        </View>
      </Pressable>
      {openId === task.id ? <TaskDetailModal task={task} colors={colors} layout={layout} waitStatus={title} onClose={() => setOpenId(null)} /> : null}
    </View>;
  })}</View>;
}
