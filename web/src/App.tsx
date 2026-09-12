import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  api,
  type ApprovalRecord,
  type BootstrapResponse,
  type BudgetReport,
  type ChatMessage,
  type ClarifyPrompt,
  type CommitmentItem,
  type ExperienceItem,
  type FileChange,
  type InboxItem,
  type MemoryItem,
  type MemoryStatus,
  type NextItem,
  type ScheduleItem,
  type SearchHit,
  type SessionIndexEntry,
  type SessionMessagesResponse,
  type SkillItem,
  type TaskListEntry,
  type TodoItem
} from "./api";
import { formatTodayLine, initialLocale, translate, type Locale, type TranslationKey } from "./i18n";
import {
  ActionPanel,
  ApprovalCard,
  BudgetLine,
  ChangeList,
  ClarifyCard,
  ExperiencePanel,
  InboxPanel,
  MemoryPanel,
  SchedulePanel,
  SettingsPanel,
  SkillPanel,
  TaskPanel,
  TodayCard,
  TodoPanel,
  TracePanel
} from "./panels";
import { matchingSlashCommands, parseSlashIntent, SLASH_COMMANDS, type InteractionMode } from "./slash";
import {
  activityTrace,
  dialogMessages,
  formatSessionTime,
  mergeTranscript,
  normalizeChatMessages,
  sessionLabel
} from "./transcript";

type Mode = InteractionMode;
type RailTab =
  | "changes"
  | "trace"
  | "inbox"
  | "memory"
  | "schedule"
  | "tasks"
  | "todos"
  | "actions"
  | "skills"
  | "experience";

interface RunState { sessionId: string; taskId: string; }
const ACTIVE_TASK_STATUSES = new Set(["pending", "running", "waiting_tool", "waiting_approval", "waiting_clarification"]);

