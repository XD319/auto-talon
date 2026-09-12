import React, { useState } from "react";

import { api, type ApprovalRecord, type BootstrapResponse, type BudgetReport, type ClarifyPrompt, type CommitmentItem, type ExperienceItem, type FileChange, type InboxItem, type MemoryItem, type MemoryStatus, type NextItem, type ScheduleItem, type SkillItem, type TaskListEntry, type TodoItem } from "./api";
import type { TranslationKey } from "./i18n";

type Translate = (key: TranslationKey) => string;

export function TodayCard(props: {
  line: string;
  onClose: () => void;
  t: Translate;
  title: string;
}): React.ReactElement {
  return (
    <div className="today card">
      <strong>{props.title}</strong>
      <p>{props.line}</p>
      <button className="ghost" type="button" onClick={props.onClose}>
        {props.t("close")}
      </button>
    </div>
  );
}

export function ApprovalCard(props: {
  approval: ApprovalRecord;
  onError: (caught: unknown) => void;
  onResolved: () => Promise<void>;
  t: Translate;
}): React.ReactElement {
  async function resolve(action: "allow" | "deny", allowScope?: "once" | "session" | "always"): Promise<void> {
    await api(`/v1/approvals/${props.approval.approvalId}/resolve`, {
      body: JSON.stringify({ action, ...(allowScope !== undefined ? { allowScope } : {}) }),
      method: "POST"
    });
    await props.onResolved();
  }
  return (
    <div className="card">
      <h4>{props.t("approvalRequired")} · {props.approval.toolName ?? "tool"}</h4>
      <p>{props.approval.summary ?? props.approval.reason ?? props.approval.approvalId}</p>
      <div className="row">
        <button type="button" onClick={() => void resolve("allow", "once").catch(props.onError)}>{props.t("allowOnce")}</button>
        <button type="button" onClick={() => void resolve("allow", "session").catch(props.onError)}>{props.t("allowSession")}</button>
        <button type="button" onClick={() => {
          if (window.confirm(props.t("allowAlways"))) void resolve("allow", "always").catch(props.onError);
        }}>{props.t("allowAlways")}</button>
        <button className="danger" type="button" onClick={() => void resolve("deny").catch(props.onError)}>{props.t("deny")}</button>
      </div>
    </div>
  );
}

export function ClarifyCard(props: {
  onError: (caught: unknown) => void;
  onResolved: () => Promise<void>;
  prompt: ClarifyPrompt;
  t: Translate;
}): React.ReactElement {
  const [answer, setAnswer] = useState("");
  const options = props.prompt.options ?? [];
  async function submit(body: Record<string, string>): Promise<void> {
    await api(`/v1/clarify/${props.prompt.promptId}/answer`, { body: JSON.stringify(body), method: "POST" });
    await props.onResolved();
  }
  async function cancel(): Promise<void> {
    await api(`/v1/clarify/${props.prompt.promptId}/cancel`, { method: "POST" });
    await props.onResolved();
  }
  return (
    <div className="card">
      <h4>{props.t("clarification")}</h4>
      <p>{props.prompt.question ?? props.prompt.prompt ?? props.prompt.promptId}</p>
      <div className="row">
        {options.map((option) => (
          <button key={option.id} type="button" onClick={() => void submit({ answerOptionId: option.id }).catch(props.onError)}>
            {option.label}
          </button>
        ))}
      </div>
      {options.length === 0 ? (
        <label className="field">
          <span>{props.t("answer")}</span>
          <input value={answer} onChange={(event) => setAnswer(event.target.value)} />
          <button className="primary" type="button" onClick={() => {
            const text = answer.trim();
            if (text.length === 0) {
              return;
            }
            void submit({ answerText: text }).catch(props.onError);
          }}>{props.t("answer")}</button>
        </label>
      ) : null}
      <div className="row">
        <button className="ghost" type="button" onClick={() => void cancel().catch(props.onError)}>{props.t("cancel")}</button>
      </div>
    </div>
  );
}

