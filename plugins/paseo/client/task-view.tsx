import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { Animated, Easing, Pressable, ScrollView, Text, View } from "react-native";
import type { TaskSummary } from "../shared/tasks.js";
import { isActiveTask } from "../shared/tasks.js";
import { Card } from "./card.js";
import { CODE_FONT_SIZE, CODE_LINE_HEIGHT, dividerColor, doneColor, formatElapsed, frameColor, isDarkSurface, mixColor, monoFont, secondaryColor, stateColor, stateText, taskStateLabel } from "./rows.js";

type Colors = PluginTheme["colors"];
type Layout = { compact: boolean; platform: "ios" | "android" | "web" };

type Animation = { start(): void; stop(): void };
type AnimatedValue = { setValue(value: number): void };
type TimingConfig = { toValue: number; duration: number; useNativeDriver: boolean; easing?: unknown };
type EasingRuntime = { sin: unknown; inOut(easing: unknown): unknown };
type AnimatedRuntime = {
  View?: ComponentType<{ style?: unknown; children?: ReactNode }>;
  Value?: new (value: number) => AnimatedValue;
  timing?: (value: AnimatedValue, config: TimingConfig) => Animation;
  sequence?: (animations: Animation[]) => Animation;
  loop?: (animation: Animation) => Animation;
};

/** The host injects `Animated`; keep it optional so a stub without
 * `Animated.View` / `Animated.loop` still renders the dot as static ink. */
const ANIMATED = Animated as unknown as AnimatedRuntime;
const PulseView = ANIMATED.View;
const CAN_ANIMATE = PulseView !== undefined && typeof ANIMATED.Value === "function"
  && typeof ANIMATED.timing === "function";
const CAN_PULSE = CAN_ANIMATE && typeof ANIMATED.loop === "function";
const EASING = Easing as unknown as EasingRuntime | undefined;
/** Smooth in/out when the host ships an easing curve; linear otherwise. */
const BREATHE_EASING = typeof EASING?.inOut === "function" && EASING.sin !== undefined
  ? EASING.inOut(EASING.sin) : undefined;
const BREATHE_MS = 1000;

function leg(target: AnimatedValue, toValue: number): Animation {
  const config: TimingConfig = { toValue, duration: BREATHE_MS, useNativeDriver: false };
  if (BREATHE_EASING !== undefined) config.easing = BREATHE_EASING;
  return (ANIMATED.timing as NonNullable<AnimatedRuntime["timing"]>)(target, config);
}

/** Breathing opacity while a task is live. Created during render so the dot
 * owns its value from the first frame; the effect only decides whether it
 * moves. Two legs — dim then bright — read as breathing; a single leg snaps. */
function usePulse(active: boolean): AnimatedValue | undefined {
  const value = useRef<AnimatedValue | undefined>(undefined);
  const Value = ANIMATED.Value;
  if (active && CAN_PULSE && Value !== undefined && value.current === undefined) value.current = new Value(1);
  useEffect(() => {
    const target = value.current;
    const { timing, loop, sequence } = ANIMATED;
    if (!active || target === undefined || timing === undefined || loop === undefined) return;
    const cycle = typeof sequence === "function"
      ? sequence([leg(target, 0.35), leg(target, 1)])
      : leg(target, 0.35);
    const breathe = loop(cycle);
    breathe.start();
    return () => { breathe.stop(); target.setValue(1); };
  }, [active]);
  return value.current;
}

/** Fade the drawer in on mount. Height is never animated: the drawer settles
 * in one layout pass and only its ink fades, so the timeline cannot jump. */
function useFadeIn(): AnimatedValue | undefined {
  const value = useRef<AnimatedValue | undefined>(undefined);
  const Value = ANIMATED.Value;
  if (value.current === undefined && CAN_ANIMATE && Value !== undefined) value.current = new Value(0);
  useEffect(() => {
    const target = value.current;
    const { timing } = ANIMATED;
    if (target === undefined || timing === undefined) return;
    const fade = timing(target, { toValue: 1, duration: 140, useNativeDriver: false });
    fade.start();
    return () => fade.stop();
  }, []);
  return value.current;
}

/**
 * Status glyph: semantic marks instead of one anonymous dot. Solid dot breathes
 * for a live process, hollow ring when parked (waiting/queued/cancel
 * requested) with steady ink. Check and cross for terminal outcomes. Fixed slot
 * keeps every row's command edge aligned.
 */
