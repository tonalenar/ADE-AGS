/**
 * Iniciar uma comparação e encerrá-la. Iniciar: valida tudo antes de qualquer efeito, cria os
 * worktrees no backend, abre um terminal por modelo no canvas da comparação e manda o MESMO
 * pedido a cada um quando a TUI fica pronta (`sendWhenReady`, o caminho dos briefings de missão).
 *
 * Encerrar nunca apaga trabalho sem confirmação: o backend ensaia (`dryRun`), a tela lista o que
 * seria perdido, e só com o "sim" os terminais fecham e o descarte acontece (guardado numa ref).
 */
import i18n from "i18next";

import { canvasActions, compareBoardKey, setWorkMode } from "@/features/canvas/store";
import { TEXT_PREFIX } from "@/features/canvas/board";
import { getAutonomy, withAutonomy } from "@/features/missions/autonomy";
import { withModel } from "@/features/missions/modelFlags";
import { useTabsStore } from "@/features/tabs/store";
import { sendWhenReady } from "@/features/terminal/terminalRegistry";
import { appConfirm } from "@/shared/ui/appConfirm";
import { AlertaToast } from "@/shared/ui/alerts";

import { compareAttach, compareFinish, compareKeep, comparePrepare, compareRemove } from "./ipc";
import { draftProblem, hardBlocked, pickLabel, pickSlug, picksToRemove, promptFor, riskyRemovals, uniquePicks } from "./model";
import { loadComparisons, setPending, upsertComparison, useCompareStore } from "./store";
import type { Comparison, PickDraft } from "./types";

export interface StartInput {
  cwd: string;
  title: string;
  prompt: string;
  isolate: boolean;
  isRepo: boolean;
  picks: PickDraft[];
}

/** O id do rótulo do grupo no canvas. */
export const titleIdOf = (comparisonId: string) => `${TEXT_PREFIX}cmp-${comparisonId}`;

