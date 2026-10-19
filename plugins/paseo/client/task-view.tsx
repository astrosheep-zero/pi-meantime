import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { TaskSummary } from "../shared/tasks.js";
import { formatElapsed, frameColor, monoFont, secondaryColor, stateColor, stateText, taskStateLabel } from "./rows.js";

type Colors = PluginTheme["colors"];
type Layout = { compact: boolean; platform: "ios" | "android" | "web" };

/** A4 / B5's shared thin frame. The title masks the border with the host surface. */
export function TaskPanel({ title, colors, layout, children }: {
  title: ReactNode; colors: Colors; layout: Layout; children: ReactNode;
}) {
  return (
    <View style={{ marginTop: 6, borderWidth: 0.5, borderColor: frameColor(colors), borderRadius: 3,
      paddingTop: 5, paddingHorizontal: 9, paddingBottom: 7, backgroundColor: colors.surface0 }}>
      <View style={{ position: "absolute", top: -7, left: 8, right: 8 }}>
        <Text numberOfLines={1} style={{ alignSelf: "flex-start", maxWidth: "100%",
          paddingHorizontal: 4, backgroundColor: colors.surface0, color: secondaryColor(colors),
          fontFamily: monoFont(layout.platform), fontSize: 8.5, lineHeight: 12, letterSpacing: 0.6 }}>
          {title}
        </Text>
      </View>
      <View>{children}</View>
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
      fontFamily: monoFont(layout.platform), fontSize: 10, lineHeight: 16 }}>
      {command ? <><Text style={{ fontWeight: "600" }}>{head}</Text><Text style={{ color: secondaryColor(colors) }}>{tail}</Text></>
        : <Text style={{ color: secondaryColor(colors) }}>{task.tool ?? task.id}</Text>}
    </Text>
  );
}

/**
 * Command first; status and elapsed are trailing facts. Task ids are shown only
 * where the user can act on them (the board), not as timeline decoration.
 */
export function TaskLine({ task, colors, layout, showId, showStatus = true }: {
  task: TaskSummary; colors: Colors; layout: Layout; showId?: boolean; showStatus?: boolean;
}) {
  const mono = monoFont(layout.platform);
  const cell = { fontFamily: mono, fontSize: 10, lineHeight: 16, color: secondaryColor(colors) };
  const elapsed = formatElapsed(task);
  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <TaskCommand task={task} colors={colors} layout={layout} />
        {showId ? (
          <Text accessibilityLabel={task.id} selectable style={{ ...cell, opacity: 0.8 }} numberOfLines={1}>
            {task.id.replace(/^mt_/, "").slice(0, 4)}
          </Text>
        ) : null}
        {elapsed ? <Text style={{ ...cell, width: 30, textAlign: "right" }} numberOfLines={1}>{elapsed}</Text> : null}
        {showStatus ? (
          <Text accessibilityLabel={taskStateLabel(task)} style={{ ...cell, width: 56, textAlign: "right",
            color: stateColor(task.state, colors) }} numberOfLines={1}>
            {stateText(task.state)}
          </Text>
        ) : null}
      </View>
      <TaskNotes task={task} colors={colors} layout={layout} />
    </View>
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
  const running = tasks.filter(task => task.state === "running").length;
  const single = tasks.length === 1 ? tasks[0] : undefined;
  const title = single
    ? <Text style={{ color: stateColor(single.state, colors) }}>{stateText(single.state)}</Text>
    : running
      ? <><Text style={{ color: stateColor("running", colors) }}>{running} running</Text><Text> · {tasks.length} total</Text></>
      : `${tasks.length} tasks`;
  return (
    <TaskPanel title={title} colors={colors} layout={layout}>
      {tasks.map(task => <TaskLine key={task.id} task={task} colors={colors} layout={layout}
        showId={showId} showStatus={!single} />)}
    </TaskPanel>
  );
}