export function TaskGlyph({ task, colors }: { task: Pick<TaskSummary, "state">; colors: Colors }) {
  const parked = task.state === "waiting" || task.state === "queued" || task.state === "cancel_requested";
  const pulse = usePulse(isActiveTask(task) && !parked);
  const slot = { width: 12, height: CODE_LINE_HEIGHT, alignItems: "center" as const, justifyContent: "center" as const };
  const mark = (glyph: string, color: string) => (
    <View style={slot}><Text style={{ fontSize: 10, lineHeight: CODE_LINE_HEIGHT, color }}>{glyph}</Text></View>
  );
  if (task.state === "completed") return mark("✓", doneColor(colors));
  if (task.state === "failed") return mark("✕", stateColor(task.state, colors));
  if (task.state === "cancelled") return mark("✕", secondaryColor(colors));
  // Parked states fall through to the ring below; anything else we cannot read
  // stays an honest question mark rather than a fabricated status.
  if (!isActiveTask(task) && !parked) return mark("?", frameColor(colors));
  const accent = stateColor(task.state, colors);
  const glow = !parked && isDarkSurface(colors)
    ? { shadowColor: accent, shadowOpacity: 0.9, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } } : null;
  const dot = { width: 6, height: 6, borderRadius: 3, borderWidth: parked ? 1.5 : 0,
    borderColor: accent, backgroundColor: parked ? "transparent" : accent, ...glow };
  return (
    <View style={slot}>
      {pulse !== undefined && PulseView !== undefined
        ? <PulseView style={{ ...dot, opacity: pulse }} />
        : <View style={dot} />}
    </View>
  );
}

/** The collapsed row is one line: preserved newlines in `task.command` collapse
 * to spaces here, while the expanded drawer shows the command as written. */
export function TaskCommand({ task, colors, layout }: { task: TaskSummary; colors: Colors; layout: Layout }) {
  const command = task.command?.replace(/\s+/g, " ").trim() || undefined;
  // Env assignments belong with the command word; only arguments stay muted.
  const head = command === undefined ? undefined : /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*\S+/.exec(command)?.[0];
  const tail = command === undefined ? "" : command.slice(head?.length ?? 0);
  return (
    <Text numberOfLines={1} style={{ minWidth: 0, color: colors.foreground,
      fontFamily: monoFont(layout.platform), fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT }}>
      {command ? <>{head}<Text style={{ color: secondaryColor(colors) }}>{tail}</Text></>
        : <Text style={{ color: secondaryColor(colors) }}>{task.tool ?? task.id}</Text>}
    </Text>
  );
}

/**
 * Command first; status and elapsed are trailing facts. Task ids are shown only
 * where the user can act on them (the board), not as timeline decoration.
 * Details expand in place under the row — a press never covers the timeline.
 * Notes sit in the command column so they share its left edge without an
 * indent constant.
 */
export function TaskLine({ task, colors, layout, showId, status = stateText(task.state), note, waitStatus, defaultOpen = false }: {
  task: TaskSummary; colors: Colors; layout: Layout; showId?: boolean; status?: string; note?: string;
  waitStatus?: string; defaultOpen?: boolean;
}) {
  const mono = monoFont(layout.platform);
  const muted = secondaryColor(colors);
  // One type size for everything secondary; the lamp is the only colored
  // channel, so status and elapsed stay quiet neutrals.
  const meta = { fontSize: 12, lineHeight: 16, color: muted };
  const elapsed = formatElapsed(task);
  const [open, setOpen] = useState(defaultOpen);
  const hasNotes = note !== undefined || [task.progress, task.outputPath,
    task.cancelRequested && task.state !== "cancel_requested",
    task.recovered, task.isError && task.state !== "failed"].some(Boolean);
  return (
    <View>
      <Pressable onPress={() => setOpen(prev => !prev)} accessibilityRole="button" accessibilityLabel={taskStateLabel(task)}
        style={state => {
          const hovered = (state as { hovered?: boolean }).hovered;
          return { backgroundColor: hovered ? mixColor(colors.surface1, colors.surface0, 0.25) : "transparent",
            opacity: state.pressed ? 0.85 : 1 };
        }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10 }}>
        <TaskGlyph task={task} colors={colors} />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <TaskCommand task={task} colors={colors} layout={layout} />
          {note ? <Text numberOfLines={1} style={{ ...meta, fontFamily: mono, fontSize: 11 }}>{note}</Text> : null}
          {hasNotes ? <TaskNotes task={task} colors={colors} layout={layout} /> : null}
        </View>
        {showId ? (
          <Text accessibilityLabel={task.id} selectable style={{ ...meta, fontFamily: mono, fontSize: 11, opacity: 0.7 }} numberOfLines={1}>
            {task.id.replace(/^mt_/, "").slice(0, 4)}
          </Text>
        ) : null}
        {elapsed ? <Text style={{ ...meta, fontVariant: ["tabular-nums"], letterSpacing: 0.2 }} numberOfLines={1}>{elapsed}</Text> : null}
        <Text accessibilityLabel={taskStateLabel(task)} style={{ ...meta, letterSpacing: 0.2 }} numberOfLines={1}>
          {status}
        </Text>
      </View>
      </Pressable>
      {open ? <TaskDetailInline task={task} colors={colors} layout={layout} waitStatus={waitStatus} /> : null}
    </View>
  );
}

