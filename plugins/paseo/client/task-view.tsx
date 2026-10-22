import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { TaskSummary } from "../shared/tasks.js";
import { isActiveTask } from "../shared/tasks.js";
import { Card } from "./card.js";
import { CODE_FONT_SIZE, CODE_LINE_HEIGHT, dividerColor, doneColor, formatElapsed, frameColor, isDarkSurface, mixColor, monoFont, secondaryColor, stateColor, stateText, taskStateLabel } from "./rows.js";

type Colors = PluginTheme["colors"];
type Layout = { compact: boolean; platform: "ios" | "android" | "web" };

/**
 * Status glyph: semantic marks instead of one anonymous dot. Solid dot for a
 * live process, hollow ring when parked (waiting/queued), check and cross for
 * terminal outcomes. Fixed slot keeps every row's command edge aligned.
 */
export function TaskGlyph({ task, colors }: { task: TaskSummary; colors: Colors }) {
  const slot = { width: 12, height: CODE_LINE_HEIGHT, alignItems: "center" as const, justifyContent: "center" as const };
  const mark = (glyph: string, color: string) => (
    <View style={slot}><Text style={{ fontSize: 10, lineHeight: CODE_LINE_HEIGHT, color }}>{glyph}</Text></View>
  );
  if (task.state === "completed") return mark("✓", doneColor(colors));
  if (task.state === "failed") return mark("✕", stateColor(task.state, colors));
  if (task.state === "cancelled") return mark("✕", secondaryColor(colors));
  if (!isActiveTask(task)) return mark("?", frameColor(colors));
  const accent = stateColor(task.state, colors);
  const parked = task.state === "waiting" || task.state === "queued" || task.state === "cancel_requested";
  const glow = !parked && isDarkSurface(colors)
    ? { shadowColor: accent, shadowOpacity: 0.9, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } } : null;
  return (
    <View style={slot}>
      <View style={{ width: 6, height: 6, borderRadius: 3, borderWidth: parked ? 1.5 : 0,
        borderColor: accent, backgroundColor: parked ? "transparent" : accent, ...glow }} />
    </View>
  );
}

export function TaskCommand({ task, colors, layout }: { task: TaskSummary; colors: Colors; layout: Layout }) {
  const command = task.command;
  const split = command?.search(/\s/);
  const head = command && split !== undefined && split >= 0 ? command.slice(0, split) : command;
  const tail = command && split !== undefined && split >= 0 ? command.slice(split) : "";
  return (
    <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.foreground,
      fontFamily: monoFont(layout.platform), fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT }}>
      {command ? <>{head}<Text style={{ color: secondaryColor(colors) }}>{tail}</Text></>
        : <Text style={{ color: secondaryColor(colors) }}>{task.tool ?? task.id}</Text>}
    </Text>
  );
}

/**
 * Command first; status and elapsed are trailing facts. Task ids are shown only
 * where the user can act on them (the board), not as timeline decoration.
 */
export function TaskLine({ task, colors, layout, showId, status = stateText(task.state), note, waitStatus }: {
  task: TaskSummary; colors: Colors; layout: Layout; showId?: boolean; status?: string; note?: string; waitStatus?: string;
}) {
  const mono = monoFont(layout.platform);
  const muted = secondaryColor(colors);
  // One type size for everything secondary; the lamp is the only colored
  // channel, so status and elapsed stay quiet neutrals.
  const meta = { fontSize: 12, lineHeight: 16, color: muted };
  const elapsed = formatElapsed(task);
  const [open, setOpen] = useState(false);
  const hasNotes = note !== undefined || [task.progress, task.outputPath,
    task.cancelRequested && task.state !== "cancel_requested",
    task.recovered, task.isError && task.state !== "failed"].some(Boolean);
  return (
    <View>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={taskStateLabel(task)}
        style={state => {
          const hovered = (state as { hovered?: boolean }).hovered;
          return { backgroundColor: hovered ? mixColor(colors.surface1, colors.surface0, 0.25) : "transparent",
            opacity: state.pressed ? 0.85 : 1 };
        }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12,
        paddingTop: 9, paddingBottom: hasNotes ? 3 : 9 }}>
        <TaskGlyph task={task} colors={colors} />
        <TaskCommand task={task} colors={colors} layout={layout} />
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
      {hasNotes ? (
        <View style={{ paddingLeft: 34, paddingRight: 12, paddingBottom: 9 }}>
          {note ? <Text numberOfLines={1} style={{ ...meta, fontFamily: mono, fontSize: 11 }}>{note}</Text> : null}
          <TaskNotes task={task} colors={colors} layout={layout} />
        </View>
      ) : null}
      </Pressable>
      {open ? <TaskDetailModal task={task} colors={colors} layout={layout} waitStatus={waitStatus} onClose={() => setOpen(false)} /> : null}
    </View>
  );
}

/** v12 / A Terminal replay: one block tells the story — `$ command` in,
 * output out. State lives in the sheet title, bookkeeping in one dim line. */
export function TaskDetailModal({ task, colors, layout, waitStatus, onClose }: {
  task: TaskSummary; colors: Colors; layout: Layout; waitStatus?: string; onClose(): void;
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
  return (
    <Modal title={waitStatus === "Waiting" ? "Waiting for task" : "Task snapshot"} open onOpenChange={next => { if (!next) onClose(); }}>
      <Modal.Content contentContainerStyle={{ padding: 20, gap: 20 }}>
        <View style={{ gap: 20 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <Text style={{ fontSize: 12, color: secondaryColor(colors) }}>Meantime</Text>
            <Text style={{ fontSize: 12, color: secondaryColor(colors) }}>{waitStatus ?? stateText(task.state)}</Text>
          </View>
          <View style={{ backgroundColor: colors.surface0, borderRadius: 8, borderWidth: 1, borderColor: colors.border, padding: 16, gap: 8 }}>
            <Text style={{ color: secondaryColor(colors), fontSize: 11 }}>Command</Text>
            <Text selectable style={{ color: colors.foreground, fontFamily: mono, fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT }}>
              {task.command ?? task.tool ?? task.id}
            </Text>
          </View>
          <View style={{ gap: 8 }}>
            <Text style={{ color: secondaryColor(colors), fontSize: 11 }}>Output tail</Text>
            <Text selectable style={{ color: task.outputTail ? colors.foreground : secondaryColor(colors),
              fontFamily: mono, fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT }}>{task.outputTail?.trimEnd() || "No output included"}</Text>
          </View>
          <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 16, gap: 8 }}>
            {waitStatus !== "Waiting" ? <Text style={{ color: secondaryColor(colors), fontSize: 12 }}>As reported at the time</Text> : null}
            <Text selectable style={{ color: secondaryColor(colors), fontFamily: mono, fontSize: 11,
              lineHeight: 18 }}>{meta}</Text>
            {task.outputPath ? <View style={{ gap: 4 }}>
              <Text style={{ color: secondaryColor(colors), fontSize: 11 }}>Output file</Text>
              <Text selectable style={{ color: colors.foreground, fontFamily: mono, fontSize: 11, lineHeight: 18 }}>{task.outputPath}</Text>
            </View> : null}
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
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
    <View style={{ marginTop: 4 }}>
      <Card colors={colors}>
        {tasks.map((task, index) => (
          <View key={task.id} style={index > 0
            ? { borderTopWidth: 1, borderTopColor: divider } : undefined}>
            <TaskLine task={task} colors={colors} layout={layout} showId={showId}
              status={status?.(task)} />
          </View>
        ))}
      </Card>
    </View>
  );
}
