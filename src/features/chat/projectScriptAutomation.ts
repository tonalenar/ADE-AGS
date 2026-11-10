import { listen } from "@tauri-apps/api/event";

import i18n from "@/i18n";
import { showBotToast, useBotToastStore } from "@/shared/brand/botToastStore";
import { useTabsStore } from "@/features/tabs/store";

import { useChatStore } from "./store";
import { useStructured } from "./structured/store";
import { threadKey, type ThreadEvent } from "./structured/model";
import { useChatLive } from "./liveStore";
import { usePermissions } from "./permissions/permissionsStore";
import { structuredOf, subscribeStructuredState, type StructuredSnapshot } from "@/features/terminal/structuredState";
import {
  loadChatProjectScripts,
  projectScriptCommandContainsSecret,
  projectScriptSourceCwd,
  validProjectScriptCommand,
  type ChatProjectScript,
} from "./projectScripts";
import { projectScriptCommandGet, projectScriptRunCancel, projectScriptRunStart } from "./projectScriptsIpc";

type Trigger = "worktree" | "settle";
type RunResult = { code: number | null; cancelled: boolean; error: string | null };

interface RunOutputEvent { runId: string; data: string }
interface RunFinishedEvent extends RunResult { runId: string }

function scriptsFor(cwd: string, trigger: Trigger): ChatProjectScript[] {
  return loadChatProjectScripts(cwd).filter((script) => trigger === "worktree" ? script.setup : script.onSettle);
}

/** Inicia uma ação armazenada no chaveiro num processo descartável, com saída e cancelamento próprios. */
async function runOneShot(
  sourceCwd: string,
  executionCwd: string,
  script: ChatProjectScript,
  canContinue: () => boolean,
): Promise<RunResult | null> {
  const command = await projectScriptCommandGet(sourceCwd, script.id);
  if (!canContinue()) return null;
  if (command === null) throw new Error(i18n.t("chat.projectScripts.commandMissing"));
  if (projectScriptCommandContainsSecret(command)) throw new Error(i18n.t("chat.projectScripts.secretInline"));
  if (!validProjectScriptCommand(command)) throw new Error(i18n.t("chat.projectScripts.invalid"));

  const runId = crypto.randomUUID();
  const runTitle = script.name;
  const startedText = i18n.t("chat.projectScripts.autoRunStarting", { folder: executionCwd });
  let recentOutput = "";
  let runStarted = false;
  let cancelRequested = false;
  let finish: ((event: RunFinishedEvent) => void) | null = null;
  const finished = new Promise<RunFinishedEvent>((resolve) => { finish = resolve; });
  const toastId = showBotToast({
    title: runTitle,
    text: startedText,
    tone: "info",
    sticky: true,
    actionLabel: i18n.t("chat.projectScripts.autoRunCancel"),
    onAction: () => {
      if (!runStarted) {
        cancelRequested = true;
        return;
      }
      void projectScriptRunCancel(runId).catch((error: unknown) => {
        useBotToastStore.getState().update(toastId, { text: i18n.t("chat.projectScripts.autoRunFailed", { error: String(error) }) });
      });
    },
  });
  let offOutput: (() => void) | null = null;
  let offFinished: (() => void) | null = null;
  try {
    offOutput = await listen<RunOutputEvent>("cc-project-script-output", (event) => {
      if (event.payload.runId !== runId) return;
      recentOutput = `${recentOutput}${event.payload.data}`.slice(-1_400);
      useBotToastStore.getState().update(toastId, { text: `${startedText}\n${recentOutput}` });
    });
    offFinished = await listen<RunFinishedEvent>("cc-project-script-finished", (event) => {
      if (event.payload.runId === runId) finish?.(event.payload);
    });
    if (!canContinue()) {
      useBotToastStore.getState().dismiss(toastId);
      return null;
    }
    await projectScriptRunStart(sourceCwd, executionCwd, script.id, runId);
    runStarted = true;
    if (cancelRequested) {
      // O botão pode ser acionado enquanto o IPC ainda registra o processo no backend.
      // Aguardar o registro evita perder o cancelamento e deixar o comando começar solto.
      await projectScriptRunCancel(runId).catch(() => undefined);
    }
    const result = await finished;
    useBotToastStore.getState().dismiss(toastId);
    if (result.cancelled) {
      showBotToast({ title: runTitle, text: i18n.t("chat.projectScripts.autoRunCancelled"), tone: "warning" });
    } else if (result.error) {
      showBotToast({ title: runTitle, text: i18n.t("chat.projectScripts.autoRunFailed", { error: result.error }), tone: "error" });
    } else if (result.code === 0) {
      showBotToast({ title: runTitle, text: i18n.t("chat.projectScripts.autoRunSucceeded"), tone: "info" });
    } else {
      showBotToast({ title: runTitle, text: i18n.t("chat.projectScripts.autoRunExitCode", { code: result.code ?? "?" }), tone: "error" });
    }
    return result;
  } catch (error) {
    useBotToastStore.getState().dismiss(toastId);
    showBotToast({ title: runTitle, text: i18n.t("chat.projectScripts.autoRunFailed", { error: String(error) }), tone: "error" });
    return { code: null, cancelled: false, error: String(error) };
  } finally {
    offOutput?.();
    offFinished?.();
  }
}

