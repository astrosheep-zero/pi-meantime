import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View, type TextStyle, type ViewStyle } from "react-native";
import type { TaskSummary } from "../shared/tasks.js";
import { elapsedSeconds, isActiveTask, outputPreview } from "../shared/tasks.js";
import { TintedCard, taskTone, toneColor, toneRgb, type Tone, type WaitOutcome } from "./card.js";
import { CODE_FONT_SIZE, CODE_LINE_HEIGHT, dividerColor, doneColor, formatSeconds, frameColor, isDarkSurface, monoFont, secondaryColor, stateColor, stateText, taskStateLabel } from "./rows.js";

type Colors = PluginTheme["colors"];
type Layout = { compact: boolean; platform: "ios" | "android" | "web" };

/** The status lamp: one dot, breathing halo while live, locked solid when settled. */export function Pip({ tone, colors }: { tone: Tone; colors: Colors }) {
  const rgb = toneRgb(tone, colors);
  const halo = tone === "run" ? `0 0 0 3px rgba(${rgb},0.12)` : `0 0 0 2.5px rgba(${rgb},0.09)`;
  return <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: toneColor(tone, colors), boxShadow: halo }} />;
}

export function TaskCommand({ task, colors, quiet = false }: { task: TaskSummary; colors: Colors; quiet?: boolean }) {
  // The header is always one flattened line; a multi-line script unfolds in the drawer.
  const raw = task.command?.trim() || undefined;
  const command = raw?.replace(/\s+/g, " ");
  const head = command === undefined ? undefined : /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*\S+/.exec(command)?.[0];
  const argColor = isDarkSurface(colors) ? "#9ca3ad" : secondaryColor(colors);
  const base = quiet ? argColor : colors.foreground;
  return <Text numberOfLines={1} style={{ minWidth: 0, fontSize: 13, lineHeight: 17, letterSpacing: -0.2, color: base, fontWeight: "600" }}>
    {command ? <>{head}<Text style={{ color: argColor, fontWeight: "400" }}>{command.slice(head?.length ?? 0)}</Text></> : <>{task.tool ?? "task"}<Text style={{ color: frameColor(colors), fontWeight: "400" }}> {task.id}</Text></>}
  </Text>;
}

/** Ticking clock for live tasks. Local interval: only the label re-renders. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** The right-hand meter: a status word plus tabular time, nothing boxed. */
export function Clock({ task, colors, waitOutcome, waitedSeconds }: { task: TaskSummary; colors: Colors; waitOutcome?: WaitOutcome; waitedSeconds?: number }) {
  const active = isActiveTask(task) || task.state === "queued";
  const tone = taskTone(task, waitOutcome);
  // A handle only proves a task STARTED; ticking from createdAt would lie.
  const tick = active && task.state !== "started" && task.createdAt !== undefined && task.endedAt === undefined;
  const now = useNow(tick);
  const seconds = elapsedSeconds(task, tick ? now : undefined);
  const chip = waitOutcome ?? (task.exitCode !== undefined && task.exitCode !== 0 ? `exit ${task.exitCode}`
    : ["failed", "cancelled", "cancel_requested", "outcome_unknown"].includes(task.state) ? stateText(task.state) : undefined);
  const label = chip ?? stateText(task.state);
  // Only "done" becomes a check; exit codes and failure words are information.
  const glyph = tone === "ok" && chip === undefined ? "✓" : undefined;
  const dark = isDarkSurface(colors);
  const labelColor = tone === "neutral" ? secondaryColor(colors) : toneColor(tone, colors);
  const meta: TextStyle = { fontSize: 11.5, lineHeight: 16, fontVariant: ["tabular-nums"] };
  return <View style={{ flexDirection: "row", alignItems: "baseline", gap: 5 }}>
    {glyph
      ? <Text style={{ ...meta, fontWeight: "600", color: labelColor }}>{glyph}</Text>
      : <Text style={{ ...meta, fontWeight: "500", color: labelColor }}>{label}</Text>}
    {waitOutcome && waitedSeconds !== undefined
      ? <Text numberOfLines={1} style={{ ...meta, color: dark ? "#6b727b" : secondaryColor(colors) }}>waited <Text style={{ ...meta, fontWeight: "600", color: dark ? "#cbd0d6" : colors.foreground }}>{formatSeconds(waitedSeconds)}</Text></Text>
      : seconds !== undefined
        ? <Text numberOfLines={1} style={{ ...meta, fontWeight: "600", color: labelColor }}>{formatSeconds(seconds)}</Text>
        : null}
  </View>;
}

export function StatusRule({ colors }: { colors: Colors }) {
  return <View style={{ height: 0.5, marginTop: 6, marginBottom: 5.5, backgroundColor: dividerColor(colors) }} />;
}

function taskOutput(task: TaskSummary): string {
  const source = task.output ?? task.outputTail ?? task.progress;
  return outputPreview(source ?? "").replace(/^\n+|\s+$/g, "");
}

