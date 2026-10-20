import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { TaskSummary } from "../shared/tasks.js";
import { isActiveTask } from "../shared/tasks.js";
import { CODE_FONT_SIZE, CODE_LINE_HEIGHT, doneColor, formatElapsed, frameColor, isDarkSurface, monoFont, secondaryColor, stateColor, stateText, taskStateLabel } from "./rows.js";

type Colors = PluginTheme["colors"];
type Layout = { compact: boolean; platform: "ios" | "android" | "web" };

/**
 * v10 / 01 Pilot lamp: no frame. A static lamp leads each row: lit amber for active
 * (glowing only on dark surfaces), red for failed, quiet green for completed,
 * dim for the rest. Never animated.
 */
export function TaskLamp({ task, colors }: { task: TaskSummary; colors: Colors }) {
  const active = isActiveTask(task);
  const lit = active || task.state === "failed";
  const color = lit ? stateColor(task.state, colors)
    : task.state === "completed" ? doneColor(colors) : frameColor(colors);
  const glow = lit && isDarkSurface(colors)
    ? { shadowColor: color, shadowOpacity: 0.9, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } } : null;
  return <View style={{ width: 5, height: 5, borderRadius: 2.5, alignSelf: "center", backgroundColor: color, ...glow }} />;
}

export function TaskCommand({ task, colors, layout }: { task: TaskSummary; colors: Colors; layout: Layout }) {
  const command = task.command;
  const split = command?.search(/\s/);
  const head = command && split !== undefined && split >= 0 ? command.slice(0, split) : command;
  const tail = command && split !== undefined && split >= 0 ? command.slice(split) : "";
  return (
    <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.foreground,
      fontFamily: monoFont(layout.platform), fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT }}>
      {command ? <><Text style={{ fontWeight: "600" }}>{head}</Text><Text style={{ color: secondaryColor(colors) }}>{tail}</Text></>
        : <Text style={{ color: secondaryColor(colors) }}>{task.tool ?? task.id}</Text>}
    </Text>
  );
}

/**
 * Command first; status and elapsed are trailing facts. Task ids are shown only
 * where the user can act on them (the board), not as timeline decoration.
 */
export function TaskLine({ task, colors, layout, showId, status = stateText(task.state) }: {
  task: TaskSummary; colors: Colors; layout: Layout; showId?: boolean; status?: string;
}) {
  const mono = monoFont(layout.platform);
  const cell = { fontFamily: mono, fontSize: 10, lineHeight: 16, color: secondaryColor(colors) };
  const elapsed = formatElapsed(task);
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={taskStateLabel(task)}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <TaskLamp task={task} colors={colors} />
        <TaskCommand task={task} colors={colors} layout={layout} />
        {showId ? (
          <Text accessibilityLabel={task.id} selectable style={{ ...cell, opacity: 0.8 }} numberOfLines={1}>
            {task.id.replace(/^mt_/, "").slice(0, 4)}
          </Text>
        ) : null}
        {elapsed ? <Text style={{ ...cell, width: 30, textAlign: "right" }} numberOfLines={1}>{elapsed}</Text> : null}
        <Text accessibilityLabel={taskStateLabel(task)} style={{ ...cell, textAlign: "right",
          color: stateColor(task.state, colors) }} numberOfLines={1}>
          {status}
        </Text>
      </View>
      <View style={{ paddingLeft: 13 }}><TaskNotes task={task} colors={colors} layout={layout} /></View>
      </Pressable>
      {open ? <TaskDetailModal task={task} colors={colors} layout={layout} onClose={() => setOpen(false)} /> : null}
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
    <Text key={index} numberOfLines={1} style={{ color: secondaryColor(colors), fontSize: 10,
      lineHeight: 16, fontFamily: monoFont(layout.platform) }}>{note}</Text>
  ))}</>;
}

export function TaskTable({ tasks, colors, layout, showId }: {
  tasks: readonly TaskSummary[]; colors: Colors; layout: Layout; showId?: boolean;
}) {
  return (
    <View style={{ marginTop: 4 }}>
      {tasks.map(task => <TaskLine key={task.id} task={task} colors={colors} layout={layout} showId={showId} />)}
    </View>
  );
}
