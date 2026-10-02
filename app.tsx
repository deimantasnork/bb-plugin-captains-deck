// bb-plugin-captains-deck — frontend.
//
// The board is read-only except for a Captain's Call: clicking a decision card
// opens a dialog with the options the first mate attached, and the answer is
// written back through RPC. Live thread state comes from the sidebar's own
// thread view, so cards track running agents without polling.
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { DeckTask } from "./server";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type ColumnKey = "charted" | "underway" | "decision" | "merge" | "landed";

const COLUMNS: Array<{
  key: ColumnKey;
  title: string;
  hint: string;
  accent?: boolean;
}> = [
  { key: "charted", title: "Charted Next", hint: "Briefed, not started" },
  { key: "underway", title: "Underway", hint: "Agents on it" },
  {
    key: "decision",
    title: "Captain's Call",
    hint: "Waiting on you",
    accent: true,
  },
  { key: "merge", title: "Awaiting Merge", hint: "Review and land" },
  { key: "landed", title: "Landed", hint: "Recently finished" },
];

const LANDED_VISIBLE = 8;
const CREW_KEY = "captains-deck:crew";
const UNASSIGNED = "Unassigned";

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function columnFor(task: DeckTask): ColumnKey {
  if (task.state === "failed") return "underway";
  return task.state;
}

interface LiveBadge {
  label: string;
  tone: "working" | "idle" | "error" | "attention";
}

function liveBadge(thread: PluginSidebarThread | undefined): LiveBadge | null {
  if (thread === undefined) return null;
  if (thread.status === "error") return { label: "Failed", tone: "error" };
  if (thread.hasPendingInteraction) return { label: "Needs input", tone: "attention" };
  if (thread.status === "active" || thread.status === "starting") {
    return { label: "Working", tone: "working" };
  }
  if (thread.status === "stopping" || thread.status === "pending") {
    return { label: thread.status === "pending" ? "Provisioning" : "Stopping", tone: "working" };
  }
  if (thread.runtimeStatus === "host-reconnecting") {
    return { label: "Reconnecting", tone: "attention" };
  }
  if (thread.queuedWork === "waiting") return { label: "Queued", tone: "idle" };
  return { label: "Idle", tone: "idle" };
}

const TONE_CLASS: Record<LiveBadge["tone"], string> = {
  working: "border-primary/40 bg-primary/10 text-primary",
  idle: "border-border bg-muted text-muted-foreground",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
  attention: "border-primary/50 bg-primary/15 text-primary",
};

function Chip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none",
        className,
      )}
    >
      {children}
    </span>
  );
}

