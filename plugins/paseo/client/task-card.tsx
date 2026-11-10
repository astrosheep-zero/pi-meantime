import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { MeantimeCardData } from "../shared/tasks.js";
import { isActiveTask } from "../shared/tasks.js";
import { Card, TintedCard, taskTone, toneColor } from "./card.js";
import { dividerColor, formatSeconds, frameColor, secondaryColor, typeStyle, headStyle } from "./rows.js";
import { Pip, StatusRule, TaskLine, TaskTable } from "./task-view.js";

type Colors = PluginTheme["colors"];
type Layout = PluginTimelineItemProps["layout"];
export function MeantimeTaskCard({ item, theme, layout }: PluginTimelineItemProps<MeantimeCardData>) {
  const colors = theme.colors, data = item.data;
  if (data.pending) return <TintedCard colors={colors} tone="run" layout={layout}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 18 }}>
      <Pip tone="run" colors={colors} />
      <View style={{ flex: 1 }}><View style={{ width: "62%", maxWidth: 220, height: 6, borderRadius: 2, backgroundColor: dividerColor(colors) }} /></View>
    </View>
  </TintedCard>;
  if (data.error !== undefined) return <TintedCard colors={colors} tone="bad" layout={layout}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Pip tone="bad" colors={colors} />
      <Text numberOfLines={1} style={{ ...typeStyle(layout.platform, "title"), flex: 1, minWidth: 0, color: colors.foreground }}>
        <Text style={headStyle}>{(data.call ?? "meantime").split(" ")[0]}</Text><Text style={{ color: secondaryColor(colors) }}>{(data.call ?? "meantime").replace(/^\S+/, "")}</Text>
      </Text>
      <Text style={{ ...typeStyle(layout.platform, "meta"), color: toneColor("bad", colors) }}>failed</Text>
    </View>
    <StatusRule colors={colors} />
    <Text selectable style={{ ...typeStyle(layout.platform, "body"), color: colors.foreground }}>{data.error}</Text>
  </TintedCard>;
  if (data.source === "meantime" && data.action === "wait" && data.tasks.length === 0) {
    const tone = data.waitOutcome === "interrupted" ? "neutral" : "run";
    return <TintedCard colors={colors} tone={tone} layout={layout}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pip tone={tone} colors={colors} />
        <Text style={{ ...typeStyle(layout.platform, "title", true), flex: 1, color: colors.foreground }}>All pending tasks</Text>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
          {data.total !== undefined ? <Text style={{ ...typeStyle(layout.platform, "meta"), color: secondaryColor(colors) }}>{data.total} tasks</Text> : null}
          {data.waitOutcome ? <Text style={{ ...typeStyle(layout.platform, "meta"), color: toneColor(tone, colors) }}>{data.waitOutcome}</Text> : null}
          {data.waitedSeconds !== undefined ? <Text style={{ ...typeStyle(layout.platform, "meta"), color: frameColor(colors) }}>waited <Text style={{ color: secondaryColor(colors) }}>{formatSeconds(data.waitedSeconds)}</Text></Text> : null}
        </View>
      </View>
    </TintedCard>;
  }
  if (data.source === "meantime" && data.action === "list") return <ListCard data={data} colors={colors} layout={layout} />;
  const tasks = data.source === "handle" ? data.tasks.map(task => task.state === "running" ? { ...task, state: "started" } : task) : data.tasks;
  return <TaskTable tasks={tasks} colors={colors} layout={layout} waitOutcome={data.waitOutcome} waitedSeconds={data.waitedSeconds} />;
}

/** Lists and the board share a heading, summary, divided rows and drawers. */
export function ListCard({ data, colors, layout, defaultOpen = false, openTask = false, hint }: { data: MeantimeCardData; colors: Colors; layout: Layout; defaultOpen?: boolean; openTask?: boolean; hint?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  if (data.tasks.length === 0) return <Card colors={colors} layout={layout}><Text style={{ ...typeStyle(layout.platform, "title", true), color: colors.foreground }}>No background tasks</Text></Card>;
  const groups = ([['run', 'active'], ['ok', '✓'], ['bad', '✕'], ['neutral', 'other']] as const)
    .map(([tone, label]) => ({ tone, label, count: data.tasks.filter(task => (isActiveTask(task) ? 'run' : taskTone(task)) === tone).length })).filter(group => group.count);
  const more = data.total !== undefined && data.moreOffset !== undefined ? Math.max(0, data.total - data.moreOffset) : 0;
  const divider = { borderTopWidth: 0.5, borderTopColor: dividerColor(colors) };
  const footer = { ...typeStyle(layout.platform, "meta"), paddingVertical: 8, color: frameColor(colors), ...divider };
  return <Card colors={colors} layout={layout} grouped>
    <Pressable onPress={() => setOpen(prev => !prev)} accessibilityRole="button" accessibilityLabel="Background tasks" style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 }}>
      <Text style={{ ...typeStyle(layout.platform, "title", true), flex: 1, minWidth: 0, color: colors.foreground }}>Background tasks</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {groups.map(group => <Text key={group.tone} style={{ ...typeStyle(layout.platform, "meta"), color: toneColor(group.tone, colors) }}>{group.count} {group.label}</Text>)}
        <Icon name={open ? "ChevronUp" : "ChevronDown"} size={12} color={frameColor(colors)} />
      </View>
    </Pressable>
    {open ? <>
      {data.tasks.map(task => <View key={task.id} style={divider}><TaskLine task={task} colors={colors} layout={layout} grouped defaultOpen={openTask} /></View>)}
      {more > 0 ? <Text style={footer}>+{more} more</Text> : null}
      {hint && data.tasks.some(isActiveTask) ? <Text style={footer}>{hint}</Text> : null}
    </> : null}
  </Card>;
}
