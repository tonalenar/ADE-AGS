import { PopupSelect } from "@/shared/ui/PopupSelect";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import i18next from "i18next";
import { Button } from "neogestify-ui-components";

import type { Fact, Run } from "@/features/runs/types";
import { MemorySearchBar } from "./MemorySearchBar";
import { EMPTY_SEARCH, isEmptySearch, toFilter, verificationOf, type SearchState } from "./memorySearch";
import { PurgeButton } from "./PurgeButton";
import { SourceCheck } from "./SourceCheck";
import { RepoSyncNotice } from "./RepoSyncNotice";
import * as memoryIpc from "./ipc";
import { errorText, needsSecretConfirmation } from "./secretConfirm";
import type { MemoryDetail, MemoryEntry, MemoryKind, MemoryPage, MemoryProposal, MemoryScope, MemorySnapshot, MemoryValidityInterval, MemoryWorkspaceStats } from "./types";

export type MemoryTab = "workspace" | "mission" | "facts" | "snapshot";
type ProposalForm = {
  mode: "create" | "update" | "delete" | "promote";
  scope: MemoryScope;
  key: string;
  kind: MemoryKind;
  body: string;
  priority: number;
  reason: string;
  entryId?: string;
  expectedRevision?: number;
  factId?: string;
};

const KINDS: MemoryKind[] = ["decision", "finding", "file", "constraint", "note"];
/** O texto da app no idioma atual, também fora de componentes (rótulos e helpers). */
const tr = (key: string, vars?: Record<string, unknown>): string => i18next.t(key, vars);
const KIND_LABEL: Record<MemoryKind, string> = new Proxy({} as Record<MemoryKind, string>, { get: (_, kind: string) => tr(`sharedMemory.kind.${kind}`) });
const OPERATION_LABEL: Record<"create" | "update" | "delete", string> = new Proxy({} as Record<"create" | "update" | "delete", string>, { get: (_, op: string) => tr(`sharedMemory.op.${op}`) });

/** Campo de formulário: superfície de campo, anel de foco de 3px. */
const FIELD = "rounded-md bg-gray-200/70 px-2.5 text-[12px] text-gray-900 focus:outline-none focus-visible:ring-[3px] focus-visible:ring-accent-500/25 dark:bg-surface-raised dark:text-gray-100";
const LABEL = "flex flex-col gap-1.5 text-[11px] font-medium text-gray-600 dark:text-white/55";
/** Metadado: número, id e data sempre em mono tabular (o "toque nerd"). */
const META = "font-mono text-[10.5px] leading-[14px] tabular-nums text-gray-500 dark:text-white/40";
/** Caixa de conteúdo de memória (prévia, revisão, snapshot). */
const BODY = "whitespace-pre-wrap break-words rounded-lg bg-gray-200/50 p-2.5 text-[11.5px] leading-4 text-gray-800 dark:bg-surface-sunken dark:text-white/70";
const CARD = "rounded-xl bg-gray-100/70 p-3 dark:bg-surface-raised/60";
const SUBPANEL = "rounded-xl bg-violet-500/8 p-3 dark:bg-violet-300/5";

