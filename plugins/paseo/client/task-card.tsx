import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { MeantimeCardData } from "../shared/tasks.js";
import { isActiveTask } from "../shared/tasks.js";
import { Card, TintedCard, toneColor } from "./card.js";
import { meantimeTheme } from "./palette.js";
import { CODE_FONT_SIZE, CODE_LINE_HEIGHT, dividerColor, formatSeconds, frameColor, isDarkSurface, monoFont, secondaryColor } from "./rows.js";
import { Pip, StatusRule, TaskLine, TaskTable } from "./task-view.js";

type Colors = ReturnType<typeof meantimeTheme>["colors"];
type Layout = PluginTimelineItemProps["layout"];

export function MeantimeTaskCard(props: PluginTimelineItemProps<MeantimeCardData>) {
  return <MeantimeTaskCardBody {...props} />;
}

function MeantimeTaskCardBody(props: PluginTimelineItemProps<MeantimeCardData>) {
  const { item, theme, layout } = props;
  const colors = useMemo(() => meantimeTheme(theme).colors, [theme]);
  const outerMuted = secondaryColor(theme.colors);
  const data = item.data;
  if (data.pending) return <WaitSkeleton colors={colors} layout={layout} />;
  if (data.error !== undefined) return <ErrorCard data={data} colors={colors} layout={layout} />;
  if (data.source === "meantime" && data.action === "wait" && data.tasks.length === 0) {
    return <WaitAllCard data={data} colors={colors} layout={layout} />;
  }
  if (data.source === "meantime" && data.action === "list") {
    return (
      <View style={{ gap: 4 }}>
        <ListCard data={data} colors={colors} layout={layout} />
        {data.moreOffset !== undefined ? <Text style={{ color: outerMuted, fontSize: 10,
          fontFamily: monoFont(layout.platform) }}>More tasks not shown (offset {data.moreOffset})</Text> : null}
      </View>
    );
  }
  const tasks = data.source === "handle"
    ? data.tasks.map(task => task.state === "running" ? { ...task, state: "started" } : task)
    : data.tasks;
  return (
    <View style={{ gap: 4 }}>
      <TaskTable tasks={tasks} colors={colors} layout={layout} waitOutcome={data.waitOutcome} waitedSeconds={data.waitedSeconds} />
      {data.moreOffset !== undefined ? <Text style={{ color: outerMuted, fontSize: 10,
        fontFamily: monoFont(layout.platform) }}>More tasks not shown (offset {data.moreOffset})</Text> : null}
    </View>
  );
}

/** A failed meantime call: one bad lamp, the call line, one human sentence. */
function ErrorCard({ data, colors, layout }: { data: MeantimeCardData; colors: Colors; layout: Layout }) {
  const dark = isDarkSurface(colors);
  return (
    <TintedCard colors={colors} tone="bad" layout={layout}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pip tone="bad" colors={colors} />
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.foreground, fontFamily: monoFont(layout.platform), fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT, fontWeight: "600", letterSpacing: -0.1 }}>{data.call ?? "meantime"}</Text>
        <Text style={{ fontSize: 10.5, lineHeight: 16, fontWeight: "500", color: toneColor("bad", colors) }}>failed</Text>
      </View>
      <StatusRule colors={colors} />
      <Text selectable style={{ color: dark ? "#a8aeb7" : secondaryColor(colors), fontFamily: monoFont(layout.platform), fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT }}>{data.error}</Text>
    </TintedCard>
  );
}

/** Wait-all: every pending task is being observed; nothing to list yet. */
function WaitAllCard({ data, colors, layout }: { data: MeantimeCardData; colors: Colors; layout: Layout }) {
  const tone = data.waitOutcome === "interrupted" ? "neutral" : "run";
  const dark = isDarkSurface(colors);
  return (
    <TintedCard colors={colors} tone={tone} layout={layout}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pip tone={tone} colors={colors} />
        <Text style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 13, lineHeight: 17, fontWeight: "600", letterSpacing: -0.2 }}>All pending tasks</Text>
        {data.waitOutcome ? <Text style={{ fontSize: 10.5, lineHeight: 16, fontWeight: "500", color: toneColor(tone, colors) }}>{data.waitOutcome}</Text> : null}
        {data.waitedSeconds !== undefined
          ? <Text numberOfLines={1} style={{ fontSize: 11.5, lineHeight: 16, fontVariant: ["tabular-nums"], color: dark ? "#6b727b" : secondaryColor(colors) }}>waited <Text style={{ fontWeight: "600", color: dark ? "#cbd0d6" : colors.foreground }}>{formatSeconds(data.waitedSeconds)}</Text></Text>
          : null}
      </View>
    </TintedCard>
  );
}

/**
 * The inventory answer: collapsed to one line by default — how many tasks,
 * how many still running, a pip per visible task. Tap to unfold the rows.
 */
export function ListCard({ data, colors, layout, defaultOpen = false, openTask = false }: { data: MeantimeCardData; colors: Colors; layout: Layout; defaultOpen?: boolean; openTask?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const empty = data.tasks.length === 0;
  const running = data.tasks.filter(isActiveTask).length;
  const dark = isDarkSurface(colors);
  const chevColor = dark ? "#5e646d" : frameColor(colors);
  const muted = secondaryColor(colors);
  const divider = dividerColor(colors);
  return (
    <Card colors={colors} layout={layout}>
      <Pressable onPress={() => !empty && setOpen(prev => !prev)} accessibilityRole="button" accessibilityLabel="Background tasks"
        style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 13, lineHeight: 17, fontWeight: "600", letterSpacing: -0.2 }}>
          {empty ? "No background tasks" : "Background tasks"}
        </Text>
        {empty
          ? <Text style={{ fontSize: 11.5, lineHeight: 16, fontVariant: ["tabular-nums"], color: muted }}>none</Text>
          : running > 0
            ? <Text style={{ fontSize: 11.5, lineHeight: 16, fontVariant: ["tabular-nums"], color: muted }}>{running} running</Text>
            : null}
        {!empty ? <Icon name={open ? "ChevronUp" : "ChevronDown"} size={11} color={chevColor} /> : null}
      </Pressable>
      {open ? data.tasks.map((task, index) => (
        <View key={task.id} style={{ paddingVertical: 6, borderTopWidth: 0.5, borderTopColor: divider, marginTop: index === 0 ? 7 : 0 }}>
          <TaskLine task={task} colors={colors} layout={layout} showId muted={!isActiveTask(task)} defaultOpen={openTask} />
        </View>
      )) : null}
    </Card>
  );
}

function WaitSkeleton({ colors, layout }: { colors: Colors; layout: Layout }) {
  return <TintedCard colors={colors} tone="run" layout={layout}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Pip tone="run" colors={colors} />
      <View style={{ flex: 1, height: CODE_LINE_HEIGHT, justifyContent: "center" }}>
        <View style={{ width: "62%", maxWidth: 220, height: 6, borderRadius: 2, backgroundColor: dividerColor(colors) }} />
      </View>
      <Icon name="ChevronDown" size={11} color="#5e646d" />
    </View>
  </TintedCard>;
}
