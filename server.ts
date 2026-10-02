// bb-plugin-captains-deck — backend.
//
// The deck is a projection of work the first mate charts and moves. Agents drive
// it from a shell with `bb deck ...`; the board (app.tsx) reads it over RPC and
// only writes back a captain's answer to an open decision.
//
// One store in bb.storage.kv serves three surfaces: the Captain's Deck board,
// the `bb deck` CLI, and the skill in skills/captains-deck/SKILL.md. Every
// write publishes a realtime signal so any open board refetches at once.
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const taskStateSchema = z.enum([
  "charted",
  "underway",
  "decision",
  "merge",
  "landed",
  "failed",
]);
export type TaskState = z.infer<typeof taskStateSchema>;

const decisionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
});
export type DecisionOption = z.infer<typeof decisionOptionSchema>;

const decisionSchema = z.object({
  question: z.string(),
  options: z.array(decisionOptionSchema),
  recommendedId: z.string().nullable(),
  context: z.string().nullable(),
  askedAt: z.string(),
  answeredAt: z.string().nullable(),
  answerId: z.string().nullable(),
  answerLabel: z.string().nullable(),
  answerNote: z.string().nullable(),
});
export type DeckDecision = z.infer<typeof decisionSchema>;

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  brief: z.string().nullable(),
  kind: z.enum(["ship", "scout"]),
  state: taskStateSchema,
  threadId: z.string().nullable(),
  projectId: z.string().nullable(),
  bot: z.string().nullable(),
  prUrl: z.string().nullable(),
  note: z.string().nullable(),
  decision: decisionSchema.nullable(),
  history: z.array(decisionSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  landedAt: z.string().nullable(),
});
export type DeckTask = z.infer<typeof taskSchema>;

export const rpcContract = defineRpcContract({
  deck_board: {
    input: z.null(),
    output: z.object({ tasks: z.array(taskSchema) }),
  },
  deck_answer: {
    input: z.object({
      taskId: z.string(),
      optionId: z.string(),
      note: z.string().trim().max(2000).nullish(),
    }),
    output: z.object({ task: taskSchema }),
  },
});

const DECK_CHANGED = "deck-changed";
const TASKS_KEY = "tasks";
const HISTORY_LIMIT = 10;

