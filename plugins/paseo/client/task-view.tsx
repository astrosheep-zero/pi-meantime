import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { TaskSummary } from "../shared/tasks.js";
import { elapsedSeconds, isActiveTask, outputPreview, taskCommand } from "../shared/tasks.js";
import { Card, TintedCard, taskTone, toneColor, toneRgb, type Tone, type WaitOutcome } from "./card.js";
import { dividerColor, doneColor, formatSeconds, frameColor, secondaryColor, stateColor, stateText, taskStateLabel, typeStyle, headStyle } from "./rows.js";

type Colors = PluginTheme["colors"];
type Layout = { compact: boolean; platform: "ios" | "android" | "web" };

export function Pip({ tone, colors }: { tone: Tone; colors: Colors }) {
  const rgb = toneRgb(tone, colors);
  const halo = tone === "run" ? `0 0 0 2px rgba(${rgb},0.14), 0 0 5px rgba(${rgb},0.3)` : `0 0 5px rgba(${rgb},0.3)`;
  return <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toneColor(tone, colors), boxShadow: halo }} />;
}

export function TaskCommand({ task, colors, layout }: { task: TaskSummary; colors: Colors; layout: Layout }) {
  const raw = taskCommand(task), parts = raw?.split("\n");
  const command = parts?.[0]?.replace(/\s+/g, " ").trim();
  const title = task.command === undefined ? [task.tool ?? "task", command].filter(Boolean).join(" ") : command ?? task.tool ?? "task";
  const head = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*\S+/.exec(title)?.[0] ?? "";
  const muted = secondaryColor(colors);
  return <View style={{ flexDirection: "row", alignItems: "baseline", minWidth: 0 }}>
    <Text numberOfLines={1} style={{ ...typeStyle(layout.platform, "title"), flexShrink: 1, minWidth: 0, color: colors.foreground }}>
      <Text style={headStyle}>{head}</Text><Text style={{ color: muted }}>{title.slice(head.length)}</Text>
    </Text>
    {parts && parts.length > 1 ? <Text style={{ ...typeStyle(layout.platform, "meta"), flexShrink: 0, color: frameColor(colors) }}> +{parts.length - 1} lines</Text> : null}
  </View>;
}
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
  return now;
}
export function Clock({ task, colors, layout, waitOutcome, waitedSeconds }: { task: TaskSummary; colors: Colors; layout: Layout; waitOutcome?: WaitOutcome; waitedSeconds?: number }) {
  const tone = taskTone(task, waitOutcome);
  const tick = isActiveTask(task) && task.state !== "started" && task.createdAt !== undefined && task.endedAt === undefined;
  const now = useNow(tick), seconds = task.state === "started" ? undefined : elapsedSeconds(task, tick ? now : undefined);
  const chip = waitOutcome ?? (task.exitCode !== undefined && task.exitCode !== 0 ? `exit ${task.exitCode}`
    : ["failed", "cancelled", "cancel_requested", "outcome_unknown"].includes(task.state) ? stateText(task.state) : undefined);
  const label = tone === "ok" && chip === undefined ? "✓" : chip ?? stateText(task.state);
  const meta = typeStyle(layout.platform, "meta");
  return <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
    {label ? <Text style={{ ...meta, color: toneColor(tone, colors) }}>{label}</Text> : null}
    {waitOutcome && waitedSeconds !== undefined
      ? <Text numberOfLines={1} style={{ ...meta, color: frameColor(colors) }}>waited <Text style={{ color: secondaryColor(colors) }}>{formatSeconds(waitedSeconds)}</Text></Text>
      : seconds !== undefined ? <Text numberOfLines={1} style={{ ...meta, color: secondaryColor(colors) }}>{formatSeconds(seconds)}</Text> : null}
  </View>;
}
export function StatusRule({ colors }: { colors: Colors }) {
  return <View style={{ height: 0.5, marginBottom: 8, backgroundColor: dividerColor(colors) }} />;
}
function taskOutput(task: TaskSummary): string { return outputPreview(task.output ?? task.outputTail ?? task.progress ?? "").replace(/^\n+|\s+$/g, ""); }
const TEXT_STYLE = "\uFE0E";
function FormattedOutput({ output, colors, layout }: { output: string; colors: Colors; layout: Layout }) {
  const parts = output.split(/(^(?:[ \t]*)(?:ℹ|✔|✖))/m);
  return <Text selectable style={{ ...typeStyle(layout.platform, "body"), color: secondaryColor(colors) }}>{parts.map((part, i) => {
    const match = /^([ \t]*)([ℹ✔✖])$/.exec(part);
    return match ? <Text key={i}>{match[1]}<Text style={{ color: match[2] === "✔" ? doneColor(colors) : match[2] === "✖" ? stateColor("failed", colors) : frameColor(colors) }}>{match[2]}{TEXT_STYLE}</Text></Text> : part;
  })}</Text>;
}
export function TaskLine({ task, colors, layout, defaultOpen = false, grouped = false, waitOutcome, waitedSeconds }: { task: TaskSummary; colors: Colors; layout: Layout; defaultOpen?: boolean; grouped?: boolean; waitOutcome?: WaitOutcome; waitedSeconds?: number }) {
  const effectiveWaitOutcome = isActiveTask(task) ? waitOutcome : undefined;
  const [open, setOpen] = useState(defaultOpen), tone = taskTone(task, effectiveWaitOutcome);
  const rawCommand = taskCommand(task), output = open ? taskOutput(task) : "";
  const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour12: false });
  const footerParts = [task.id, task.createdAt !== undefined && task.endedAt !== undefined ? `${clock(task.createdAt)} → ${clock(task.endedAt)}` : task.createdAt !== undefined ? `started ${clock(task.createdAt)}` : undefined, task.outputPath, task.recovered ? "recovered" : undefined, task.isError && task.state !== "failed" ? "error reported" : undefined].filter(Boolean);
  return <View>
    <Pressable onPress={() => setOpen(prev => !prev)} accessibilityRole="button" accessibilityLabel={taskStateLabel(task)}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: grouped ? 8 : 0, gap: 8 }}>
        <Pip tone={tone} colors={colors} />
        <View style={{ flex: 1, minWidth: 0 }}><TaskCommand task={task} colors={colors} layout={layout} /></View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Clock task={task} colors={colors} layout={layout} waitOutcome={effectiveWaitOutcome} waitedSeconds={waitedSeconds} />
          <Icon name={open ? "ChevronUp" : "ChevronDown"} size={12} color={frameColor(colors)} />
        </View>
      </View>
      {open ? <View style={{ paddingBottom: grouped ? 8 : 0 }}>
        <StatusRule colors={colors} />
        <ScrollView style={{ maxHeight: layout.compact ? 240 : 360 }} contentContainerStyle={{ gap: 8 }} nestedScrollEnabled>
          {rawCommand !== undefined && (rawCommand.includes("\n") || rawCommand.length > 60) ? <Text selectable style={{ ...typeStyle(layout.platform, "body"), color: colors.foreground }}>{rawCommand}</Text> : null}
          {output ? <FormattedOutput output={output} colors={colors} layout={layout} /> : null}
        </ScrollView>
        {task.state === "cancel_requested" ? <Text style={{ ...typeStyle(layout.platform, "meta"), marginTop: 8, color: toneColor("run", colors) }}>cancel requested; outcome not settled yet</Text> : null}
        <Text selectable style={{ ...typeStyle(layout.platform, "meta"), marginTop: 8, color: frameColor(colors) }}>{footerParts.join(" · ")}</Text>
      </View> : null}
    </Pressable>
  </View>;
}
/** Wait batches share one panel; each row retains its own status and drawer. */
export function TaskTable({ tasks, colors, layout, waitOutcome, waitedSeconds }: { tasks: readonly TaskSummary[]; colors: Colors; layout: Layout; waitOutcome?: WaitOutcome; waitedSeconds?: number }) {
  const grouped = tasks.length > 1;
  const rows = tasks.map((task, index) => {
    const row = <TaskLine task={task} colors={colors} layout={layout} grouped={grouped} waitOutcome={waitOutcome} waitedSeconds={waitedSeconds} />;
    return grouped ? <View key={task.id} style={index ? { borderTopWidth: 0.5, borderTopColor: dividerColor(colors) } : undefined}>{row}</View>
      : <TintedCard key={task.id} colors={colors} layout={layout} tone={taskTone(task, isActiveTask(task) ? waitOutcome : undefined)}>{row}</TintedCard>;
  });
  return grouped ? <Card colors={colors} layout={layout} grouped>{rows}</Card> : <>{rows}</>;
}
