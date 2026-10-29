import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { MeantimeCardData } from "../shared/tasks.js";
import { isActiveTask } from "../shared/tasks.js";
import { Card } from "./card.js";
import { meantimeTheme } from "./palette.js";
import { CODE_FONT_SIZE, CODE_LINE_HEIGHT, dividerColor, monoFont, secondaryColor, stateColor } from "./rows.js";
import { TaskGlyph, TaskLine, TaskTable } from "./task-view.js";
import { Icon } from "@getpaseo/plugin/client/react-native";


export function MeantimeTaskCard(props: PluginTimelineItemProps<MeantimeCardData>) {
  const { item, theme, layout } = props;
  const colors = useMemo(() => meantimeTheme(theme).colors, [theme]);
  const data = item.data;
  if (data.pending) return <WaitSkeleton colors={colors} layout={layout} />;
  if (data.error !== undefined) return (
    <Card colors={colors}>
      <View style={{ paddingHorizontal: 12, paddingVertical: 9, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <TaskGlyph task={{ state: "failed" }} colors={colors} />
          <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontFamily: monoFont(layout.platform),
            fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT }}>{data.call ?? "meantime"}</Text>
          <Text style={{ color: secondaryColor(colors), fontSize: 12, lineHeight: 16 }}>failed</Text>
        </View>
        <Text selectable style={{ color: stateColor("failed", colors), fontSize: 12, lineHeight: 17 }}>{data.error}</Text>
      </View>
    </Card>
  );
  if (data.source === "meantime" && data.action === "wait" && data.tasks.length === 0) return (
    <Card colors={colors}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 9 }}>
        <TaskGlyph task={{ state: "waiting" }} colors={colors} />
        <Text style={{ flex: 1, color: colors.foreground, fontFamily: monoFont(layout.platform),
          fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT }}>All pending tasks</Text>
      </View>
    </Card>
  );
  if (data.source === "meantime" && data.action === "list") {
    const count = data.total ?? data.tasks.length;
    const divider = dividerColor(colors);
    const muted = secondaryColor(colors);
    return (
      <View style={{ gap: 4 }}>
        <Card colors={colors}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12,
            paddingHorizontal: 12, paddingVertical: 8,
            borderBottomWidth: data.tasks.length > 0 ? 1 : 0, borderBottomColor: divider }}>
            <Text style={{ color: muted, fontSize: 12, lineHeight: 16, fontWeight: "500" }}>
              {data.tasks.length === 0 ? "No background tasks" : "Background tasks"}
            </Text>
            <Text style={{ color: muted, fontSize: 12, lineHeight: 16 }}>
              {data.tasks.length === 0 ? "none" : `${count} task${count === 1 ? "" : "s"}`}
            </Text>
          </View>
          {data.tasks.map((task, index) => (
            <View key={task.id} style={index > 0 ? { borderTopWidth: 1, borderTopColor: divider } : undefined}>
              <TaskLine task={task} colors={colors} layout={layout} showId muted={!isActiveTask(task)} last={index === data.tasks.length - 1} />
            </View>
          ))}
        </Card>
        {data.moreOffset !== undefined ? <Text style={{ color: muted, fontSize: 10,
          fontFamily: monoFont(layout.platform) }}>More tasks not shown (offset {data.moreOffset})</Text> : null}
      </View>
    );
  }
  // Even a snapshot-backed launch handle is historical evidence of starting,
  // not a continuing observation of a running process.
  const tasks = data.source === "handle"
    ? data.tasks.map(task => task.state === "running" ? { ...task, state: "started" } : task)
    : data.tasks;
  return (
    <View style={{ gap: 4 }}>
      <TaskTable tasks={tasks} colors={colors} layout={layout} />
      {data.moreOffset !== undefined ? <Text style={{ color: secondaryColor(colors), fontSize: 10,
        fontFamily: monoFont(layout.platform) }}>More tasks not shown (offset {data.moreOffset})</Text> : null}
    </View>
  );
}

/** Before the first Pi snapshot, reserve exactly the future command row's shape.
 * No tool name or task id masquerading as a command. */
function WaitSkeleton({ colors, layout }: { colors: ReturnType<typeof meantimeTheme>["colors"]; layout: PluginTimelineItemProps["layout"] }) {
  return <Card colors={colors}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 9 }}>
      <TaskGlyph task={{ state: "waiting" }} colors={colors} />
      <View style={{ flex: 1, height: CODE_LINE_HEIGHT, justifyContent: "center" }}>
        <View style={{ width: "65%", maxWidth: 240, height: 8, borderRadius: 2, backgroundColor: dividerColor(colors) }} />
      </View>
      <Icon name="ChevronDown" size={15} color={secondaryColor(colors)} />
    </View>
  </Card>;
}