export function ChangeList(props: {
  changes: FileChange[];
  onChanged: () => Promise<void>;
  t: Translate;
}): React.ReactElement {
  if (props.changes.length === 0) {
    return <div className="empty">{props.t("emptyChanges")}</div>;
  }
  return (
    <>
      {props.changes.map((change) => {
        const path = change.content?.path ?? change.uri ?? change.artifactId;
        const diff = change.content?.unifiedDiff ?? "";
        return (
          <div className="card" key={change.artifactId}>
            <strong>{path}</strong>
            <div>{change.content?.operation}</div>
            <div className="diff">
              {diff.split("\n").slice(0, 40).map((line, index) => (
                <div className={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""} key={`${change.artifactId}-${index}`}>
                  {line}
                </div>
              ))}
            </div>
            <button
              className="ghost"
              type="button"
              onClick={() => void api(`/v1/artifacts/${change.artifactId}/rollback`, { method: "POST" }).then(() => props.onChanged())}
            >
              {props.t("rollback")}
            </button>
          </div>
        );
      })}
    </>
  );
}

export function InboxPanel(props: { items: InboxItem[]; onReload: () => Promise<void>; t: Translate }): React.ReactElement {
  if (props.items.length === 0) {
    return <div className="empty">{props.t("emptyInbox")}</div>;
  }
  return (
    <>
      {props.items.map((item) => (
        <div className="card" key={item.inboxId}>
          <strong>{item.title}</strong>
          <div>{item.summary}</div>
          <div className="row">
            <button type="button" onClick={() => void api(`/v1/inbox/${item.inboxId}/done`, { method: "POST" }).then(() => props.onReload())}>{props.t("done")}</button>
            <button className="ghost" type="button" onClick={() => void api(`/v1/inbox/${item.inboxId}/dismiss`, { method: "POST" }).then(() => props.onReload())}>{props.t("dismiss")}</button>
          </div>
        </div>
      ))}
    </>
  );
}

export function MemoryPanel(props: {
  memories: MemoryItem[];
  onReload: () => Promise<void>;
  status: MemoryStatus | null;
  t: Translate;
}): React.ReactElement {
  const [content, setContent] = useState("");
  const enabled = props.status?.enabled === true;
  return (
    <>
      <div className="card">
        <label className="row">
          <input
            checked={enabled}
            type="checkbox"
            onChange={(event) => void api("/v1/memory/enabled", {
              body: JSON.stringify({ enabled: event.target.checked }),
              method: "POST"
            }).then(() => props.onReload())}
          />
          <span>{props.t("enableMemory")}</span>
        </label>
        <label className="field">
          <span>{props.t("memoryContent")}</span>
          <textarea value={content} onChange={(event) => setContent(event.target.value)} />
        </label>
        <button className="primary" type="button" onClick={() => {
          const text = content.trim();
          if (text.length === 0) {
            return;
          }
          void api("/v1/memory", {
            body: JSON.stringify({ content: text, scope: "project" }),
            method: "POST"
          }).then(() => {
            setContent("");
            return props.onReload();
          });
        }}>{props.t("addMemory")}</button>
      </div>
      {props.memories.length === 0 ? <div className="empty">{props.t("noMemories")}</div> : props.memories.map((memory) => (
        <div className="card" key={memory.memoryId}>
          <strong>{memory.title}</strong>
          <div>{memory.content}</div>
          <button className="ghost" type="button" onClick={() => void api(`/v1/memory/${memory.memoryId}/forget`, {
            body: JSON.stringify({ note: "forgotten from web" }),
            method: "POST"
          }).then(() => props.onReload())}>{props.t("forget")}</button>
        </div>
      ))}
    </>
  );
}