/** Tasks stored by older versions have no `history`; normalize on read. */
function normalizeTask(task: DeckTask): DeckTask {
  return { ...task, history: task.history ?? [] };
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("captains-deck loaded");

  const settings = bb.settings.define({
    firstMateThreadId: {
      type: "string",
      label: "First mate thread",
      description:
        "Answers to board decisions are sent to this thread as an agent-only note. Leave empty to only record the answer on the board.",
      default: "",
    },
  });
  const { firstMateThreadId } = await settings.get();

  async function readTasks(): Promise<DeckTask[]> {
    const raw = (await bb.storage.kv.get<DeckTask[]>(TASKS_KEY)) ?? [];
    return raw.map(normalizeTask);
  }

  async function writeTasks(tasks: DeckTask[]): Promise<void> {
    await bb.storage.kv.set(TASKS_KEY, tasks);
    // Ephemeral broadcast; every open board refetches.
    bb.realtime.publish(DECK_CHANGED, { count: tasks.length });
  }

  const now = () => new Date().toISOString();
  const newId = () => randomUUID().replaceAll("-", "").slice(0, 8);

  function findTask(tasks: DeckTask[], id: string): DeckTask {
    const task = tasks.find((candidate) => candidate.id === id);
    if (task === undefined) throw new Error(`No deck task with id ${id}`);
    return task;
  }

  async function createTask(input: {
    title: string;
    brief?: string | null;
    kind?: "ship" | "scout";
    projectId?: string | null;
    bot?: string | null;
    threadId?: string | null;
  }): Promise<DeckTask> {
    const timestamp = now();
    const task: DeckTask = {
      id: newId(),
      title: input.title,
      brief: input.brief?.trim() ? input.brief.trim() : null,
      kind: input.kind ?? "ship",
      state: "charted",
      threadId: input.threadId ?? null,
      projectId: input.projectId ?? null,
      bot: input.bot ?? null,
      prUrl: null,
      note: null,
      decision: null,
      history: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      landedAt: null,
    };
    const tasks = await readTasks();
    await writeTasks([...tasks, task]);
    return task;
  }

  async function updateTask(
    id: string,
    change: (task: DeckTask) => DeckTask,
  ): Promise<DeckTask> {
    const tasks = await readTasks();
    const task = findTask(tasks, id);
    const next = change({ ...task });
    next.updatedAt = now();
    await writeTasks(tasks.map((candidate) => (candidate.id === id ? next : candidate)));
    return next;
  }

  async function askDecision(
    id: string,
    input: {
      question: string;
      options: string[];
      recommend?: string | null;
      context?: string | null;
      threadId?: string | null;
    },
  ): Promise<DeckTask> {
    const options: DecisionOption[] = input.options.map((label, index) => ({
      id: `o${index + 1}`,
      label,
    }));
    let recommendedId: string | null = null;
    const recommend = input.recommend?.trim() ?? "";
    if (recommend !== "") {
      const asIndex = Number.parseInt(recommend, 10);
      recommendedId =
        Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= options.length
          ? options[asIndex - 1]!.id
          : (options.find(
              (option) => option.label.toLowerCase() === recommend.toLowerCase(),
            )?.id ?? null);
    }
    return updateTask(id, (task) => {
      // A new call archives the previous one, answered or not.
      const history =
        task.decision === null
          ? task.history
          : [task.decision, ...task.history].slice(0, HISTORY_LIMIT);
      return {
        ...task,
        state: "decision",
        threadId: input.threadId ?? task.threadId,
        history,
        decision: {
          question: input.question,
          options,
          recommendedId,
          context: input.context?.trim() ? input.context.trim() : null,
          askedAt: now(),
          answeredAt: null,
          answerId: null,
          answerLabel: null,
          answerNote: null,
        },
      };
    });
  }

  async function answerDecision(
    taskId: string,
    optionId: string,
    note: string | null | undefined,
  ): Promise<DeckTask> {
    const cleanedNote = note?.trim() ? note.trim() : null;
    const answered = await updateTask(taskId, (task) => {
      const decision = task.decision;
      if (decision === null) throw new Error(`Task ${task.id} has no open decision`);
      if (decision.answeredAt !== null) {
        throw new Error(`Task ${task.id} was already answered`);
      }
      const option = decision.options.find((candidate) => candidate.id === optionId);
      if (option === undefined) {
        throw new Error(`Unknown option ${optionId} for task ${task.id}`);
      }
      return {
        ...task,
        // The answer resolves the call; the lane resumes. The first mate moves
        // the task on from here.
        state: "underway",
        decision: {
          ...decision,
          answeredAt: now(),
          answerId: option.id,
          answerLabel: option.label,
          answerNote: cleanedNote,
        },
      };
    });

    if (firstMateThreadId !== "") {
      const decision = answered.decision;
      const text = [
        "[Captain's Deck] The captain answered a decision.",
        `Task: ${answered.id} — ${answered.title}`,
        `Question: ${decision?.question ?? ""}`,
        `Choice: ${decision?.answerLabel ?? optionId}`,
        `Note: ${cleanedNote ?? "none"}`,
        "The task is back in Underway on the board. Continue the work accordingly.",
      ].join("\n");
      try {
        await bb.sdk.threads.send({
          threadId: firstMateThreadId,
          mode: "auto",
          input: [{ type: "text", text, mentions: [], visibility: "agent-only" }],
        });
      } catch (error) {
        // The answer is durable on the board; delivery is best effort.
        bb.log.warn(
          `could not deliver decision answer to ${firstMateThreadId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return answered;
  }

  bb.rpc.register(rpcContract, {
    deck_board: async () => ({ tasks: await readTasks() }),
    deck_answer: async ({ taskId, optionId, note }) => ({
      task: await answerDecision(taskId, optionId, note),
    }),
  });

  // ---------------------------------------------------------------- CLI ---

  const usage = [
    "Usage:",
    "  bb deck chart --title <title> [--brief <text>] [--kind ship|scout]",
    "                [--project <project-id>] [--bot <name>] [--thread <thread-id>] [--json]",
    "  bb deck start <task-id> [--thread <thread-id>] [--json]",
    "  bb deck ask <task-id> --question <text> --option <label> [--option <label> ...]",
    "                [--recommend <number|label>] [--context <text>] [--thread <thread-id>] [--json]",
    "  bb deck note <task-id> --text <text> [--json]",
    "  bb deck merge <task-id> [--pr <url>] [--json]",
    "  bb deck land <task-id> [--json]",
    "  bb deck fail <task-id> [--reason <text>] [--json]",
    "  bb deck move <task-id> <charted|underway|decision|merge|landed|failed> [--json]",
    "  bb deck list [--json]",
    "  bb deck show <task-id> [--json]",
    "  bb deck bearings [--json]",
    "  bb deck remove <task-id> [--json]",
  ].join("\n");

  function parseArgs(argv: string[]): {
    positionals: string[];
    flags: Map<string, string[]>;
  } {
    const positionals: string[] = [];
    const flags = new Map<string, string[]>();
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index]!;
      if (arg.startsWith("--")) {
        const name = arg.slice(2);
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(name, [...(flags.get(name) ?? []), next]);
          index += 1;
        } else {
          flags.set(name, [...(flags.get(name) ?? []), "true"]);
        }
      } else {
        positionals.push(arg);
      }
    }
    return { positionals, flags };
  }

  const flag = (flags: Map<string, string[]>, name: string): string | null =>
    flags.get(name)?.at(-1) ?? null;
  const flagAll = (flags: Map<string, string[]>, name: string): string[] =>
    flags.get(name) ?? [];

  function formatTask(task: DeckTask): string {
    const meta = [
      task.state,
      task.kind,
      task.bot ?? undefined,
      task.threadId ? `thread ${task.threadId}` : undefined,
      task.prUrl ?? undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .join(" · ");
    return `${task.id}  ${task.title}  [${meta}]`;
  }

  function bearingsSections(tasks: DeckTask[]): Array<{
    title: string;
    tasks: DeckTask[];
  }> {
    const byUpdate = (left: DeckTask, right: DeckTask) =>
      left.updatedAt < right.updatedAt ? 1 : -1;
    return [
      {
        title: "Charted Next",
        tasks: tasks.filter((task) => task.state === "charted").sort(byUpdate),
      },
      {
        title: "Underway",
        tasks: tasks
          .filter((task) => task.state === "underway" || task.state === "failed")
          .sort(byUpdate),
      },
      {
        title: "Captain's Call",
        tasks: tasks
          .filter(
            (task) => task.state === "decision" && task.decision?.answeredAt == null,
          )
          .sort(byUpdate),
      },
      {
        title: "Awaiting Merge",
        tasks: tasks.filter((task) => task.state === "merge").sort(byUpdate),
      },
      {
        title: "Recently Landed",
        tasks: tasks.filter((task) => task.state === "landed").sort(byUpdate).slice(0, 6),
      },
    ];
  }

  bb.cli.register({
    name: "deck",
    summary: "Drive the Captain's Deck board: chart, start, ask, note, merge, and land tasks",
    commands: [
      { name: "chart", summary: "Add a task to Charted Next", usage: "bb deck chart --title <title> [--brief <text>] [--kind ship|scout] [--project <id>] [--bot <name>] [--thread <id>]" },
      { name: "start", summary: "Move a task to Underway", usage: "bb deck start <task-id> [--thread <thread-id>]" },
      { name: "ask", summary: "Open a Captain's Call on a task", usage: "bb deck ask <task-id> --question <text> --option <label> [--option <label> ...] [--recommend <number|label>] [--context <text>] [--thread <thread-id>]" },
      { name: "note", summary: "Set the short status note on a task", usage: "bb deck note <task-id> --text <text>" },
      { name: "merge", summary: "Move a task to Awaiting Merge", usage: "bb deck merge <task-id> [--pr <url>]" },
      { name: "land", summary: "Move a task to Landed", usage: "bb deck land <task-id>" },
      { name: "fail", summary: "Mark a task failed", usage: "bb deck fail <task-id> [--reason <text>]" },
      { name: "move", summary: "Set a task's column", usage: "bb deck move <task-id> <charted|underway|decision|merge|landed|failed>" },
      { name: "list", summary: "List deck tasks", usage: "bb deck list [--json]" },
      { name: "show", summary: "Show one deck task", usage: "bb deck show <task-id> [--json]" },
      { name: "bearings", summary: "Print the fleet digest", usage: "bb deck bearings [--json]" },
      { name: "remove", summary: "Remove a deck task", usage: "bb deck remove <task-id> [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const { positionals, flags } = parseArgs(
        argv.filter((arg) => arg !== "--json"),
      );
      const [command, ...args] = positionals;
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });
      const fail = (message: string) => ({ exitCode: 1, stderr: message });

      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };

          case "chart": {
            const title = flag(flags, "title") ?? args.join(" ").trim();
            if (!title) return fail(usage);
            const kindFlag = flag(flags, "kind");
            if (kindFlag !== null && kindFlag !== "ship" && kindFlag !== "scout") {
              return fail('--kind must be "ship" or "scout"');
            }
            const task = await createTask({
              title,
              brief: flag(flags, "brief"),
              kind: kindFlag === "scout" ? "scout" : "ship",
              projectId: flag(flags, "project"),
              bot: flag(flags, "bot"),
              threadId: flag(flags, "thread"),
            });
            return reply(task, `Charted ${formatTask(task)}`);
          }

          case "start": {
            const id = args[0];
            if (id === undefined) return fail(usage);
            const task = await updateTask(id, (current) => ({
              ...current,
              state: "underway",
              threadId: flag(flags, "thread") ?? current.threadId,
              note: flag(flags, "note") ?? current.note,
            }));
            return reply(task, `Underway ${formatTask(task)}`);
          }

          case "ask": {
            const id = args[0];
            const question = flag(flags, "question");
            const options = flagAll(flags, "option");
            if (id === undefined || !question || options.length === 0) return fail(usage);
            const task = await askDecision(id, {
              question,
              options,
              recommend: flag(flags, "recommend"),
              context: flag(flags, "context") ?? flag(flags, "note"),
              threadId: flag(flags, "thread"),
            });
            return reply(
              task,
              `Captain's Call opened on ${task.id}: ${question}\nOptions: ${options.join(" | ")}`,
            );
          }

          case "note": {
            const id = args[0];
            const text = flag(flags, "text") ?? args.slice(1).join(" ").trim();
            if (id === undefined || text === "") return fail(usage);
            const task = await updateTask(id, (current) => ({
              ...current,
              note: text,
            }));
            return reply(task, `Noted ${formatTask(task)}`);
          }

          case "merge": {
            const id = args[0];
            if (id === undefined) return fail(usage);
            const task = await updateTask(id, (current) => ({
              ...current,
              state: "merge",
              prUrl: flag(flags, "pr") ?? current.prUrl,
            }));
            return reply(task, `Awaiting merge ${formatTask(task)}`);
          }

          case "land": {
            const id = args[0];
            if (id === undefined) return fail(usage);
            const task = await updateTask(id, (current) => ({
              ...current,
              state: "landed",
              landedAt: now(),
            }));
            return reply(task, `Landed ${formatTask(task)}`);
          }

          case "fail": {
            const id = args[0];
            if (id === undefined) return fail(usage);
            const task = await updateTask(id, (current) => ({
              ...current,
              state: "failed",
              note: flag(flags, "reason") ?? current.note,
            }));
            return reply(task, `Failed ${formatTask(task)}`);
          }

          case "move": {
            const id = args[0];
            const state = args[1];
            const parsed = taskStateSchema.safeParse(state);
            if (id === undefined || !parsed.success) return fail(usage);
            const task = await updateTask(id, (current) => ({
              ...current,
              state: parsed.data,
              landedAt: parsed.data === "landed" ? (current.landedAt ?? now()) : current.landedAt,
            }));
            return reply(task, `Moved ${formatTask(task)}`);
          }

          case "list": {
            const tasks = await readTasks();
            return reply(
              tasks,
              tasks.length === 0
                ? "No deck tasks."
                : tasks.map(formatTask).join("\n"),
            );
          }

          case "show": {
            const id = args[0];
            if (id === undefined) return fail(usage);
            const task = findTask(await readTasks(), id);
            const detail = [
              formatTask(task),
              task.brief ? `Brief: ${task.brief}` : null,
              task.note ? `Note: ${task.note}` : null,
              task.decision
                ? [
                    `Decision: ${task.decision.question}`,
                    ...task.decision.options.map(
                      (option) =>
                        `  ${task.decision?.recommendedId === option.id ? "*" : " "} ${option.id}: ${option.label}`,
                    ),
                    task.decision.answerLabel
                      ? `Answered: ${task.decision.answerLabel}`
                      : "Open",
                  ].join("\n")
                : null,
              task.history.length > 0
                ? `Previous calls: ${task.history.length}`
                : null,
            ]
              .filter((line): line is string => line !== null)
              .join("\n");
            return reply(task, detail);
          }

          case "bearings": {
            const tasks = await readTasks();
            const sections = bearingsSections(tasks);
            if (json) {
              return reply(
                {
                  sections: sections.map((section) => ({
                    title: section.title,
                    tasks: section.tasks,
                  })),
                },
                "",
              );
            }
            const lines: string[] = ["Bearings", ""];
            for (const section of sections) {
              lines.push(
                `${section.title} (${section.tasks.length})`,
                ...(section.tasks.length === 0
                  ? ["  nothing"]
                  : section.tasks.map((task) => {
                      const extra = [
                        task.bot ?? undefined,
                        task.threadId ? `thread ${task.threadId}` : undefined,
                        task.prUrl ?? undefined,
                      ]
                        .filter((value): value is string => value !== undefined)
                        .join(" · ");
                      return `  ${task.id}  ${task.title}${extra ? `  [${extra}]` : ""}`;
                    })),
                "",
              );
            }
            return { exitCode: 0, stdout: lines.join("\n").trimEnd() };
          }

          case "remove": {
            const id = args[0];
            if (id === undefined) return fail(usage);
            const tasks = await readTasks();
            findTask(tasks, id);
            await writeTasks(tasks.filter((task) => task.id !== id));
            return reply({ removed: true, id }, `Removed ${id}`);
          }
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }

      return fail(usage);
    },
  });

  bb.onDispose(() => {
    bb.log.info("captains-deck disposed");
  });
}