async function runTrigger(
  sourceCwd: string,
  executionCwd: string,
  trigger: Trigger,
  canContinue: () => boolean = () => true,
): Promise<boolean> {
  const scripts = scriptsFor(sourceCwd, trigger);
  for (const script of scripts) {
    if (!canContinue()) return false;
    const result = await runOneShot(sourceCwd, executionCwd, script, canContinue).catch((error: unknown) => {
      showBotToast({ title: script.name, text: i18n.t("chat.projectScripts.autoRunFailed", { error: String(error) }), tone: "error" });
      return { code: null, cancelled: false, error: String(error) };
    });
    if (!result) return false;
    if (result.cancelled || result.error || result.code !== 0) return false;
  }
  return true;
}

/** Roda os scripts explicitamente habilitados depois que a ADE criou um worktree. */
export function runProjectScriptsOnWorktreeCreate(sourceCwd: string, worktreeCwd: string): Promise<boolean> {
  return runTrigger(sourceCwd, worktreeCwd, "worktree");
}

function noPendingStructuredWork(threadId: string): boolean {
  const key = threadKey(threadId);
  const live = useStructured.getState().live[threadId];
  return !!live
    && live.phase === "idle"
    && live.error === null
    && live.requests.length === 0
    && (useChatStore.getState().queues[key]?.length ?? 0) === 0;
}

function launchThreadSettle(threadId: string, generation: number): void {
  const key = `${threadId}:${generation}`;
  if (!recordOnce(settledThreads, key)) return;
  const thread = useStructured.getState().threads.find((candidate) => candidate.id === threadId);
  if (!thread) return;
  const sourceCwd = projectScriptSourceCwd(thread.cwd);
  void runTrigger(sourceCwd, thread.cwd, "settle", () => noPendingStructuredWork(threadId));
}

function noPendingTuiWork(tabId: string, endedAt: number): boolean {
  const snapshot = structuredOf(tabId);
  const live = useChatLive.getState();
  return !!snapshot
    && !snapshot.stale
    && snapshot.phase === "idle"
    && snapshot.turnEndedAt === endedAt
    && snapshot.question === null
    && snapshot.approval == null
    && !snapshot.endsWithQuestion
    && live.phase[tabId] === "idle"
    && !live.question[tabId]
    && !live.awaiting[tabId]
    && !usePermissions.getState().tui.some((request) => request.tabId === tabId)
    && (useChatStore.getState().queues[tabId]?.length ?? 0) === 0;
}

