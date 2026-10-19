import type { PluginTheme } from "@getpaseo/plugin";
import type { TaskSummary } from "../shared/tasks.js";
import { elapsedSeconds, isActiveTask } from "../shared/tasks.js";

export function stateColor(state: string, colors: PluginTheme["colors"]): string {
  switch (state) {
    case "running":
      return colors.accent;
    case "completed":
      return colors.statusSuccess;
    case "failed":
      return colors.statusDanger;
    case "cancelled":
    case "cancel_requested":
      return colors.statusWarning;
    default:
      return colors.foregroundMuted;
  }
}

export function formatElapsed(task: TaskSummary, now?: number): string | undefined {
  const seconds = elapsedSeconds(task, now);
  if (seconds === undefined) return undefined;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function taskTitle(task: TaskSummary): string {
  return `${task.id} · ${task.tool}`;
}

export interface TaskRowSpec {
  heading: string;
  color: string;
  state: string;
  elapsed?: string;
  command?: string;
  progress?: string;
  outputPath?: string;
  note?: string;
  active: boolean;
}

/** Shared row projection used by both the timeline card and the board. */
export function taskRowSpec(task: TaskSummary, colors: PluginTheme["colors"], now?: number): TaskRowSpec {
  const notes: string[] = [];
  if (task.cancelRequested) notes.push("cancel requested");
  if (task.recovered) notes.push("recovered");
  if (task.isError && task.state !== "failed") notes.push("error");
  return {
    heading: taskTitle(task),
    color: stateColor(task.state, colors),
    state: task.state,
    ...(formatElapsed(task, now) !== undefined ? { elapsed: formatElapsed(task, now) } : {}),
    ...(task.command ? { command: task.command } : {}),
    ...(task.progress && isActiveTask(task) ? { progress: task.progress } : {}),
    ...(task.outputPath && !isActiveTask(task) ? { outputPath: task.outputPath } : {}),
    ...(notes.length ? { note: notes.join(" · ") } : {}),
    active: isActiveTask(task),
  };
}