function TaskCard({
  task,
  thread,
  onOpen,
}: {
  task: DeckTask;
  thread: PluginSidebarThread | undefined;
  onOpen: () => void;
}) {
  const badge = liveBadge(thread);
  const isDecision = task.state === "decision";
  const interactive = isDecision || task.threadId !== null;
  const answered = task.decision?.answerLabel ?? null;
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onOpen : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen();
              }
            }
          : undefined
      }
      className={cn(
        "rounded-lg border border-border bg-card p-2.5 text-left shadow-xs transition-colors",
        interactive && "cursor-pointer hover:border-foreground/25",
        isDecision && "border-primary/50",
      )}
    >
      <div className="flex items-center gap-1.5">
        <Chip className="border-border bg-muted text-muted-foreground">
          {task.kind === "scout" ? "SCOUT" : "SHIP"}
        </Chip>
        {task.bot === null ? null : (
          <Chip className="border-border bg-background text-muted-foreground">
            {task.bot}
          </Chip>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {task.id}
        </span>
      </div>

      <p className="mt-1.5 line-clamp-2 text-sm font-medium leading-snug">
        {task.title}
      </p>
      {task.brief === null ? null : (
        <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
          {task.brief}
        </p>
      )}

      {isDecision && task.decision !== null ? (
        <div className="mt-2 rounded-md bg-primary/10 px-2 py-1.5">
          <p className="line-clamp-2 text-xs leading-snug text-foreground">
            {task.decision.question}
          </p>
          <p className="mt-1 text-[10px] font-medium text-primary">
            Answer on the board
          </p>
        </div>
      ) : null}

      {!isDecision && answered !== null ? (
        <p className="mt-1.5 line-clamp-1 text-[10px] text-muted-foreground">
          Captain chose: {answered}
        </p>
      ) : null}

      {task.note !== null ? (
        <p className="mt-1.5 line-clamp-2 text-[10px] text-muted-foreground">
          {task.note}
        </p>
      ) : null}

      {isDecision && task.history.length > 0 ? (
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          {task.history.length} earlier {task.history.length === 1 ? "call" : "calls"}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {badge === null ? null : (
          <Chip className={TONE_CLASS[badge.tone]}>
            {badge.tone === "working" ? (
              <span className="size-1.5 animate-pulse rounded-full bg-current" />
            ) : null}
            {badge.label}
          </Chip>
        )}
        {thread === undefined ? null : (
          <span className="text-[10px] text-muted-foreground">
            {thread.providerId}
          </span>
        )}
        {task.prUrl === null ? null : (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-primary hover:underline"
          >
            <Icon name="GitPullRequest" className="size-3" />
            PR
          </a>
        )}
        <span
          className={cn(
            "text-[10px] text-muted-foreground",
            task.prUrl === null && "ml-auto",
          )}
        >
          {timeAgo(task.updatedAt)}
        </span>
      </div>
    </div>
  );
}

/** A deck-linked thread blocked on the captain inside the thread itself. */
function ThreadCallCard({
  task,
  thread,
  onOpen,
}: {
  task: DeckTask;
  thread: PluginSidebarThread;
  onOpen: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer rounded-lg border border-dashed border-primary/40 bg-card p-2.5 text-left transition-colors hover:border-primary/70"
    >
      <div className="flex items-center gap-1.5">
        <Chip className="border-primary/40 bg-primary/10 text-primary">
          THREAD
        </Chip>
        {task.bot === null ? null : (
          <Chip className="border-border bg-background text-muted-foreground">
            {task.bot}
          </Chip>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {thread.providerId}
        </span>
      </div>
      <p className="mt-1.5 line-clamp-2 text-sm font-medium leading-snug">
        {task.title}
      </p>
      <p className="mt-1 text-[10px] text-primary">
        {thread.indicatorLabel ?? "Waiting for you in the thread"} — open to answer
      </p>
    </div>
  );
}

function Column({
  title,
  hint,
  accent,
  count,
  children,
}: {
  title: string;
  hint: string;
  accent?: boolean;
  count: number;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex h-full w-72 shrink-0 flex-col rounded-xl border border-border bg-muted/30",
        accent && "border-primary/30",
      )}
      aria-label={title}
    >
      <header className="flex items-baseline gap-2 border-b border-border px-3 py-2">
        <h2 className={cn("text-xs font-semibold", accent && "text-primary")}>
          {title}
        </h2>
        <span className="rounded-full bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {count}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">{hint}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {children}
      </div>
    </section>
  );
}

function DecisionDialog({
  task,
  onClose,
  onAnswered,
}: {
  task: DeckTask | null;
  onClose: () => void;
  onAnswered: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const decision = task?.decision ?? null;
  const [optionId, setOptionId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setOptionId(decision?.recommendedId ?? decision?.options[0]?.id ?? null);
    setNote("");
    setPending(false);
  }, [task?.id, decision?.recommendedId, decision?.options]);

  if (task === null || decision === null) return null;

  const submit = async () => {
    if (optionId === null || pending) return;
    setPending(true);
    try {
      await rpc.call("deck_answer", {
        taskId: task.id,
        optionId,
        note: note.trim() === "" ? null : note.trim(),
      });
      toast.success("Answer sent to the first mate");
      onAnswered();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setPending(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="pr-6 text-base leading-snug">
            {task.title}
          </DialogTitle>
          <DialogDescription>
            {decision.context ?? "The first mate needs your call."}
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm leading-snug">{decision.question}</p>

        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Options">
          {decision.options.map((option) => {
            const selected = option.id === optionId;
            const recommended = option.id === decision.recommendedId;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setOptionId(option.id)}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                  selected
                    ? "border-primary bg-primary/10"
                    : "border-border hover:border-foreground/25",
                )}
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border",
                    selected ? "border-primary" : "border-muted-foreground/40",
                  )}
                >
                  {selected ? (
                    <span className="size-2 rounded-full bg-primary" />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">{option.label}</span>
                {recommended ? (
                  <Chip className="border-primary/40 bg-primary/10 text-primary">
                    Recommended
                  </Chip>
                ) : null}
              </button>
            );
          })}
        </div>

        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Add a note (optional)"
          rows={2}
          maxLength={2000}
          aria-label="Note for the first mate"
          className="w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />

        {task.history.length > 0 ? (
          <details className="rounded-lg border border-border bg-muted/30 px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              Earlier calls ({task.history.length})
            </summary>
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {task.history.map((previous, index) => (
                <li key={`${previous.askedAt}-${index}`} className="text-xs leading-snug">
                  <span className="text-muted-foreground">{previous.question}</span>
                  <span className="block text-foreground">
                    {previous.answerLabel ?? "Open when replaced"}
                    {previous.answerNote === null ? "" : ` — ${previous.answerNote}`}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || optionId === null}>
            {pending ? "Sending…" : "Send answer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BoardPage() {
  const rpc = useRpc<typeof rpcContract>();
  const threadsState = experimental_useSidebarThreads();
  const threadActions = experimental_useSidebarThreadActions();
  const [tasks, setTasks] = useState<DeckTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [showAllLanded, setShowAllLanded] = useState(false);
  const [crew, setCrew] = useState<string>(() => {
    if (typeof localStorage === "undefined") return "all";
    return localStorage.getItem(CREW_KEY) ?? "all";
  });

  useEffect(() => {
    try {
      localStorage.setItem(CREW_KEY, crew);
    } catch {
      // Preference only; ignore storage failures.
    }
  }, [crew]);

  const refetch = () => {
    rpc.call("deck_board").then(
      (result) => {
        setTasks(result.tasks);
        setError(null);
      },
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  useEffect(() => {
    refetch();
    // The board itself changes only when the first mate moves a task; the
    // sidebar thread view keeps card status live in between.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useRealtime("deck-changed", refetch);

  const threadsById = useMemo(() => {
    const map = new Map<string, PluginSidebarThread>();
    for (const thread of threadsState.threads) map.set(thread.id, thread);
    return map;
  }, [threadsState.threads]);

  const crews = useMemo(() => {
    const names = new Set<string>();
    for (const task of tasks ?? []) names.add(task.bot ?? UNASSIGNED);
    return Array.from(names).sort((left, right) => left.localeCompare(right));
  }, [tasks]);

  useEffect(() => {
    if (crew !== "all" && !crews.includes(crew)) setCrew("all");
  }, [crews, crew]);

  const visibleTasks = useMemo(() => {
    const all = tasks ?? [];
    return crew === "all"
      ? all
      : all.filter((task) => (task.bot ?? UNASSIGNED) === crew);
  }, [tasks, crew]);

  const columns = useMemo(() => {
    const grouped: Record<ColumnKey, DeckTask[]> = {
      charted: [],
      underway: [],
      decision: [],
      merge: [],
      landed: [],
    };
    for (const task of visibleTasks) grouped[columnFor(task)].push(task);
    for (const key of Object.keys(grouped) as ColumnKey[]) {
      grouped[key].sort((left, right) =>
        left.updatedAt < right.updatedAt ? 1 : -1,
      );
    }
    return grouped;
  }, [visibleTasks]);

  // Threads blocked on the captain inside the thread itself, for tasks the
  // first mate linked. Deck-owned decisions stay the primary call.
  const threadCalls = useMemo(() => {
    const seen = new Set<string>();
    const calls: Array<{ task: DeckTask; thread: PluginSidebarThread }> = [];
    for (const task of visibleTasks) {
      if (task.threadId === null || task.state === "decision") continue;
      if (seen.has(task.threadId)) continue;
      const thread = threadsById.get(task.threadId);
      if (thread === undefined || !thread.hasPendingInteraction) continue;
      seen.add(task.threadId);
      calls.push({ task, thread });
    }
    return calls;
  }, [visibleTasks, threadsById]);

  const activeTask =
    activeTaskId === null
      ? null
      : (tasks?.find((task) => task.id === activeTaskId) ?? null);
  const openCalls = columns.decision.length + threadCalls.length;
  const landedShown = showAllLanded
    ? columns.landed
    : columns.landed.slice(0, LANDED_VISIBLE);

  const openTask = (task: DeckTask) => {
    if (task.state === "decision") {
      setActiveTaskId(task.id);
      return;
    }
    if (task.threadId !== null) threadActions.open(task.threadId);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
        <Icon name="Kanban" className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold">Captain&apos;s Deck</h1>
        <p className="text-xs text-muted-foreground">
          The first mate charts and moves work with <code>bb deck</code>.
        </p>
        <span className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>{columns.charted.length} charted</span>
          <span>·</span>
          <span>{columns.underway.length} underway</span>
          <span>·</span>
          <button
            type="button"
            onClick={() => {
              const first = columns.decision[0];
              if (first !== undefined) setActiveTaskId(first.id);
            }}
            className={cn(
              "rounded-full border px-2 py-0.5",
              openCalls > 0
                ? "border-primary/40 bg-primary/10 font-medium text-primary"
                : "border-border",
            )}
          >
            {openCalls} captain&apos;s {openCalls === 1 ? "call" : "calls"}
          </button>
        </span>
      </header>

      <div className="flex items-center gap-1.5 overflow-x-auto border-b border-border px-4 py-1.5">
        {["all", ...crews].map((name) => {
          const count =
            name === "all"
              ? (tasks ?? []).filter((task) => task.state !== "landed").length
              : (tasks ?? []).filter(
                  (task) =>
                    (task.bot ?? UNASSIGNED) === name && task.state !== "landed",
                ).length;
          const selected = crew === name;
          return (
            <button
              key={name}
              type="button"
              onClick={() => setCrew(name)}
              className={cn(
                "shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors",
                selected
                  ? "border-foreground/30 bg-foreground/10 font-medium text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {name === "all" ? "All crew" : name}
              <span className="ml-1 font-mono text-[10px] opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      {error === null ? null : (
        <p role="alert" className="px-4 pt-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 py-3">
        {COLUMNS.map((column) => {
          const isLanded = column.key === "landed";
          const items = isLanded ? landedShown : columns[column.key];
          const hidden = isLanded ? columns.landed.length - landedShown.length : 0;
          return (
            <Column
              key={column.key}
              title={column.title}
              hint={column.hint}
              accent={column.accent}
              count={columns[column.key].length + (column.key === "decision" ? threadCalls.length : 0)}
            >
              {tasks === null ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">Loading…</p>
              ) : items.length === 0 && (column.key !== "decision" || threadCalls.length === 0) ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                  Nothing here
                </p>
              ) : (
                items.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    thread={
                      task.threadId === null
                        ? undefined
                        : threadsById.get(task.threadId)
                    }
                    onOpen={() => openTask(task)}
                  />
                ))
              )}
              {column.key === "decision" && threadCalls.length > 0 ? (
                <p className="px-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Waiting in threads
                </p>
              ) : null}
              {column.key === "decision"
                ? threadCalls.map((call) => (
                    <ThreadCallCard
                      key={call.thread.id}
                      task={call.task}
                      thread={call.thread}
                      onOpen={() => threadActions.open(call.thread.id)}
                    />
                  ))
                : null}
              {hidden > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowAllLanded(true)}
                  className="rounded-md border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  Show {hidden} more
                </button>
              ) : null}
            </Column>
          );
        })}
      </div>

      <DecisionDialog
        task={activeTask}
        onClose={() => setActiveTaskId(null)}
        onAnswered={refetch}
      />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Captain's Deck",
    icon: "Kanban",
    path: "board",
    component: BoardPage,
  });
});