export function SchedulePanel(props: {
  onReload: () => Promise<void>;
  schedules: ScheduleItem[];
  t: Translate;
}): React.ReactElement {
  const [name, setName] = useState("");
  const [input, setInput] = useState("");
  const [every, setEvery] = useState("1d");
  return (
    <>
      <div className="card">
        <label className="field"><span>{props.t("scheduleName")}</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="field"><span>{props.t("scheduleInput")}</span><textarea value={input} onChange={(event) => setInput(event.target.value)} /></label>
        <label className="field"><span>{props.t("every")}</span><input value={every} onChange={(event) => setEvery(event.target.value)} /></label>
        <button className="primary" type="button" onClick={() => {
          const task = input.trim();
          if (task.length === 0) {
            return;
          }
          void api("/v1/schedules", {
            body: JSON.stringify({
              every: every.trim() || "1d",
              input: task,
              name: name.trim() || "scheduled"
            }),
            method: "POST"
          }).then(() => {
            setName("");
            setInput("");
            return props.onReload();
          });
        }}>{props.t("create")}</button>
      </div>
      {props.schedules.length === 0 ? <div className="empty">{props.t("noSchedules")}</div> : props.schedules.map((schedule) => (
        <div className="card" key={schedule.scheduleId}>
          <strong>{schedule.name}</strong>
          <div>{schedule.status}</div>
          <div className="row">
            <button type="button" onClick={() => void api(`/v1/schedules/${schedule.scheduleId}/pause`, { method: "POST" }).then(() => props.onReload())}>{props.t("pause")}</button>
            <button type="button" onClick={() => void api(`/v1/schedules/${schedule.scheduleId}/resume`, { method: "POST" }).then(() => props.onReload())}>{props.t("resume")}</button>
            <button type="button" onClick={() => void api(`/v1/schedules/${schedule.scheduleId}/run-now`, { method: "POST" }).then(() => props.onReload())}>{props.t("runNow")}</button>
            <button className="danger" type="button" onClick={() => void api(`/v1/schedules/${schedule.scheduleId}`, { method: "DELETE" }).then(() => props.onReload())}>{props.t("archive")}</button>
          </div>
        </div>
      ))}
    </>
  );
}

export function TodoPanel(props: { t: Translate; todos: TodoItem[] }): React.ReactElement {
  if (props.todos.length === 0) {
    return <div className="empty">{props.t("noTodos")}</div>;
  }
  return (
    <>
      {props.todos.map((todo) => (
        <div className="card" key={todo.id}>
          <strong>{todo.status}</strong>
          <div>{todo.content}</div>
        </div>
      ))}
    </>
  );
}

export function ActionPanel(props: {
  commitments: CommitmentItem[];
  nextItems: NextItem[];
  onReload: () => Promise<void>;
  t: Translate;
}): React.ReactElement {
  return (
    <>
      <div className="tab-group">{props.t("next")}</div>
      {props.nextItems.length === 0 ? <div className="empty">{props.t("noNext")}</div> : props.nextItems.map((item) => (
        <div className="card" key={item.nextActionId}>
          <strong>{item.title}</strong>
          <div>{item.status}</div>
          <div className="row">
            <button type="button" onClick={() => void api(`/v1/next/${item.nextActionId}/done`, { method: "POST" }).then(() => props.onReload())}>{props.t("done")}</button>
            <button className="ghost" type="button" onClick={() => void api(`/v1/next/${item.nextActionId}/block`, {
              body: JSON.stringify({ reason: "blocked from web" }),
              method: "POST"
            }).then(() => props.onReload())}>{props.t("block")}</button>
          </div>
        </div>
      ))}
      <div className="tab-group">{props.t("commitments")}</div>
      {props.commitments.length === 0 ? <div className="empty">{props.t("noCommitments")}</div> : props.commitments.map((item) => (
        <div className="card" key={item.commitmentId}>
          <strong>{item.title}</strong>
          <div>{item.status}</div>
          <div className="row">
            <button type="button" onClick={() => void api(`/v1/commitments/${item.commitmentId}/complete`, { method: "POST" }).then(() => props.onReload())}>{props.t("done")}</button>
            <button className="ghost" type="button" onClick={() => void api(`/v1/commitments/${item.commitmentId}/block`, {
              body: JSON.stringify({ reason: "blocked from web" }),
              method: "POST"
            }).then(() => props.onReload())}>{props.t("block")}</button>
          </div>
        </div>
      ))}
    </>
  );
}

export function SkillPanel(props: { onReload: () => Promise<void>; skills: SkillItem[]; t: Translate }): React.ReactElement {
  if (props.skills.length === 0) {
    return <div className="empty">{props.t("noSkills")}</div>;
  }
  return (
    <>
      {props.skills.map((skill) => (
        <div className="card" key={skill.id}>
          <strong>{skill.name}</strong>
          <div>{skill.disabled === true ? props.t("disable") : props.t("enable")}</div>
          <button
            type="button"
            onClick={() => void api(`/v1/skills/${skill.id}/${skill.disabled === true ? "enable" : "disable"}`, { method: "POST" }).then(() => props.onReload())}
          >
            {skill.disabled === true ? props.t("enable") : props.t("disable")}
          </button>
        </div>
      ))}
    </>
  );
}