export function SharedMemoryPanel({ workspaceId, missionId = null, runs = [], activeRunId = null, initialTab }: {
  workspaceId: string;
  missionId?: string | null;
  runs?: Run[];
  activeRunId?: string | null;
  initialTab?: MemoryTab;
}) {
  // Para alterar a aba inicial, quem usa este painel deve forçar a remontagem com uma key.
  const [tab, setTab] = useState<MemoryTab>(initialTab ?? "workspace");
  const [workspacePage, setWorkspacePage] = useState<MemoryPage | null>(null);
  const [missionPage, setMissionPage] = useState<MemoryPage | null>(null);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [form, setForm] = useState<ProposalForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [secretPrompt, setSecretPrompt] = useState(false);
  const [pendingSecret, setPendingSecret] = useState<MemoryEntry | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [runSelection, setRunSelection] = useState<string | null>(null);
  const { t } = useTranslation();
  const [search, setSearch] = useState<SearchState>(EMPTY_SEARCH);
  const [applied, setApplied] = useState<SearchState>(EMPTY_SEARCH);
  const [loadFailed, setLoadFailed] = useState(false);
  const [stats, setStats] = useState<MemoryWorkspaceStats | null>(null);
  const appliedKey = JSON.stringify(applied);
  const lastKey = useRef(appliedKey);
  const fetchPage = useCallback((mission: string | null, cursor?: string | null) =>
    isEmptySearch(applied)
      ? (cursor ? memoryIpc.listMemory(workspaceId, mission, cursor) : memoryIpc.listMemory(workspaceId, mission))
      : memoryIpc.queryMemory(workspaceId, mission, toFilter(applied), cursor),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [workspaceId, appliedKey]);

  // A digitação só vira consulta depois de uma pausa (debounce), para não disparar um IPC por tecla.
  useEffect(() => {
    if (JSON.stringify(search) === appliedKey) return;
    const timer = window.setTimeout(() => setApplied(search), search.query === applied.query ? 0 : 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  const selectedRunId = runs.some((run) => run.id === runSelection)
    ? runSelection
    : activeRunId ?? runs[0]?.id ?? null;
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;
  const factById = useMemo(() => new Map(facts.map((fact) => [fact.id, fact])), [facts]);

  useEffect(() => {
    let current = true;
    setBusy(true);
    setError("");
    setLoadFailed(false);
    if (lastKey.current !== appliedKey) {
      lastKey.current = appliedKey;
      setWorkspacePage(null);
      setMissionPage(null);
    }
    const memoryRequests = Promise.all([
      fetchPage(null),
      missionId ? fetchPage(missionId) : Promise.resolve(null),
    ]);
    const runRequest = selectedRunId
      ? Promise.all([memoryIpc.listRunFacts(selectedRunId), memoryIpc.listMemorySnapshot(selectedRunId)])
      : Promise.resolve(null);
    Promise.all([memoryRequests, runRequest]).then(([[workspace, mission], runData]) => {
      if (!current) return;
      setWorkspacePage(workspace);
      setMissionPage(mission);
      setFacts(runData?.[0] ?? []);
      setSnapshot(runData?.[1] ?? null);
    }).catch((cause: unknown) => {
      if (current) { setError(String(cause)); setLoadFailed(true); setWorkspacePage((p) => p ?? { items: [], hasMore: false, nextCursor: null, truncated: false }); }
    }).finally(() => {
      if (current) setBusy(false);
    });
    return () => { current = false; };
  }, [workspaceId, missionId, selectedRunId, refreshKey, fetchPage, appliedKey]);

  // "Memória usada": leitura só de contagem; falha não atrapalha a lista.
  useEffect(() => {
    let current = true;
    try {
      memoryIpc.getMemoryWorkspaceStats(workspaceId).then((s) => { if (current) setStats(s); }).catch(() => { if (current) setStats(null); });
    } catch { setStats(null); }
    return () => { current = false; };
  }, [workspaceId, refreshKey]);

  useEffect(() => {
    const offMemory = listen("cc-memory-changed", () => setRefreshKey((value) => value + 1));
    const offFacts = listen<string>("cc-run-facts", (event) => { if (event.payload === selectedRunId) setRefreshKey((value) => value + 1); });
    return () => { for (const off of [offMemory, offFacts]) off.then((unlisten) => unlisten()).catch(() => {}); };
  }, [selectedRunId]);

  const closeForm = useCallback(() => { setForm(null); setSecretPrompt(false); }, []);
  const reload = () => setRefreshKey((value) => value + 1);
  const loadMore = async (scope: MemoryScope) => {
    const page = scope === "workspace" ? workspacePage : missionPage;
    if (!page?.nextCursor || !missionId && scope === "mission") return;
    setBusy(true);
    try {
      const next = await fetchPage(scope === "mission" ? missionId : null, page.nextCursor);
      const merge = (previous: MemoryPage | null): MemoryPage => ({
        items: [...(previous?.items ?? []), ...next.items],
        hasMore: next.hasMore,
        nextCursor: next.nextCursor,
        truncated: Boolean(previous?.truncated || next.truncated),
      });
      if (scope === "workspace") setWorkspacePage(merge);
      else setMissionPage(merge);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!form) return;
    setBusy(true);
    setError("");
    try {
      if (form.mode === "promote") {
        if (!selectedRunId || !form.factId) throw new Error(tr("sharedMemory.invalidFact"));
        await memoryIpc.promoteFact(selectedRunId, form.factId, form.scope, form.key, form.priority, form.reason || undefined);
      } else {
        const proposal: MemoryProposal = {
          scope: form.scope,
          key: form.key,
          kind: form.kind,
          body: form.body,
          priority: form.priority,
          operation: form.mode,
          expectedRevision: form.expectedRevision ?? null,
          reason: form.reason || null,
        };
        if (secretPrompt) proposal.acknowledgeSecret = true;
        await memoryIpc.proposeMemory(workspaceId, form.scope === "mission" ? missionId : null, proposal);
      }
      setForm(null);
      setSecretPrompt(false);
      setDetail(null);
      reload();
    } catch (cause) {
      if (needsSecretConfirmation(cause)) {
        setSecretPrompt(true);
        return;
      }
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (entry: MemoryEntry, approve: boolean, acknowledgeSecret = false) => {
    if (entry.pendingRevision === null) return;
    setBusy(true);
    setError("");
    try {
      if (acknowledgeSecret) await memoryIpc.decideMemory(entry.id, entry.pendingRevision, approve, true);
      else await memoryIpc.decideMemory(entry.id, entry.pendingRevision, approve);
      setNotice("");
      setPendingSecret(null);
      setDetail(null);
      reload();
    } catch (cause) {
      if (approve && needsSecretConfirmation(cause)) {
        setPendingSecret(entry);
        return;
      }
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const openCreate = (scope: MemoryScope) => {
    setSecretPrompt(false);
    setForm({ mode: "create", scope, key: "", kind: "note", body: "", priority: 0, reason: "" });
  };
  const openEdit = (entry: MemoryEntry) => {
    if (entry.currentRevision === null || entry.body === null) return;
    setSecretPrompt(false);
    setForm({
      mode: "update", scope: entry.scope, key: entry.key, kind: entry.kind, body: entry.body,
      priority: entry.priority, reason: "", entryId: entry.id, expectedRevision: entry.currentRevision,
    });
  };
  const openDelete = (entry: MemoryEntry) => {
    if (entry.currentRevision === null || entry.body === null) return;
    setSecretPrompt(false);
    setForm({
      mode: "delete", scope: entry.scope, key: entry.key, kind: entry.kind, body: entry.body,
      priority: entry.priority, reason: "", entryId: entry.id, expectedRevision: entry.currentRevision,
    });
  };
  const openPromote = (fact: Fact) => {
    setSecretPrompt(false);
    setForm({
      mode: "promote", scope: selectedRun?.missionId ? "mission" : "workspace", key: "",
      kind: fact.kind, body: fact.body, priority: 0, reason: "", factId: fact.id,
    });
  };
  const inspect = async (entry: MemoryEntry) => {
    setBusy(true);
    setError("");
    try {
      const history = await memoryIpc.getMemory(entry.id, workspaceId, entry.scope === "mission" ? missionId : null);
      setDetail(history);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const renderList = (scope: MemoryScope) => {
    const page = scope === "workspace" ? workspacePage : missionPage;
    if (!page) return <p role="status" className="text-xs text-gray-400 dark:text-white/40">{t("memorySearch.loading")}</p>;
    return (
      <div className="flex flex-col gap-2.5">
        {page.items.length === 0 && !loadFailed && <p className="text-xs text-gray-400 dark:text-white/40">{isEmptySearch(applied) ? t("sharedMemory.empty") : t("memorySearch.noResults")}</p>}
        {page.items.map((entry) => (
          <MemoryEntryCard key={entry.id} onPurged={reload} entry={entry} busy={busy} workspaceId={workspaceId} missionId={missionId}
            onInspect={() => inspect(entry)}
            onApprove={() => decide(entry, true)} onReject={() => decide(entry, false)}
            onEdit={() => {
              if (!entry.bodyTruncated) { openEdit(entry); return; }
              memoryIpc.getMemory(entry.id, workspaceId, entry.scope === "mission" ? missionId : null)
                .then((full) => openEdit(full.entry)).catch((cause) => setError(String(cause)));
            }} onDelete={() => {
              if (!entry.bodyTruncated) { openDelete(entry); return; }
              memoryIpc.getMemory(entry.id, workspaceId, entry.scope === "mission" ? missionId : null)
                .then((full) => openDelete(full.entry)).catch((cause) => setError(String(cause)));
            }} />
        ))}
        {page.truncated && <p className="text-[10.5px] text-amber-700 dark:text-amber-300">{t("sharedMemory.limited")}</p>}
        {page.hasMore && <Button variant="ghost" size="sm" disabled={busy} onClick={() => loadMore(scope)}>{t("sharedMemory.loadMore")}</Button>}
      </div>
    );
  };

  const tabs: { id: MemoryTab; label: string; disabled?: boolean }[] = [
    { id: "workspace", label: t("sharedMemory.tab.workspace") },
    ...(missionId ? [{ id: "mission" as const, label: t("sharedMemory.tab.mission") }] : []),
    ...(selectedRunId ? [{ id: "facts" as const, label: t("sharedMemory.tab.facts") }, { id: "snapshot" as const, label: t("sharedMemory.tab.snapshot") }] : []),
  ];

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-gray-200 p-4 dark:border-white/[0.08]">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-500 dark:text-white/45">{t("sharedMemory.title")}</h3>
        {selectedRunId && runs.length > 1 && (
          <label className="flex items-center gap-2 text-[10.5px] text-gray-500 dark:text-white/45">
            Run
            <span className="relative inline-flex">
              <PopupSelect aria-label={t("sharedMemory.selectRun")} value={selectedRunId} onChange={(event) => setRunSelection(event.target.value)}
                className="font-mono tabular-nums">
                {runs.map((run, index) => <option key={run.id} value={run.id}>#{runs.length - index} · {run.status} · {run.id.slice(0, 8)}</option>)}
              </PopupSelect>
            </span>
          </label>
        )}
        {(tab === "workspace" || tab === "mission") && (
          <Button variant="primary" size="sm" disabled={busy || tab === "mission" && !missionId}
            onClick={() => openCreate(tab === "mission" ? "mission" : "workspace")}>{t("sharedMemory.propose")}</Button>
        )}
      </div>
      <RepoSyncNotice workspaceId={workspaceId} />

      <div role="tablist" aria-label={t("sharedMemory.sections")} className="flex flex-wrap gap-0.5 rounded-lg bg-gray-200/70 p-0.5 dark:bg-surface-raised">
        {tabs.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
            onClick={() => { setTab(item.id); setDetail(null); }}
            className={`h-6 rounded-md px-2.5 text-[12px] transition-colors ${tab === item.id ? "bg-white font-medium text-gray-900 shadow-sm dark:bg-surface-overlay dark:text-white" : "text-gray-600 hover:text-gray-900 dark:text-white/55 dark:hover:text-white"}`}>
            {item.label}
          </button>
        ))}
      </div>

      {(tab === "workspace" || tab === "mission") && (
        <MemorySearchBar value={search} onChange={setSearch} scope={tab} onScope={(s) => { setTab(s); setDetail(null); }} canMission={missionId !== null} />
      )}
      {stats && (tab === "workspace" || tab === "mission") && (
        <p className="font-mono text-[10.5px] tabular-nums text-gray-500 dark:text-white/40">{t("memorySearch.usage", { entries: stats.entries, used: stats.memoryUsage.entriesUsed, runs: stats.memoryUsage.runsUsingMemory })}</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}{loadFailed && <> <button type="button" onClick={reload} className="underline">{t("memorySearch.retry")}</button></>}
        </p>
      )}
      {notice && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">{notice}</p>}
      {pendingSecret && (
        <div role="alert" className="flex flex-col gap-2 rounded-xl bg-amber-500/10 p-3 text-xs leading-4 text-amber-900 dark:text-amber-200">
          <p>{t("sharedMemory.secret", { key: pendingSecret.key })}</p>
          <div className="flex gap-2">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => decide(pendingSecret, true, true)}>{t("sharedMemory.confirmApprove")}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPendingSecret(null)}>{t("sharedMemory.cancel")}</Button>
          </div>
        </div>
      )}
      {tab === "workspace" && renderList("workspace")}
      {tab === "mission" && missionId && renderList("mission")}
      {tab === "facts" && (
        <RunFacts facts={facts} run={selectedRun} onPromote={openPromote} />
      )}
      {tab === "snapshot" && <RunSnapshot snapshot={snapshot} />}
      {detail && <MemoryHistory detail={detail} onClose={() => setDetail(null)} />}
      {form && <MemoryProposalForm form={form} busy={busy} secretPrompt={secretPrompt} fact={form.factId ? factById.get(form.factId) : undefined}
        allowMission={missionId !== null} onChange={(next) => { setSecretPrompt(false); setForm(next); }} onClose={closeForm} onSubmit={submit} />}
    </section>
  );
}

function MemoryEntryCard({ entry, busy, workspaceId, missionId, onInspect, onApprove, onReject, onEdit, onDelete, onPurged }: {
  entry: MemoryEntry;
  onPurged: () => void;
  busy: boolean;
  workspaceId: string;
  missionId: string | null;
  onInspect: () => void;
  onApprove: () => void;
  onReject: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const isActive = entry.status === "active" && entry.currentRevision !== null;
  const status = entry.pendingRevision !== null ? t("sharedMemory.status.pending") : entry.status === "deleted" ? t("sharedMemory.status.deleted") : isActive ? t("sharedMemory.status.active") : t("sharedMemory.status.none");
  return (
    <article className="flex flex-col gap-2 rounded-xl bg-gray-100/70 p-3 dark:bg-surface-raised/60 dark:shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.05)]">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="font-mono text-[12px] font-semibold text-gray-900 dark:text-gray-100">{entry.key}</span>
        <span className="inline-flex h-[18px] items-center rounded-full bg-gray-200/80 px-2 text-[10.5px] text-gray-700 dark:bg-white/[0.08] dark:text-gray-300">{KIND_LABEL[entry.kind]}</span>
        <span className={`${META}`}>{t("sharedMemory.priority", { n: entry.priority })}</span>
        <span className={`ml-auto text-[11px] font-medium ${entry.pendingRevision !== null ? "text-amber-700 dark:text-amber-300" : isActive ? "text-emerald-700 dark:text-emerald-300" : "text-gray-500 dark:text-white/40"}`}>{status}</span>
      </div>
      <p className={META}>
        {t("sharedMemory.revisionLine", { rev: entry.currentRevision ?? "—", actor: entry.authorKind ? actorLabel(entry.authorKind) : t("sharedMemory.status.none"), date: dateLabel(entry.updatedAt) })}
      </p>
      {(entry.sourceRunId || entry.sourceTaskId || entry.sourceFactId) && <p className="font-mono text-[10.5px] leading-[14px] text-gray-500 dark:text-white/40">{t("sharedMemory.origin", { run: entry.sourceRunId ?? "—", task: entry.sourceTaskId ?? "—", fact: entry.sourceFactId ?? "—" })}</p>}
      {entry.body !== null && <pre className={BODY}>{entry.body}</pre>}
      {(entry.bodyTruncated || entry.pendingBodyTruncated) && <p className="text-[10.5px] text-amber-700 dark:text-amber-300">{t("sharedMemory.truncatedPreview")}</p>}
      {entry.pendingRevision !== null && (
        <div className="flex flex-col gap-1.5 rounded-lg bg-amber-500/10 p-2.5">
          <p className="font-mono text-[10.5px] font-semibold leading-[14px] tabular-nums text-amber-800 dark:text-amber-300">
            {t("sharedMemory.proposalOf", { op: OPERATION_LABEL[entry.pendingOperation ?? "update"], rev: entry.pendingRevision, actor: entry.pendingActorKind ? actorLabel(entry.pendingActorKind) : t("sharedMemory.actor.agent"), date: entry.pendingCreatedAt ? dateLabel(entry.pendingCreatedAt) : "" })}
          </p>
          <p className={META}>{t("sharedMemory.kindPriorityRun", { kind: KIND_LABEL[entry.pendingKind ?? entry.kind], priority: entry.pendingPriority ?? entry.priority, run: entry.pendingSourceRunId ?? "—", task: entry.pendingSourceTaskId ?? "—" })}</p>
          {entry.pendingBody !== null && <pre className="whitespace-pre-wrap break-words text-[11.5px] leading-4 text-gray-800 dark:text-white/70">{entry.pendingBody}</pre>}
          {entry.pendingReason && <p className={META}>{t("sharedMemory.reason", { reason: entry.pendingReason })}</p>}
          {entry.pendingSourceFactId && <p className={META}>{t("sharedMemory.promotedFrom", { id: entry.pendingSourceFactId.slice(0, 8) })}</p>}
        </div>
      )}
      <VerificationLine entry={entry} busy={busy} />
      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onInspect}>{t("sharedMemory.viewRevisions")}</Button>
        <MemoryValidityHistory entry={entry} workspaceId={workspaceId} missionId={missionId} />
        {entry.pendingRevision !== null ? (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={onApprove} className="!bg-emerald-600 hover:!bg-emerald-500">{t("sharedMemory.approve")}</Button>
            <Button variant="danger" size="sm" disabled={busy} onClick={onReject}>{t("sharedMemory.reject")}</Button>
          </>
        ) : entry.status === "active" && entry.currentRevision !== null ? (
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={onEdit}>{t("sharedMemory.proposeEdit")}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={onDelete}>{t("sharedMemory.proposeDelete")}</Button>
          </>
        ) : null}
        <PurgeButton entryId={entry.id} entryKey={entry.key} disabled={busy} onDone={onPurged} />
      </div>
    </article>
  );
}

function VerificationLine({ entry, busy }: { entry: MemoryEntry; busy: boolean }) {
  const { t } = useTranslation();
  const v = verificationOf(entry, Math.floor(Date.now() / 1000));
  const canCheck = entry.currentRevision !== null;
  if (v.state === "none" && !canCheck) return null;
  const tone = v.state === "expired" || v.state === "never" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  return (
    <div className="flex flex-wrap items-center gap-2">
      {v.state === "none" ? <span className="text-[10.5px] text-gray-500 dark:text-white/40">{t("memorySearch.verify.none")}</span> : (
        <span data-verification={v.state} className={`inline-flex h-[18px] items-center rounded-full px-2 text-[10.5px] font-semibold ${tone}`}>
          {v.state === "never" ? t("memorySearch.verify.never", { ttl: v.ttlDays }) : t(v.ttlDays === null ? "memorySearch.verify.noTtl" : v.state === "expired" ? "memorySearch.verify.expired" : "memorySearch.verify.ok", { days: v.daysAgo, ttl: v.ttlDays })}
        </span>
      )}
      {canCheck && <SourceCheck entryId={entry.id} disabled={busy} />}
    </div>
  );
}

function MemoryProposalForm({ form, busy, secretPrompt, fact, allowMission, onChange, onClose, onSubmit }: {
  form: ProposalForm;
  busy: boolean;
  secretPrompt: boolean;
  fact?: Fact;
  allowMission: boolean;
  onChange: (form: ProposalForm) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
      if (event.key !== "Tab") return;
      const controls = [...(ref.current?.querySelectorAll<HTMLElement>("input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled])") ?? [])];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", handle);
    return () => { document.removeEventListener("keydown", handle); previous?.focus(); };
  }, [busy, onClose]);
  const set = <K extends keyof ProposalForm>(key: K, value: ProposalForm[K]) => onChange({ ...form, [key]: value });
  const deleting = form.mode === "delete";
  const promoting = form.mode === "promote";
  const { t } = useTranslation();
  const title = promoting ? t("sharedMemory.promoteTitle") : deleting ? t("sharedMemory.proposeDelete") : form.mode === "update" ? t("sharedMemory.proposeEdit") : t("sharedMemory.propose");
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[4px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={ref} role="dialog" aria-modal="true" aria-labelledby="memory-proposal-title"
        className="flex max-h-[90vh] w-full max-w-lg flex-col gap-3.5 overflow-y-auto rounded-2xl bg-gray-50 p-5 text-gray-900 shadow-[0_0_0_0.5px_rgba(255,255,255,0.08),0_10px_30px_rgba(0,0,0,0.45),0_2px_6px_rgba(0,0,0,0.3)] dark:bg-surface dark:text-white">
        <h4 id="memory-proposal-title" className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h4>
        {secretPrompt && <p role="alert" className="rounded-lg bg-amber-500/10 p-2.5 text-xs leading-4 text-amber-900 dark:text-amber-200">{t("sharedMemory.secretWarn")}</p>}
        {deleting && <p className="text-xs leading-4 text-gray-600 dark:text-white/55">{t("sharedMemory.deleteNote")}</p>}
        {promoting && <p className="text-xs leading-4 text-gray-600 dark:text-white/55">{t("sharedMemory.promoteNote")}</p>}
        {!deleting && (
          <>
            <label className={LABEL}>{t("sharedMemory.scope")}
              <span className="relative inline-flex">
                <PopupSelect value={form.scope} disabled={form.mode === "update"} onChange={(event) => set("scope", event.target.value as MemoryScope)} className="w-full">
                  <option value="workspace">{t("sharedMemory.tab.workspace")}</option>
                  {allowMission && <option value="mission">{t("sharedMemory.tab.mission")}</option>}
                </PopupSelect>
              </span>
            </label>
            <label className={LABEL}>{t("sharedMemory.key")}
              <input value={form.key} readOnly={form.mode === "update"} maxLength={128} onChange={(event) => set("key", event.target.value)} className={`h-7 font-mono ${FIELD}`} />
            </label>
            {!promoting && <label className={LABEL}>{t("sharedMemory.type")}
              <span className="relative inline-flex">
                <PopupSelect value={form.kind} onChange={(event) => set("kind", event.target.value as MemoryKind)} className="w-full">
                  {KINDS.map((kind) => <option key={kind} value={kind}>{KIND_LABEL[kind]}</option>)}
                </PopupSelect>
              </span>
            </label>}
            <label className={LABEL}>{t("sharedMemory.content")}
              <textarea value={promoting ? fact?.body ?? form.body : form.body} readOnly={promoting} maxLength={4096} rows={5} onChange={(event) => set("body", event.target.value)} className={`resize-y py-2 leading-4 ${FIELD}`} />
            </label>
            <label className={LABEL}>{t("sharedMemory.priorityField", { n: form.priority })}
              <input type="range" className="w-full accent-accent-500" min={-10} max={10} value={form.priority} onChange={(event) => set("priority", Number(event.target.value))} />
            </label>
          </>
        )}
        <label className={LABEL}>{t("sharedMemory.reasonOptional")}
          <textarea value={form.reason} maxLength={512} rows={2} onChange={(event) => set("reason", event.target.value)} className={`resize-y py-2 leading-4 ${FIELD}`} />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>{t("sharedMemory.cancel")}</Button>
          <Button variant="primary" size="sm" disabled={busy || !form.key.trim() || !deleting && !form.body.trim()} onClick={onSubmit}>{secretPrompt ? t("sharedMemory.saveAnyway") : t("sharedMemory.send")}</Button>
        </div>
      </section>
    </div>
  );
}

function MemoryHistory({ detail, onClose }: { detail: MemoryDetail; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <section className={`flex flex-col gap-2 ${SUBPANEL}`}>
      <div className="flex items-center gap-2"><h4 className="mr-auto text-xs font-semibold text-gray-900 dark:text-gray-100">{t("sharedMemory.historyTitle", { key: detail.entry.key })}</h4><Button variant="ghost" size="sm" onClick={onClose}>{t("sharedMemory.close")}</Button></div>
      {detail.revisions.map((revision) => (
        <article key={revision.revision} className="flex flex-col gap-1 border-t border-gray-200 pt-2 dark:border-white/[0.08]">
          <p className={`${META} font-semibold`}>{t("sharedMemory.revLine", { rev: revision.revision, status: t(`sharedMemory.rev.${revision.status}`), op: OPERATION_LABEL[revision.operation], actor: actorLabel(revision.actorKind), date: dateLabel(revision.createdAt) })}</p>
          <p className={META}>{t("sharedMemory.kindPriority", { kind: KIND_LABEL[revision.kind], priority: revision.priority })}{revision.expectedRevision !== null ? t("sharedMemory.basedOn", { rev: revision.expectedRevision }) : ""}</p>
          <pre className={BODY}>{revision.body}</pre>
          {revision.reason && <p className={META}>{t("sharedMemory.reason", { reason: revision.reason })}</p>}
          {(revision.sourceRunId || revision.sourceTaskId || revision.sourceFactId) && <p className={META}>{t("sharedMemory.sourceLine", { from: revision.sourceFactId ? t("sharedMemory.fromFact", { id: revision.sourceFactId.slice(0, 8) }) : t("sharedMemory.fromRun"), task: revision.sourceTaskId ? ` · ${tr("sharedMemory.task")} ${revision.sourceTaskId.slice(0, 8)}` : "" })}</p>}
        </article>
      ))}
    </section>
  );
}

export function localeForLanguage(language: string): string {
  if (language.startsWith("es")) return "es-ES";
  if (language.startsWith("en")) return "en-US";
  return "pt-BR";
}

function MemoryValidityHistory({ entry, workspaceId, missionId }: {
  entry: MemoryEntry;
  workspaceId: string;
  missionId: string | null;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [intervals, setIntervals] = useState<MemoryValidityInterval[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toggle = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (intervals !== null) return;
    setBusy(true);
    setError("");
    try {
      const data = await memoryIpc.getMemoryHistory(entry.id, workspaceId, entry.scope === "mission" ? missionId : null);
      setIntervals(data);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const locale = localeForLanguage(i18n?.language ?? "pt-BR");
  const formatDate = (timestamp: number) => new Date(timestamp * 1000).toLocaleString(locale);
  return (
    <>
      <Button variant="ghost" size="sm" disabled={busy} onClick={toggle}>{t("memory.history.toggle")}</Button>
      {open && (
        <section className={`basis-full flex flex-col gap-2 ${SUBPANEL}`}>
          <div className="flex items-center gap-2">
            <h4 className="mr-auto text-xs font-semibold text-gray-900 dark:text-gray-100">{t("memory.history.title", { key: entry.key })}</h4>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>{t("memory.history.close")}</Button>
          </div>
          {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          {busy && intervals === null && <p className="text-xs text-gray-400 dark:text-white/40">{t("sharedMemory.loading")}</p>}
          {intervals !== null && intervals.length === 0 && <p className="text-xs text-gray-400 dark:text-white/40">{t("memory.history.empty")}</p>}
          {intervals?.slice().reverse().map((interval) => (
            <article key={interval.revision} className="flex flex-col gap-1 border-t border-gray-200 pt-2 dark:border-white/[0.08]">
              <p className={`${META} font-semibold`}>{t("sharedMemory.revOpActor", { rev: interval.revision, op: OPERATION_LABEL[interval.operation], actor: actorLabel(interval.actorKind) })}</p>
              <p className={META}>{t("sharedMemory.kindPriority", { kind: KIND_LABEL[interval.kind], priority: interval.priority })}</p>
              <pre className={BODY}>{interval.body}</pre>
              {interval.reason && <p className={META}>{t("sharedMemory.reason", { reason: interval.reason })}</p>}
              <p className={META}>
                {t("memory.history.validFrom", { date: formatDate(interval.validFrom) })}{" "}
                {interval.validTo !== null ? t("memory.history.validUntil", { date: formatDate(interval.validTo) }) : t("memory.history.ongoing")}
              </p>
            </article>
          ))}
        </section>
      )}
    </>
  );
}

function RunFacts({ facts, run, onPromote }: { facts: Fact[]; run: Run | null; onPromote: (fact: Fact) => void }) {
  const { t } = useTranslation();
  if (!run) return <p className="text-xs text-gray-400 dark:text-white/40">{t("sharedMemory.noRun")}</p>;
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[10.5px] leading-[14px] text-gray-500 dark:text-white/40">{t("sharedMemory.factsInfo")}</p>
      {facts.length === 0 && <p className="text-xs text-gray-400 dark:text-white/40">{t("sharedMemory.noFacts")}</p>}
      {facts.map((fact) => (
        <article key={fact.id} className={`flex flex-col gap-2 ${CARD}`}>
          <div className="flex flex-wrap items-center gap-2 text-[10.5px]"><span className="font-semibold text-gray-900 dark:text-gray-100">{KIND_LABEL[fact.kind]}</span><span className={META}>{fact.author ?? t("sharedMemory.actor.user")} · {dateLabel(fact.createdAt)}</span><span className="ml-auto" /><Button variant="ghost" size="sm" onClick={() => onPromote(fact)}>{t("sharedMemory.promote")}</Button></div>
          <pre className="whitespace-pre-wrap break-words text-[11.5px] leading-4 text-gray-800 dark:text-white/70">{fact.body}</pre>
        </article>
      ))}
    </div>
  );
}

function RunSnapshot({ snapshot }: { snapshot: MemorySnapshot | null }) {
  const { t } = useTranslation();
  if (!snapshot) return <p className="text-xs text-gray-400 dark:text-white/40">{t("sharedMemory.loadingSnapshot")}</p>;
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[10.5px] leading-[14px] text-gray-500 dark:text-white/40">{t("sharedMemory.snapshotInfo", { bytes: snapshot.meta.contextBytes, omitted: snapshot.meta.omittedEntries, truncated: snapshot.meta.truncatedEntries })}</p>
      {snapshot.items.length === 0 && <p className="text-xs text-gray-400 dark:text-white/40">{t("sharedMemory.snapshotEmpty")}</p>}
      {snapshot.items.map((item) => (
        <article key={`${item.selectionOrder}-${item.entryId}`} className={`flex flex-col gap-1.5 ${CARD}`}>
          <p className={`${META} font-semibold text-gray-700 dark:text-gray-200`}>{t("sharedMemory.snapshotItem", { n: item.selectionOrder + 1, scope: item.scope === "mission" ? "Mission" : "Workspace", key: item.key, kind: KIND_LABEL[item.kind], priority: item.priority, rev: item.revision, truncated: item.truncated ? t("sharedMemory.truncatedFlag") : "" })}</p>
          <pre className="whitespace-pre-wrap break-words text-[11.5px] leading-4 text-gray-800 dark:text-white/70">{item.body}</pre>
        </article>
      ))}
    </div>
  );
}

function actorLabel(actor: string): string {
  if (actor === "user") return tr("sharedMemory.actor.user");
  if (actor === "lead") return tr("sharedMemory.actor.lead");
  if (actor === "worker") return tr("sharedMemory.actor.worker");
  if (actor === "dreamer") return tr("sharedMemory.actor.dreamer");
  return actor;
}

function dateLabel(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString(localeForLanguage(i18next.language ?? "pt-BR"));
}