export function App(): React.ReactElement {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [sessions, setSessions] = useState<SessionIndexEntry[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<Mode>("agent");
  const [runsBySession, setRunsBySession] = useState<Record<string, RunState>>({});
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [rail, setRail] = useState<RailTab>("changes");
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [clarifies, setClarifies] = useState<ClarifyPrompt[]>([]);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus | null>(null);
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [tasks, setTasks] = useState<TaskListEntry[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [nextItems, setNextItems] = useState<NextItem[]>([]);
  const [commitments, setCommitments] = useState<CommitmentItem[]>([]);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [experiences, setExperiences] = useState<ExperienceItem[]>([]);
  const [trace, setTrace] = useState<Array<{ eventType: string; summary: string }>>([]);
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [budget, setBudget] = useState<BudgetReport | null>(null);
  const [query, setQuery] = useState("");
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [drawer, setDrawer] = useState<"sessions" | "tools" | null>(null);
  const [showToday, setShowToday] = useState(false);
  const [todayLine, setTodayLine] = useState("");
  const [retryAction, setRetryAction] = useState<(() => void) | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const visibleMessages = useMemo(() => dialogMessages(messages), [messages]);
  const activeRun = sessionId === null ? undefined : runsBySession[sessionId];
  const busy = activeRun !== undefined;
  const taskId = activeRun?.taskId ?? null;
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  sessionIdRef.current = sessionId;

  const loadBootstrap = useCallback(async () => {
    const data = await api<BootstrapResponse>("/v1/bootstrap");
    setBootstrap(data);
    setShowSettings(!data.provider.configured);
  }, []);

  const loadSessions = useCallback(async () => {
    const data = await api<{ sessions: SessionIndexEntry[] }>("/v1/sessions");
    setSessions(data.sessions);
    return data.sessions;
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    const data = await api<SessionMessagesResponse>(`/v1/sessions/${id}/messages`);
    if (sessionIdRef.current !== id) {
      return;
    }
    if (data.interactionMode === "agent" || data.interactionMode === "plan" || data.interactionMode === "acceptEdits") {
      setMode(data.interactionMode);
    }
    const next = normalizeChatMessages(data.messages ?? []);
    setMessages((current) => mergeTranscript(next, current));
    setTrace(activityTrace(next));
  }, []);

  const loadTurnState = useCallback(async (id: string | null) => {
    const query = id === null ? "" : `?sessionId=${encodeURIComponent(id)}`;
    const [approvalData, clarifyData] = await Promise.all([
      api<{ approvals: ApprovalRecord[] }>(`/v1/approvals/pending${query}`),
      api<{ prompts: ClarifyPrompt[] }>(`/v1/clarify/pending${query}`)
    ]);
    setApprovals(approvalData.approvals);
    setClarifies(clarifyData.prompts);
    if (id !== null) {
      const [changeData, todoData, budgetData] = await Promise.all([
        api<{ changes: FileChange[] }>(`/v1/sessions/${id}/changes`),
        api<{ todos: TodoItem[] }>(`/v1/sessions/${id}/todos`),
        api<BudgetReport>(`/v1/sessions/${id}/budget`)
      ]);
      setChanges(changeData.changes);
      setTodos(todoData.todos ?? []);
      setBudget(budgetData);
    }
  }, []);

  const loadRail = useCallback(async (tab: RailTab, id: string | null) => {
    if (tab === "changes" || tab === "trace") {
      return;
    }
    if (tab === "inbox") {
      const data = await api<{ items: InboxItem[] }>("/v1/inbox");
      setInbox(data.items ?? []);
      return;
    }
    if (tab === "memory") {
      const data = await api<{ memories: MemoryItem[]; status?: MemoryStatus }>("/v1/memory");
      setMemories(data.memories ?? []);
      setMemoryStatus(data.status ?? null);
      return;
    }
    if (tab === "schedule") {
      const data = await api<{ schedules: ScheduleItem[] }>("/v1/schedules");
      setSchedules(data.schedules ?? []);
      return;
    }
    if (tab === "tasks") {
      const data = await api<{ tasks: TaskListEntry[] }>("/v1/tasks");
      setTasks(data.tasks ?? []);
      return;
    }
    if (tab === "todos") {
      if (id === null) {
        setTodos([]);
        return;
      }
      const data = await api<{ todos: TodoItem[] }>(`/v1/sessions/${id}/todos`);
      setTodos(data.todos ?? []);
      return;
    }
    if (tab === "actions") {
      const suffix = id === null ? "" : `?sessionId=${encodeURIComponent(id)}`;
      const [nextData, commitmentData] = await Promise.all([
        api<{ items: NextItem[] }>(`/v1/next${suffix}`),
        api<{ items: CommitmentItem[] }>(`/v1/commitments${suffix}`)
      ]);
      setNextItems(nextData.items ?? []);
      setCommitments(commitmentData.items ?? []);
      return;
    }
    if (tab === "skills") {
      const data = await api<{ skills: SkillItem[] | { skills?: SkillItem[] } }>("/v1/skills");
      const list = Array.isArray(data.skills) ? data.skills : data.skills.skills ?? [];
      setSkills(list.map((skill) => ({
        disabled: skill.disabled,
        id: skill.id,
        name: skill.name
      })));
      return;
    }
    const data = await api<{ experiences: ExperienceItem[] }>("/v1/experiences");
    setExperiences(data.experiences ?? []);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await loadBootstrap();
        const list = await loadSessions();
        const taskData = await api<{ tasks: TaskListEntry[] }>("/v1/tasks");
        setRunsBySession(Object.fromEntries(taskData.tasks
          .filter((task) => task.sessionId !== undefined && ACTIVE_TASK_STATUSES.has(task.status))
          .map((task) => [task.sessionId as string, { sessionId: task.sessionId as string, taskId: task.taskId }])));
        if (list[0] !== undefined) {
          setSessionId(list[0].sessionId);
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
  }, [loadBootstrap, loadSessions]);

  useEffect(() => {
    if (sessionId === null) {
      return;
    }
    setMessages([]);
    setTrace([]);
    setChanges([]);
    void loadMessages(sessionId).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : String(caught));
    });
    void loadTurnState(sessionId).catch(() => undefined);
  }, [loadMessages, loadTurnState, sessionId]);

  useEffect(() => {
    void loadRail(rail, sessionId).catch(() => undefined);
  }, [loadRail, rail, sessionId]);

  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 2) {
      setSearchHits([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void api<{ hits: SearchHit[] }>(`/v1/sessions/search?q=${encodeURIComponent(needle)}`)
        .then((data) => setSearchHits(data.hits ?? []))
        .catch(() => setSearchHits([]));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const sources = Object.values(runsBySession).map((run) => {
      const source = new EventSource(`/v1/tasks/${run.taskId}/events`);
      const refresh = () => {
        if (sessionIdRef.current === run.sessionId) {
          void loadMessages(run.sessionId);
          void loadTurnState(run.sessionId);
        }
      };
      source.addEventListener("output", refresh);
      source.addEventListener("trace", refresh);
      source.addEventListener("done", () => {
        setRunsBySession((current) => current[run.sessionId]?.taskId === run.taskId
          ? Object.fromEntries(Object.entries(current).filter(([id]) => id !== run.sessionId))
          : current);
        refresh();
      });
      return source;
    });
    return () => sources.forEach((source) => source.close());
  }, [loadMessages, loadTurnState, runsBySession]);

  const filteredSessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
      return sessions;
    }
    return sessions.filter((session) => sessionLabel(session).toLowerCase().includes(needle) || session.sessionId.toLowerCase().includes(needle));
  }, [query, sessions]);

  const slashHints = matchingSlashCommands(draft);

  async function ensureSession(): Promise<string> {
    if (sessionId !== null) {
      return sessionId;
    }
    const created = await api<{ session: { sessionId: string } }>("/v1/sessions", {
      body: JSON.stringify({ title: "New chat" }),
      method: "POST"
    });
    setSessionId(created.session.sessionId);
    await loadSessions();
    return created.session.sessionId;
  }

  async function newChat(): Promise<void> {
    const created = await api<{ session: { sessionId: string } }>("/v1/sessions", {
      body: JSON.stringify({ title: "New chat" }),
      method: "POST"
    });
    setSessionId(created.session.sessionId);
    setMessages([]);
    setShowSettings(false);
    await loadSessions();
  }

  async function clearChat(title?: string): Promise<void> {
    if (sessionId !== null && title !== undefined && title.length > 0) {
      await api(`/v1/sessions/${sessionId}`, {
        body: JSON.stringify({ title }),
        method: "PATCH"
      });
    }
    await newChat();
  }

  async function openToday(): Promise<void> {
    const [inboxData, taskData] = await Promise.all([
      api<{ items: InboxItem[] }>("/v1/inbox"),
      api<{ tasks: TaskListEntry[] }>("/v1/tasks")
    ]);
    setInbox(inboxData.items ?? []);
    const running = (taskData.tasks ?? []).filter((task) => ACTIVE_TASK_STATUSES.has(task.status)).length;
    const cost = budget?.state?.usedCostUsd;
    setTodayLine(formatTodayLine(
      locale,
      inboxData.items?.length ?? 0,
      running,
      cost !== undefined ? `$${cost.toFixed(3)}` : null
    ));
    setShowToday(true);
  }

  async function handleSlash(text: string): Promise<boolean> {
    const intent = parseSlashIntent(text);
    if (intent === null) {
      return false;
    }
    if (intent.kind === "new") {
      await newChat();
      return true;
    }
    if (intent.kind === "clear") {
      await clearChat(intent.title);
      return true;
    }
    if (intent.kind === "sessions") {
      setDrawer("sessions");
      return true;
    }
    if (intent.kind === "mode") {
      setMode(intent.mode);
      return true;
    }
    if (intent.kind === "stop" && activeRun !== undefined) {
      await api(`/v1/tasks/${activeRun.taskId}/stop`, { method: "POST" });
      setRunsBySession((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== activeRun.sessionId)));
      return true;
    }
    if (intent.kind === "diff") {
      setRail("changes");
      return true;
    }
    if (intent.kind === "inbox") {
      setRail("inbox");
      return true;
    }
    if (intent.kind === "memory") {
      setRail("memory");
      return true;
    }
    if (intent.kind === "schedule") {
      setRail("schedule");
      return true;
    }
    if (intent.kind === "todos") {
      setRail("todos");
      return true;
    }
    if (intent.kind === "next") {
      setRail("actions");
      return true;
    }
    if (intent.kind === "compact" && sessionId !== null) {
      await api(`/v1/sessions/${sessionId}/compact`, { body: JSON.stringify({}), method: "POST" });
      return true;
    }
    if (intent.kind === "help") {
      setShowSettings(false);
      setMessages((current) => [
        ...current,
        {
          id: `local:help:${Date.now()}`,
          kind: "system",
          text: SLASH_COMMANDS.map((item) => `${item.insert} — ${item.label}`).join("\n")
        }
      ]);
      return true;
    }
    if (intent.kind === "sandbox" || (intent.kind === "model" && intent.selection === undefined)) {
      setShowSettings(true);
      return true;
    }
    if (intent.kind === "today") {
      await openToday();
      return true;
    }
    if (intent.kind === "model" && intent.selection !== undefined && sessionId !== null) {
      await api(`/v1/sessions/${sessionId}/model`, {
        body: JSON.stringify({ selection: intent.selection }),
        method: "PATCH"
      });
      await loadBootstrap();
      return true;
    }
    return intent.kind !== "unknown";
  }

  async function send(): Promise<void> {
    const text = draft.trim();
    if (text.length === 0 || busy) {
      return;
    }
    setError(null);
    try {
      if (text.startsWith("/")) {
        const handled = await handleSlash(text);
        if (handled) {
          setDraft("");
          return;
        }
      }
      const id = await ensureSession();
      setMessages((current) => [...current, { id: `local:${Date.now()}`, kind: "user", text, timestamp: new Date().toISOString() }]);
      const turn = await api<{ taskId: string }>(`/v1/sessions/${id}/turns`, {
        body: JSON.stringify({ input: text, interactionMode: mode }),
        method: "POST"
      });
      setRunsBySession((current) => ({ ...current, [id]: { sessionId: id, taskId: turn.taskId } }));
      setDraft("");
      await loadMessages(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setRetryAction(() => () => void send());
    }
  }

  useEffect(() => {
    const node = transcriptRef.current;
    if (node === null) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [sessionId, visibleMessages.length]);

  useEffect(() => {
    const runs = Object.values(runsBySession);
    if (runs.length === 0) {
      return;
    }
    const timer = window.setInterval(() => {
      runs.forEach((run) => void api<{ task: { status: string } }>(`/v1/tasks/${run.taskId}`).then((data) => {
        if (!ACTIVE_TASK_STATUSES.has(data.task.status)) {
          setRunsBySession((current) => current[run.sessionId]?.taskId === run.taskId
            ? Object.fromEntries(Object.entries(current).filter(([id]) => id !== run.sessionId)) : current);
        }
      }).catch(() => undefined));
    }, 1500);
    return () => {
      window.clearInterval(timer);
    };
  }, [runsBySession]);

  function reportError(caught: unknown): void {
    setError(caught instanceof Error ? caught.message : String(caught));
  }

  if (bootstrap === null) {
    return <div className="empty">{error ?? "Loading workspace…"}</div>;
  }

  const railTabs: Array<[RailTab, TranslationKey]> = [
    ["changes", "changes"],
    ["trace", "trace"],
    ["todos", "todos"],
    ["inbox", "inbox"],
    ["memory", "memory"],
    ["schedule", "schedule"],
    ["actions", "next"],
    ["tasks", "tasks"],
    ["skills", "skills"],
    ["experience", "experience"]
  ];

  return (
    <div className={`app ${drawer === "sessions" ? "show-sessions" : ""} ${drawer === "tools" ? "show-tools" : ""}`}>
      <header className="topbar">
        <span className="brand">AutoTalon</span>
        <span className="workspace" title={bootstrap.workspaceRoot}>
          {bootstrap.workspaceRoot}
        </span>
        <span className="spacer" />
        <BudgetLine budget={budget} t={t} />
        <button className="ghost drawer-trigger" type="button" onClick={() => setDrawer(drawer === "sessions" ? null : "sessions")}>
          {t("sessions")}
        </button>
        <select value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
          <option value="agent">agent</option>
          <option value="plan">plan</option>
          <option value="acceptEdits">acceptEdits</option>
        </select>
        <select
          value={bootstrap.models.current?.selection ?? ""}
          onChange={(event) => {
            if (sessionId === null) {
              return;
            }
            void api(`/v1/sessions/${sessionId}/model`, {
              body: JSON.stringify({ selection: event.target.value }),
              method: "PATCH"
            }).then(loadBootstrap);
          }}
        >
          {(bootstrap.models.configuredModels ?? []).map((model) => (
            <option key={model.selection} value={model.selection}>
              {model.displayName} ({model.selection})
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="locale-select">{t("language")}</label>
        <select id="locale-select" value={locale} onChange={(event) => {
          const next = event.target.value as Locale;
          setLocale(next);
          window.localStorage.setItem("auto-talon.locale", next);
        }}>
          <option value="en">EN</option><option value="zh-CN">中文</option>
        </select>
        <button className="ghost drawer-trigger" type="button" onClick={() => setDrawer(drawer === "tools" ? null : "tools")}>
          {t("tools")}
        </button>
        <button className="ghost" type="button" onClick={() => setShowSettings((value) => !value)}>
          {t("settings")}
        </button>
      </header>
      <aside className="sidebar">
        <div className="pane-head">
          <button className="primary" type="button" onClick={() => void newChat()}>
            {t("newChat")}
          </button>
        </div>
        <div className="pane-head">
          <label className="sr-only" htmlFor="session-search">{t("searchSessions")}</label>
          <input id="session-search" placeholder={t("searchSessions")} value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="list">
          {searchHits.length > 0 ? (
            <>
              <div className="tab-group">{t("searchHits")}</div>
              {searchHits.map((hit) => (
                <button
                  className="session"
                  key={hit.messageId}
                  type="button"
                  onClick={() => setSessionId(hit.sessionId)}
                >
                  <span className="title">{hit.sessionTitle || hit.sessionId}</span>
                  <span className="meta">{hit.preview}</span>
                </button>
              ))}
            </>
          ) : null}
          {filteredSessions.map((session) => (
            <button
              className={session.sessionId === sessionId ? "session active" : "session"}
              key={session.sessionId}
              type="button"
              onClick={() => setSessionId(session.sessionId)}
            >
              <span className="title">{sessionLabel(session)}</span>
              <span className={runsBySession[session.sessionId] !== undefined ? "meta is-running" : "meta"}>{runsBySession[session.sessionId] !== undefined ? t("running") : formatSessionTime(session.updatedAt)}</span>
            </button>
          ))}
        </div>
      </aside>
      <main className="main">
        {showSettings || !bootstrap.provider.configured ? (
          <SettingsPanel
            bootstrap={bootstrap}
            onSaved={() => void loadBootstrap()}
            onClose={bootstrap.provider.configured ? () => setShowSettings(false) : undefined}
          />
        ) : (
          <>
            <div className="transcript" ref={transcriptRef}>
              {busy ? <div className="run-status" role="status">{t("running")}: {taskId}</div> : null}
              {showToday ? <TodayCard line={todayLine} title={t("today")} t={t} onClose={() => setShowToday(false)} /> : null}
              {visibleMessages.length === 0 ? (
                <div className="empty">
                  {messages.some((message) => message.kind === "activity") ? t("traceOnly") : t("startTask")}
                </div>
              ) : (
                visibleMessages.map((message) => (
                  <article className={`msg ${message.kind}`} key={message.id}>
                    <div className="who">{message.kind === "agent" ? "assistant" : message.kind}</div>
                    <div className="body">{message.text}</div>
                  </article>
                ))
              )}
              {approvals.map((approval) => (
                <ApprovalCard
                  approval={approval}
                  key={approval.approvalId}
                  onError={reportError}
                  onResolved={() => loadTurnState(sessionId)}
                  t={t}
                />
              ))}
              {clarifies.map((prompt) => (
                <ClarifyCard
                  key={prompt.promptId}
                  onError={reportError}
                  onResolved={() => loadTurnState(sessionId)}
                  prompt={prompt}
                  t={t}
                />
              ))}
              {error !== null ? <div className="card error-card" role="alert">{error}<div className="row"><button type="button" onClick={() => retryAction?.()}>{t("retry")}</button><button className="ghost" type="button" onClick={() => setError(null)}>{t("dismiss")}</button></div></div> : null}
            </div>
            <div className="composer">
              {slashHints.length > 0 ? (
                <div className="hints">
                  {slashHints.slice(0, 8).map((hint) => (
                    <button className="hint" type="button" key={hint.insert} onClick={() => setDraft(hint.insert)}>
                      {hint.insert} — {hint.label}
                    </button>
                  ))}
                </div>
              ) : null}
              <textarea
                aria-label={t("composer")}
                placeholder={t("composer")}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="composer-foot">
                <span className="meta">
                  {busy ? `${t("running")}…` : bootstrap.provider.configured ? bootstrap.provider.displayName : t("configureProvider")}
                </span>
                <div className="row">
                  {busy && taskId !== null ? (
                    <button className="danger" type="button" onClick={() => void handleSlash("/stop")}>
                      {t("stop")}
                    </button>
                  ) : null}
                  <button className="primary" disabled={busy} type="button" onClick={() => void send()}>
                    {t("send")}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </main>
      <aside className="rail">
        <div className="tabs">
          <span className="tab-group">{t("activity")}</span>
          {railTabs.map(([id, label]) => (
            <button className={rail === id ? "active" : ""} key={id} type="button" onClick={() => setRail(id)}>
              {t(label)}
            </button>
          ))}
        </div>
        <div className="rail-body">
          {rail === "changes" ? <ChangeList changes={changes} t={t} onChanged={() => loadTurnState(sessionId)} /> : null}
          {rail === "trace" ? <TracePanel t={t} trace={trace} /> : null}
          {rail === "inbox" ? <InboxPanel items={inbox} t={t} onReload={() => loadRail("inbox", sessionId)} /> : null}
          {rail === "memory" ? <MemoryPanel memories={memories} status={memoryStatus} t={t} onReload={() => loadRail("memory", sessionId)} /> : null}
          {rail === "schedule" ? <SchedulePanel schedules={schedules} t={t} onReload={() => loadRail("schedule", sessionId)} /> : null}
          {rail === "todos" ? <TodoPanel t={t} todos={todos} /> : null}
          {rail === "actions" ? <ActionPanel commitments={commitments} nextItems={nextItems} t={t} onReload={() => loadRail("actions", sessionId)} /> : null}
          {rail === "tasks" ? <TaskPanel t={t} tasks={tasks} /> : null}
          {rail === "skills" ? <SkillPanel skills={skills} t={t} onReload={() => loadRail("skills", sessionId)} /> : null}
          {rail === "experience" ? <ExperiencePanel experiences={experiences} t={t} /> : null}
        </div>
      </aside>
    </div>
  );
}