function launchTabSettle(tabId: string, snapshot: StructuredSnapshot): void {
  const endedAt = snapshot.turnEndedAt;
  if (endedAt == null) return;
  const key = `${tabId}:${endedAt}`;
  if (!recordOnce(settledTabs, key)) return;
  // Deixe o despachante da fila processar o mesmo evento antes da revalidação.
  window.setTimeout(() => {
    if (!noPendingTuiWork(tabId, endedAt)) return;
    const tab = useTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    const sourceCwd = projectScriptSourceCwd(tab.cwd);
    void runTrigger(sourceCwd, tab.cwd, "settle", () => noPendingTuiWork(tabId, endedAt));
  }, 0);
}

const settledThreads = new Set<string>();
const settledTabs = new Set<string>();
let stopWatching: (() => void) | null = null;

function recordOnce(set: Set<string>, key: string): boolean {
  if (set.has(key)) return false;
  set.add(key);
  while (set.size > 512) set.delete(set.values().next().value!);
  return true;
}

function trimThreadTurns(turns: Map<string, { working: boolean; turn: number; settled: number }>): void {
  while (turns.size > 512) {
    const oldest = turns.keys().next().value;
    if (oldest === undefined) return;
    // Fail closed se houver muitas conversas ativas: uma entrada removida perde o hook,
    // mas não deixa o mapa crescer sem limite nem cria um settle sem transição observada.
    turns.delete(oldest);
  }
}

/** Observa apenas transições confirmadas; estado inicial, silêncio e animações não contam como settle. */
export function startProjectScriptSettleWatcher(): () => void {
  if (stopWatching) return stopWatching;
  const threadTurns = new Map<string, { working: boolean; turn: number; settled: number }>();
  for (const [id, live] of Object.entries(useStructured.getState().live)) {
    threadTurns.set(id, { working: live.phase === "working", turn: live.phase === "working" ? 1 : 0, settled: 0 });
  }
  trimThreadTurns(threadTurns);
  let acceptingEvents = false;
  let disposed = false;
  let stopThreadEvents: (() => void) | null = null;
  void listen<ThreadEvent>("cc-chat-thread", (event) => {
    if (!acceptingEvents || event.payload.type !== "phase") return;
    const id = event.payload.threadId;
    const current = threadTurns.get(id) ?? { working: false, turn: 0, settled: 0 };
    if (event.payload.phase === "working") {
      if (!current.working) current.turn += 1;
      current.working = true;
      threadTurns.set(id, current);
      trimThreadTurns(threadTurns);
      return;
    }
    if (!current.working) return;
    current.working = false;
    const turn = current.turn;
    if (current.settled === turn) return;
    current.settled = turn;
    threadTurns.set(id, current);
    trimThreadTurns(threadTurns);
    window.setTimeout(() => {
      if (noPendingStructuredWork(id)) launchThreadSettle(id, turn);
    }, 0);
  }).then((unlisten) => {
    if (disposed) unlisten();
    else stopThreadEvents = unlisten;
  }).catch(() => undefined);
  const previousTabs = new Map<string, StructuredSnapshot | null>();
  const stopTabs = subscribeStructuredState((tabId, snapshot) => {
    const previous = previousTabs.get(tabId);
    previousTabs.set(tabId, snapshot);
    if (!acceptingEvents || !previous || !snapshot || previous.stale || snapshot.stale || snapshot.mode === "off") return;
    if (previous.phase !== "working" || snapshot.phase !== "idle" || snapshot.turnEndedAt == null) return;
    if (previous.turnEndedAt != null && snapshot.turnEndedAt <= previous.turnEndedAt) return;
    launchTabSettle(tabId, snapshot);
  });
  acceptingEvents = true;
  stopWatching = () => {
    disposed = true;
    acceptingEvents = false;
    stopThreadEvents?.();
    stopTabs();
    stopWatching = null;
  };
  return stopWatching;
}