/** The inset surface that code blocks sit on — one step off the drawer. */
function codeSurface(colors: Colors) {
  return { backgroundColor: mixColor(colors.surface1, colors.surface0, 0.6), borderRadius: 6,
    paddingHorizontal: 10, paddingVertical: 8 };
}

/** Inset drawer under the row: one block tells the story — command in,
 * output out, bookkeeping in one dim line. Same card, no overlay. Labels sit
 * tight to their block and sections are separated by air; the output tail
 * scrolls inside a bounded box so a noisy log cannot grow the timeline. */
export function TaskDetailInline({ task, colors, layout, waitStatus }: {
  task: TaskSummary; colors: Colors; layout: Layout; waitStatus?: string;
}) {
  const mono = monoFont(layout.platform);
  const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour12: false });
  const meta = [
    formatElapsed(task),
    task.id,
    task.createdAt !== undefined && task.endedAt !== undefined
      ? `${clock(task.createdAt)} → ${clock(task.endedAt)}`
      : task.createdAt !== undefined ? `started ${clock(task.createdAt)}` : undefined,
    task.recovered ? "recovered" : undefined,
    task.isError && task.state !== "failed" ? "error reported" : undefined,
  ].filter(Boolean).join(" · ");
  const tail = task.outputTail?.trimEnd();
  const fade = useFadeIn();
  const drawer = { borderTopWidth: 1, borderTopColor: dividerColor(colors), backgroundColor: colors.surface0,
    borderBottomLeftRadius: 9, borderBottomRightRadius: 9,
    paddingHorizontal: 14, paddingVertical: 12, gap: 12 };
  const body = <>
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Text style={{ color: secondaryColor(colors), fontSize: 11 }}>Command</Text>
        {waitStatus ? <Text style={{ color: secondaryColor(colors), fontSize: 11 }}>{waitStatus}</Text> : null}
      </View>
      <View style={codeSurface(colors)}>
        <Text selectable style={{ color: colors.foreground, fontFamily: mono, fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT }}>
          {task.command ?? task.tool ?? task.id}
        </Text>
      </View>
    </View>
    {tail ? <View style={{ gap: 4 }}>
      <Text style={{ color: secondaryColor(colors), fontSize: 11 }}>Output tail</Text>
      <ScrollView style={{ ...codeSurface(colors), maxHeight: 220 }}>
        <Text selectable style={{ color: colors.foreground, fontFamily: mono, fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT }}>{tail}</Text>
      </ScrollView>
    </View> : null}
    {meta ? <Text selectable style={{ color: secondaryColor(colors), fontFamily: mono, fontSize: 11, lineHeight: 18 }}>{meta}</Text> : null}
    {task.outputPath ? (
      <Text selectable style={{ color: colors.foreground, fontFamily: mono, fontSize: 11, lineHeight: 18 }}>
        Output file: {task.outputPath}
      </Text>
    ) : null}
  </>;
  return fade !== undefined && PulseView !== undefined
    ? <PulseView style={{ ...drawer, opacity: fade }}>{body}</PulseView>
    : <View style={drawer}>{body}</View>;
}

/** Preserve real task annotations without displacing the command. No synthetic progress. */
export function TaskNotes({ task, colors, layout }: { task: TaskSummary; colors: Colors; layout: Layout }) {
  const notes = [task.progress, task.outputPath,
    task.cancelRequested && task.state !== "cancel_requested" ? "cancel requested" : undefined,
    task.recovered ? "recovered" : undefined,
    task.isError && task.state !== "failed" ? "error reported" : undefined];
  return <>{notes.filter(Boolean).map((note, index) => (
    <Text key={index} numberOfLines={1} style={{ color: secondaryColor(colors), fontSize: 11,
      lineHeight: 16, fontFamily: monoFont(layout.platform) }}>{note}</Text>
  ))}</>;
}

export function TaskTable({ tasks, colors, layout, showId, status }: {
  tasks: readonly TaskSummary[]; colors: Colors; layout: Layout; showId?: boolean;
  status?: (task: TaskSummary) => string;
}) {
  const divider = dividerColor(colors);
  return (
    <Card colors={colors}>
      {tasks.map((task, index) => (
        <View key={task.id} style={index > 0
          ? { borderTopWidth: 1, borderTopColor: divider } : undefined}>
          <TaskLine task={task} colors={colors} layout={layout} showId={showId}
            status={status?.(task)} />
        </View>
      ))}
    </Card>
  );
}