export function TracePanel(props: { t: Translate; trace: Array<{ eventType: string; summary: string }> }): React.ReactElement {
  if (props.trace.length === 0) {
    return <div className="empty">{props.t("emptyTrace")}</div>;
  }
  return (
    <>
      {props.trace.map((event, index) => (
        <div className="card" key={`${event.eventType}-${index}`}>
          <strong>{event.eventType}</strong>
          <div>{event.summary}</div>
        </div>
      ))}
    </>
  );
}

export function TaskPanel(props: { t: Translate; tasks: TaskListEntry[] }): React.ReactElement {
  if (props.tasks.length === 0) {
    return <div className="empty">{props.t("noTasks")}</div>;
  }
  return (
    <>
      {props.tasks.map((task) => (
        <div className="card" key={task.taskId}>
          <strong>{task.status}</strong>
          <div>{task.input ?? task.taskId}</div>
        </div>
      ))}
    </>
  );
}

export function ExperiencePanel(props: { experiences: ExperienceItem[]; t: Translate }): React.ReactElement {
  if (props.experiences.length === 0) {
    return <div className="empty">{props.t("noExperience")}</div>;
  }
  return (
    <>
      {props.experiences.map((experience) => (
        <div className="card" key={experience.experienceId}>
          {experience.title ?? experience.experienceId}
        </div>
      ))}
    </>
  );
}

export function BudgetLine(props: { budget: BudgetReport | null; t: Translate }): React.ReactElement | null {
  if (props.budget?.state === null || props.budget === null) {
    return null;
  }
  const used = props.budget.state.usedCostUsd;
  const input = props.budget.state.usedInput;
  return (
    <span className="meta">
      {props.t("budget")}: {input ?? 0} tok{used !== undefined ? ` · $${used.toFixed(3)}` : ""}
    </span>
  );
}

export function SettingsPanel({
  bootstrap,
  onClose,
  onSaved
}: {
  bootstrap: BootstrapResponse;
  onClose?: () => void;
  onSaved: () => void;
}): React.ReactElement {
  const [name, setName] = useState(bootstrap.provider.configured ? bootstrap.provider.name : "mock");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState(bootstrap.provider.model ?? "");
  const [message, setMessage] = useState<string | null>(null);

  async function save(): Promise<void> {
    await api("/v1/providers/setup", {
      body: JSON.stringify({
        name,
        ...(apiKey.length > 0 ? { apiKey } : {}),
        ...(baseUrl.length > 0 ? { baseUrl } : {}),
        ...(model.length > 0 ? { model } : {})
      }),
      method: "POST"
    });
    setMessage("Provider saved.");
    onSaved();
  }

  return (
    <section className="settings">
      <h2>Provider setup</h2>
      {onClose !== undefined ? (
        <p>
          <button className="ghost" type="button" onClick={onClose}>
            Back to chat
          </button>
        </p>
      ) : null}
      <p className={bootstrap.provider.configured ? "status-ok" : "status-warn"}>
        {bootstrap.provider.configured
          ? `Active: ${bootstrap.provider.displayName} (${bootstrap.provider.model ?? "no model"})`
          : "No provider configured. Choose Mock to try without an API key."}
      </p>
      <label className="field">
        <span>Provider</span>
        <select value={name} onChange={(event) => setName(event.target.value)}>
          {bootstrap.catalog.map((entry) => (
            <option key={entry} value={entry}>{entry}</option>
          ))}
        </select>
      </label>
      {name !== "mock" ? (
        <>
          <label className="field">
            <span>API key</span>
            <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" />
          </label>
          <label className="field">
            <span>Base URL (for openai-compatible)</span>
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </label>
          <label className="field">
            <span>Model</span>
            <input value={model} onChange={(event) => setModel(event.target.value)} />
          </label>
        </>
      ) : null}
      <div className="row">
        <button className="primary" type="button" onClick={() => void save()}>Save and use</button>
      </div>
      {message !== null ? <p>{message}</p> : null}
      <p className="meta">Workspace: {bootstrap.workspaceRoot}</p>
    </section>
  );
}