/** Result marks keep text presentation: iOS turns bare ℹ/✔/✖ into emoji. */
const TEXT_STYLE = "\uFE0E";
function FormattedOutput({ output, colors, layout }: { output: string; colors: Colors; layout: Layout }) {
  const dark = isDarkSurface(colors), parts = output.split(/(^(?:[ \t]*)(?:ℹ|✔|✖))/m);
  const bodyColor = dark ? "#a8aeb7" : secondaryColor(colors);
  const infoColor = dark ? "#5f666f" : frameColor(colors);
  return <Text selectable style={{ color: bodyColor, fontFamily: monoFont(layout.platform), fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT }}>{parts.map((part, i) => {
    const match = /^([ \t]*)([ℹ✔✖])$/.exec(part);
    return match ? <Text key={i}>{match[1]}<Text style={{ color: match[2] === "✔" ? doneColor(colors) : match[2] === "✖" ? stateColor("failed", colors) : infoColor }}>{match[2]}{TEXT_STYLE}</Text></Text> : part;
  })}</Text>;
}

export function TaskLine({ task, colors, layout, showId, muted: quiet = false, defaultOpen = false, waitOutcome, waitedSeconds }: { task: TaskSummary; colors: Colors; layout: Layout; showId?: boolean; muted?: boolean; defaultOpen?: boolean; waitOutcome?: WaitOutcome; waitedSeconds?: number }) {
  const active = isActiveTask(task) || task.state === "queued";
  const effectiveWaitOutcome = active ? waitOutcome : undefined;
  const [open, setOpen] = useState(defaultOpen), tone = taskTone(task, effectiveWaitOutcome), mono = monoFont(layout.platform), dark = isDarkSurface(colors);
  // Collapsed cards are one uniform line everywhere; output lives in the drawer.
  const output = open ? taskOutput(task) : "";
  const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour12: false });
  const footerParts = [task.id, task.createdAt !== undefined && task.endedAt !== undefined ? `${clock(task.createdAt)} → ${clock(task.endedAt)}` : task.createdAt !== undefined ? `started ${clock(task.createdAt)}` : undefined, task.recovered ? "recovered" : undefined, task.isError && task.state !== "failed" ? "error reported" : undefined, task.outputPath].filter((x): x is string => Boolean(x));
  const chevColor = dark ? "#5e646d" : frameColor(colors);
  const idTag = showId ? <Text accessibilityLabel={task.id} selectable numberOfLines={1} style={{ color: chevColor, fontSize: 11, lineHeight: 16, fontVariant: ["tabular-nums"] }}>{task.id.replace(/^mt_/, "").slice(0, 4)}</Text> : null;

  return <View>
    <Pressable onPress={() => setOpen(prev => !prev)} accessibilityRole="button" accessibilityLabel={taskStateLabel(task)}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pip tone={tone} colors={colors} />
        <View style={{ flex: 1, minWidth: 0 }}><TaskCommand task={task} colors={colors} quiet={quiet && tone === "ok"} /></View>
        {idTag}
        <Clock task={task} colors={colors} waitOutcome={effectiveWaitOutcome} waitedSeconds={waitedSeconds} />
        <Icon name={open ? "ChevronUp" : "ChevronDown"} size={11} color={chevColor} />
      </View>
      {open ? <StatusRule colors={colors} /> : null}
      {open ? (
        // Same bounded drawer as Square's message card: a bare ScrollView with
        // maxHeight + nestedScrollEnabled; no wrapper (the wrapper was a guess).
        <ScrollView style={{ maxHeight: layout.compact ? 240 : 360, marginTop: 2 }} nestedScrollEnabled>
          {task.command?.includes("\n") ? <Text selectable style={{ color: dark ? "#a8aeb7" : secondaryColor(colors), fontFamily: mono, fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT }}>{task.command.trim()}</Text> : null}
          {task.command?.includes("\n") && output ? <StatusRule colors={colors} /> : null}
          {output ? <FormattedOutput output={output} colors={colors} layout={layout} /> : null}
        </ScrollView>
      ) : output ? <FormattedOutput output={output} colors={colors} layout={layout} /> : null}
      {open ? <Text selectable style={{ marginTop: output ? 6.5 : 1.5, color: dark ? "#565d66" : frameColor(colors), fontFamily: mono, fontSize: 10, lineHeight: 14, fontVariant: ["tabular-nums"] }}>
        {footerParts.flatMap((part, i) => i > 0 ? [<Text key={i} style={{ color: dark ? "#383d45" : dividerColor(colors) }}>{" · "}</Text>, part] : [part])}
      </Text> : null}
    </Pressable>
  </View>;
}

/** Every task gets the same glass card; the corner wash carries the tone. */
export function TaskTable({ tasks, colors, layout, showId, waitOutcome, waitedSeconds }: { tasks: readonly TaskSummary[]; colors: Colors; layout: Layout; showId?: boolean; waitOutcome?: WaitOutcome; waitedSeconds?: number }) {
  return <View style={{ gap: 8 }}>{tasks.map(task => {
    const active = isActiveTask(task) || task.state === "queued";
    return <TintedCard key={task.id} colors={colors} layout={layout} tone={taskTone(task, active ? waitOutcome : undefined)}><TaskLine task={task} colors={colors} layout={layout} showId={showId} waitOutcome={waitOutcome} waitedSeconds={waitedSeconds} /></TintedCard>;
  })}</View>;
}
