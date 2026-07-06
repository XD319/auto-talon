import type { Command } from "commander";

import { createApplication } from "../runtime/index.js";
import {
  formatAuditLog,
  formatTask,
  formatTaskList,
  formatTaskTimeline,
  formatTrace,
  formatTraceContextDebug,
  summarizeAudit,
  summarizeTrace
} from "./formatters.js";

export function registerTaskTraceCommands(program: Command): void {
  const taskCommand = program.command("task").description("Inspect persisted tasks");

  taskCommand.command("list").option("--json", "Print JSON").action((commandOptions: { json?: boolean }) => {
    const handle = createApplication(process.cwd());
    try {
      const tasks = handle.service.listTasks();
      console.log(commandOptions.json === true ? JSON.stringify(tasks, null, 2) : formatTaskList(tasks));
    } finally {
      handle.close();
    }
  });

  taskCommand.command("show").argument("<task_id>", "Task identifier").action((taskId: string) => {
    const handle = createApplication(process.cwd());
    try {
      const result = handle.service.showTask(taskId);
      if (result.task === null) {
        console.error(`Task ${taskId} not found.`);
        process.exitCode = 1;
        return;
      }

      console.log(
        formatTask(result.task, result.toolCalls, result.approvals, result.scheduleRuns, result.inboxItems)
      );
    } finally {
      handle.close();
    }
  });

  taskCommand.command("timeline").argument("<task_id>", "Task identifier").action((taskId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatTaskTimeline(handle.service.taskTimeline(taskId)));
    } finally {
      handle.close();
    }
  });

  const traceCommand = program.command("trace").description("Inspect persisted trace data");

  traceCommand
    .argument("[task_id]", "Task identifier")
    .option("--summary", "Print summary instead of full trace")
    .action((taskId: string | undefined, commandOptions: { summary?: boolean }) => {
      if (taskId === undefined) {
        console.error("Task id is required.");
        process.exitCode = 1;
        return;
      }

      const handle = createApplication(process.cwd());
      try {
        const trace = handle.service.traceTask(taskId);
        console.log(commandOptions.summary ? summarizeTrace(trace) : formatTrace(trace));
      } finally {
        handle.close();
      }
    });

  traceCommand.command("context").argument("<task_id>", "Task identifier").action((taskId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatTraceContextDebug(handle.service.traceTaskContext(taskId)));
    } finally {
      handle.close();
    }
  });

  program
    .command("audit")
    .argument("<task_id>", "Task identifier")
    .option("--summary", "Print summary instead of raw entries")
    .action((taskId: string, commandOptions: { summary?: boolean }) => {
      const handle = createApplication(process.cwd());
      try {
        const audit = handle.service.auditTask(taskId);
        console.log(commandOptions.summary ? summarizeAudit(audit) : formatAuditLog(audit));
      } finally {
        handle.close();
      }
    });
}