export async function startComparison(input: StartInput): Promise<Comparison> {
  const t = i18n.t.bind(i18n);
  const { addTab, detectedAgents, activateTab } = useTabsStore.getState();
  const available = detectedAgents.filter((a) => a.available).map((a) => a.id);
  const problem = draftProblem({ prompt: input.prompt, picks: input.picks, isolate: input.isolate, isRepo: input.isRepo, available });
  if (problem) throw new Error(t(problem));
  const agents = input.picks.map((p) => detectedAgents.find((a) => a.id === p.agentId && a.available)!);
  const slugs = uniquePicks(input.picks.map(pickSlug));
  const picks = input.picks.map((p, i) => ({ pick: slugs[i], label: pickLabel(p, agents[i].label), agentId: p.agentId }));

  const prepared = await comparePrepare({ cwd: input.cwd, title: input.title, picks, isolate: input.isolate });
  const cmp = prepared.comparison;
  const opened = cmp.entries.map((entry) => {
    const i = picks.findIndex((p) => p.pick === entry.pick);
    const draft = input.picks[i];
    const agent = agents[i];
    // Mesmo nível de permissões e mesma forma de passar modelo/esforço/Fast das missões em terminais.
    const command = withModel(agent.id, withAutonomy(agent.id, agent.command, getAutonomy()), draft.model, draft.effort, draft.fast);
    const prelaunch = prepared.setups.find((s) => s.pick === entry.pick)?.prelaunch;
    const tabId = addTab({
      cwd: entry.cwd,
      agent: { ...agent, command },
      title: entry.label,
      titleIsCustom: true,
      prelaunch: prelaunch ? [{ command: prelaunch }] : undefined,
    });
    return { entry, tabId };
  });

  let saved = cmp;
  try {
    saved = await compareAttach(cmp.id, opened.map((o) => ({ pick: o.entry.pick, tabId: o.tabId })));
  } catch (e) {
    console.error(e);
  }
  upsertComparison(saved);

  const key = compareBoardKey(input.cwd, cmp.id);
  canvasActions.buildComparison(key, titleIdOf(cmp.id), t("compare.groupTitle", { title: cmp.title }), opened.map((o) => ({ tabId: o.tabId, label: o.entry.label })));
  setWorkMode(key, "canvas");
  if (opened[0]) activateTab(opened[0].tabId);

  for (const { entry, tabId } of opened) {
    setPending(tabId, true);
    sendWhenReady(tabId, promptFor(entry.agentId, input.prompt, entry), {
      onSent: () => setPending(tabId, false),
      // A TUI não abriu a tempo: o pedido não foi colado. Some o "iniciando" e o usuário vê o terminal.
      onStalled: () => setPending(tabId, false),
    });
  }
  return saved;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fecha as abas desses agentes (o PTY morre com a aba) e dá um instante para o SO soltar os arquivos. */
async function closeTabsOf(cmp: Comparison, picks: readonly string[]): Promise<void> {
  const { tabs, closeTab } = useTabsStore.getState();
  const ids = cmp.entries.filter((e) => picks.includes(e.pick) && e.tabId && tabs.some((t) => t.id === e.tabId)).map((e) => e.tabId!);
  for (const id of ids) closeTab(id);
  if (ids.length > 0) await wait(900);
}

function labelOf(cmp: Comparison, pick: string): string {
  return cmp.entries.find((e) => e.pick === pick)?.label ?? pick;
}

/**
 * Remove os agentes `picks`: ensaia, pede a confirmação extra se algum tem trabalho, fecha os
 * terminais e remove. `true` = removeu (ou não havia o que remover); `false` = o usuário desistiu.
 */
async function removePicks(cmp: Comparison, picks: string[]): Promise<boolean> {
  const t = i18n.t.bind(i18n);
  if (picks.length === 0) return true;
  const dry = await compareRemove(cmp.id, picks, false, true);
  const hard = hardBlocked(dry.entries);
  if (hard.length > 0) {
    await appConfirm({
      title: t("compare.remove.blockedTitle"),
      lead: t("compare.remove.blockedLead"),
      items: hard.map((e) => `${labelOf(cmp, e.pick)}: ${e.blockers.join("; ")}`),
      confirmLabel: t("btn.close"),
      cancelLabel: t("btn.cancel"),
    });
    return false;
  }
  const risky = riskyRemovals(dry.entries);
  let discard = false;
  if (risky.length > 0) {
    const ok = await appConfirm({
      tone: "danger",
      title: t("compare.remove.riskTitle"),
      lead: t("compare.remove.riskLead"),
      items: risky.map((e) => `${labelOf(cmp, e.pick)}: ${t("compare.remove.riskItem", { dirty: e.dirty.length, commits: e.commits.length })}`),
      note: t("compare.remove.riskNote", { ref: `refs/ags/descartes/${cmp.id}/<modelo>` }),
      confirmLabel: t("compare.remove.discardAnyway"),
      cancelLabel: t("btn.cancel"),
    });
    if (!ok) return false;
    discard = true;
  }
  await closeTabsOf(cmp, picks);
  const report = await compareRemove(cmp.id, picks, discard, false);
  const failed = report.entries.filter((e) => !e.removed);
  if (failed.length > 0) {
    void AlertaToast(t("compare.remove.partialTitle"), failed.map((e) => `${labelOf(cmp, e.pick)}: ${e.blockers.join("; ")}`).join("\n"), "warning", 8000);
  }
  return true;
}

/** "Manter este": confirma, marca o escolhido e remove os outros (com a confirmação extra se preciso). */
export async function keepEntry(cmp: Comparison, pick: string): Promise<void> {
  const t = i18n.t.bind(i18n);
  const entry = cmp.entries.find((e) => e.pick === pick);
  if (!entry) return;
  const others = picksToRemove(cmp.entries, pick);
  const ok = await appConfirm({
    title: t("compare.keep.title", { label: entry.label }),
    lead: t("compare.keep.lead", { branch: entry.branch ?? "" }),
    items: others.map((p) => labelOf(cmp, p)),
    note: t("compare.keep.note"),
    confirmLabel: t("compare.keep.confirm"),
    cancelLabel: t("btn.cancel"),
  });
  if (!ok) return;
  try {
    upsertComparison(await compareKeep(cmp.id, pick));
    await removePicks(cmp, others);
  } catch (e) {
    void AlertaToast(t("compare.error.title"), String(e), "error", 8000);
  }
  await loadComparisons();
}

/** "Descartar todos": remove todos os que não foram mantidos. Sem isolamento, só fecha os terminais. */
export async function discardAll(cmp: Comparison): Promise<void> {
  const t = i18n.t.bind(i18n);
  const picks = picksToRemove(cmp.entries, cmp.kept);
  const ok = await appConfirm({
    tone: "danger",
    title: t(cmp.isolated ? "compare.discard.title" : "compare.discard.titleShared"),
    lead: t(cmp.isolated ? "compare.discard.lead" : "compare.discard.leadShared"),
    items: picks.map((p) => labelOf(cmp, p)),
    confirmLabel: t("compare.discard.confirm"),
    cancelLabel: t("btn.cancel"),
  });
  if (!ok) return;
  try {
    await removePicks(cmp, picks);
  } catch (e) {
    void AlertaToast(t("compare.error.title"), String(e), "error", 8000);
  }
  await loadComparisons();
}

/** "Encerrar": o terminal do mantido fecha e o worktree sai; a branch fica com o trabalho. */
export async function finishComparison(cmp: Comparison): Promise<void> {
  const t = i18n.t.bind(i18n);
  const kept = cmp.entries.find((e) => e.pick === cmp.kept);
  if (!kept) return;
  try {
    const dry = await compareFinish(cmp.id, false, true);
    if (dry.blockers.length > 0 && !dry.needsCommit) {
      void AlertaToast(t("compare.error.title"), dry.blockers.join("; "), "error", 8000);
      return;
    }
    const ok = await appConfirm({
      title: t("compare.finish.title"),
      lead: t("compare.finish.lead", { branch: kept.branch ?? "" }),
      items: dry.needsCommit ? dry.dirty.slice(0, 12) : undefined,
      note: dry.needsCommit ? t("compare.finish.commitNote", { count: dry.dirty.length }) : undefined,
      confirmLabel: t(dry.needsCommit ? "compare.finish.commitConfirm" : "compare.finish.confirm"),
      cancelLabel: t("btn.cancel"),
    });
    if (!ok) return;
    await closeTabsOf(cmp, [kept.pick]);
    const report = await compareFinish(cmp.id, dry.needsCommit, false);
    if (report.removed) {
      void AlertaToast(t("compare.finish.doneTitle"), t("compare.finish.done", { branch: kept.branch ?? "" }), "success", 6000);
    } else {
      void AlertaToast(t("compare.error.title"), report.blockers.join("; "), "error", 8000);
    }
  } catch (e) {
    void AlertaToast(t("compare.error.title"), String(e), "error", 8000);
  }
  await loadComparisons();
}

/** A comparação de um id, do store. */
export function comparisonById(id: string | null): Comparison | undefined {
  return id ? useCompareStore.getState().comparisons.find((c) => c.id === id) : undefined;
}
