import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import type { Fact, Run } from "@/features/runs/types";
import * as memoryIpc from "./ipc";
import type { MemoryDetail, MemoryEntry, MemoryKind, MemoryPage, MemoryProposal, MemoryScope, MemorySnapshot, MemoryValidityInterval } from "./types";

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
const KIND_LABEL: Record<MemoryKind, string> = {
  decision: "Decisão",
  finding: "Descoberta",
  file: "Arquivo",
  constraint: "Restrição",
  note: "Nota",
};
const OPERATION_LABEL = { create: "criação", update: "atualização", delete: "exclusão" } as const;

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
  const [refreshKey, setRefreshKey] = useState(0);
  const [runSelection, setRunSelection] = useState<string | null>(null);
  const selectedRunId = runs.some((run) => run.id === runSelection)
    ? runSelection
    : activeRunId ?? runs[0]?.id ?? null;
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;
  const factById = useMemo(() => new Map(facts.map((fact) => [fact.id, fact])), [facts]);

  useEffect(() => {
    let current = true;
    setBusy(true);
    setError("");
    const memoryRequests = Promise.all([
      memoryIpc.listMemory(workspaceId, null),
      missionId ? memoryIpc.listMemory(workspaceId, missionId) : Promise.resolve(null),
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
      if (current) setError(String(cause));
    }).finally(() => {
      if (current) setBusy(false);
    });
    return () => { current = false; };
  }, [workspaceId, missionId, selectedRunId, refreshKey]);

  useEffect(() => {
    const offMemory = listen("cc-memory-changed", () => setRefreshKey((value) => value + 1));
    const offFacts = listen<string>("cc-run-facts", (event) => { if (event.payload === selectedRunId) setRefreshKey((value) => value + 1); });
    return () => { for (const off of [offMemory, offFacts]) off.then((unlisten) => unlisten()).catch(() => {}); };
  }, [selectedRunId]);

  const closeForm = useCallback(() => setForm(null), []);
  const reload = () => setRefreshKey((value) => value + 1);
  const loadMore = async (scope: MemoryScope) => {
    const page = scope === "workspace" ? workspacePage : missionPage;
    if (!page?.nextCursor || !missionId && scope === "mission") return;
    setBusy(true);
    try {
      const next = await memoryIpc.listMemory(workspaceId, scope === "mission" ? missionId : null, page.nextCursor);
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
        if (!selectedRunId || !form.factId) throw new Error("Selecione um Run Fact válido.");
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
        await memoryIpc.proposeMemory(workspaceId, form.scope === "mission" ? missionId : null, proposal);
      }
      setForm(null);
      setDetail(null);
      reload();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (entry: MemoryEntry, approve: boolean) => {
    if (entry.pendingRevision === null) return;
    setBusy(true);
    setError("");
    try {
      await memoryIpc.decideMemory(entry.id, entry.pendingRevision, approve);
      setDetail(null);
      reload();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const openCreate = (scope: MemoryScope) => setForm({
    mode: "create", scope, key: "", kind: "note", body: "", priority: 0, reason: "",
  });
  const openEdit = (entry: MemoryEntry) => {
    if (entry.currentRevision === null || entry.body === null) return;
    setForm({
      mode: "update", scope: entry.scope, key: entry.key, kind: entry.kind, body: entry.body,
      priority: entry.priority, reason: "", entryId: entry.id, expectedRevision: entry.currentRevision,
    });
  };
  const openDelete = (entry: MemoryEntry) => {
    if (entry.currentRevision === null || entry.body === null) return;
    setForm({
      mode: "delete", scope: entry.scope, key: entry.key, kind: entry.kind, body: entry.body,
      priority: entry.priority, reason: "", entryId: entry.id, expectedRevision: entry.currentRevision,
    });
  };
  const openPromote = (fact: Fact) => setForm({
    mode: "promote", scope: selectedRun?.missionId ? "mission" : "workspace", key: "",
    kind: fact.kind, body: fact.body, priority: 0, reason: "", factId: fact.id,
  });
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
    if (!page) return <p className="text-xs text-gray-400">Carregando memórias…</p>;
    return (
      <div className="flex flex-col gap-2">
        {page.items.length === 0 && <p className="text-xs text-gray-400">Nenhuma memória registrada.</p>}
        {page.items.map((entry) => (
          <MemoryEntryCard key={entry.id} entry={entry} busy={busy} workspaceId={workspaceId} missionId={missionId}
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
        {page.truncated && <p className="text-[10px] text-amber-700 dark:text-amber-300">A lista foi limitada pelo tamanho da resposta. Use “Carregar mais” para continuar.</p>}
        {page.hasMore && <Button variant="ghost" size="sm" disabled={busy} onClick={() => loadMore(scope)}>Carregar mais</Button>}
      </div>
    );
  };

  const tabs: { id: MemoryTab; label: string; disabled?: boolean }[] = [
    { id: "workspace", label: "Memória do Workspace" },
    ...(missionId ? [{ id: "mission" as const, label: "Memória da Mission" }] : []),
    ...(selectedRunId ? [{ id: "facts" as const, label: "Run Facts" }, { id: "snapshot" as const, label: "Snapshot do Run" }] : []),
  ];

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-gray-200 p-4 dark:border-white/10">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-[11px] font-bold uppercase tracking-wider text-gray-500 dark:text-white/45">Memória compartilhada</h3>
        {selectedRunId && runs.length > 1 && (
          <label className="flex items-center gap-2 text-[10px] text-gray-500 dark:text-white/45">
            Run
            <select aria-label="Selecionar Run" value={selectedRunId} onChange={(event) => setRunSelection(event.target.value)}
              className="rounded border border-gray-200 bg-white px-2 py-1 text-xs dark:border-white/10 dark:bg-neutral-900">
              {runs.map((run, index) => <option key={run.id} value={run.id}>#{runs.length - index} · {run.status} · {run.id.slice(0, 8)}</option>)}
            </select>
          </label>
        )}
        {(tab === "workspace" || tab === "mission") && (
          <Button variant="primary" size="sm" disabled={busy || tab === "mission" && !missionId}
            onClick={() => openCreate(tab === "mission" ? "mission" : "workspace")}>Propor memória</Button>
        )}
      </div>

      <div role="tablist" aria-label="Seções de memória" className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-white/8">
        {tabs.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
            onClick={() => { setTab(item.id); setDetail(null); }}
            className={`px-2.5 py-2 text-[11px] border-b-2 ${tab === item.id ? "border-violet-500 text-violet-700 dark:text-violet-300" : "border-transparent text-gray-500 hover:text-gray-800 dark:text-white/45 dark:hover:text-white"}`}>
            {item.label}
          </button>
        ))}
      </div>

      {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {tab === "workspace" && renderList("workspace")}
      {tab === "mission" && missionId && renderList("mission")}
      {tab === "facts" && (
        <RunFacts facts={facts} run={selectedRun} onPromote={openPromote} />
      )}
      {tab === "snapshot" && <RunSnapshot snapshot={snapshot} />}
      {detail && <MemoryHistory detail={detail} onClose={() => setDetail(null)} />}
      {form && <MemoryProposalForm form={form} busy={busy} fact={form.factId ? factById.get(form.factId) : undefined}
        allowMission={missionId !== null} onChange={setForm} onClose={closeForm} onSubmit={submit} />}
    </section>
  );
}

function MemoryEntryCard({ entry, busy, workspaceId, missionId, onInspect, onApprove, onReject, onEdit, onDelete }: {
  entry: MemoryEntry;
  busy: boolean;
  workspaceId: string;
  missionId: string | null;
  onInspect: () => void;
  onApprove: () => void;
  onReject: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isActive = entry.status === "active" && entry.currentRevision !== null;
  const status = entry.pendingRevision !== null ? "Proposta pendente" : entry.status === "deleted" ? "Excluída" : isActive ? "Ativa" : "Sem revisão aprovada";
  return (
    <article className="flex flex-col gap-2 rounded-lg border border-gray-200 px-3 py-2.5 dark:border-white/10">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="font-mono font-semibold text-gray-800 dark:text-gray-100">{entry.key}</span>
        <span className="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-white/8">{KIND_LABEL[entry.kind]}</span>
        <span className="text-gray-500 dark:text-white/45">Prioridade {entry.priority}</span>
        <span className={`ml-auto ${entry.pendingRevision !== null ? "text-amber-700 dark:text-amber-300" : isActive ? "text-emerald-700 dark:text-emerald-300" : "text-gray-400"}`}>{status}</span>
      </div>
      <p className="text-[10px] text-gray-400 dark:text-white/35">
        Revisão {entry.currentRevision ?? "—"} · {entry.authorKind ? actorLabel(entry.authorKind) : "Sem revisão aprovada"} · {dateLabel(entry.updatedAt)}
      </p>
      {(entry.sourceRunId || entry.sourceTaskId || entry.sourceFactId) && <p className="text-[10px] text-gray-500">Origem: Run {entry.sourceRunId ?? "—"} · Task {entry.sourceTaskId ?? "—"} · Fact {entry.sourceFactId ?? "—"}</p>}
      {entry.body !== null && <pre className="whitespace-pre-wrap break-words rounded bg-gray-50 p-2 text-[11px] text-gray-700 dark:bg-white/4 dark:text-white/65">{entry.body}</pre>}
      {(entry.bodyTruncated || entry.pendingBodyTruncated) && <p className="text-[10px] text-amber-700 dark:text-amber-300">Prévia limitada. Use “Ver revisões” para ler o conteúdo completo.</p>}
      {entry.pendingRevision !== null && (
        <div className="flex flex-col gap-1 rounded-md border border-amber-300/50 bg-amber-50/70 p-2 dark:border-amber-300/15 dark:bg-amber-300/5">
          <p className="text-[10px] font-semibold text-amber-800 dark:text-amber-300">
            Proposta de {OPERATION_LABEL[entry.pendingOperation ?? "update"]} · revisão {entry.pendingRevision} · {entry.pendingActorKind ? actorLabel(entry.pendingActorKind) : "Agente"} · {entry.pendingCreatedAt ? dateLabel(entry.pendingCreatedAt) : ""}
          </p>
          <p className="text-[10px]">{KIND_LABEL[entry.pendingKind ?? entry.kind]} · prioridade {entry.pendingPriority ?? entry.priority} · Run {entry.pendingSourceRunId ?? "—"} · Task {entry.pendingSourceTaskId ?? "—"}</p>
          {entry.pendingBody !== null && <pre className="whitespace-pre-wrap break-words text-[11px] text-gray-700 dark:text-white/65">{entry.pendingBody}</pre>}
          {entry.pendingReason && <p className="text-[10px] text-gray-500 dark:text-white/45">Motivo: {entry.pendingReason}</p>}
          {entry.pendingSourceFactId && <p className="text-[10px] text-gray-500 dark:text-white/45">Promovido do Run Fact {entry.pendingSourceFactId.slice(0, 8)}</p>}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onInspect}>Ver revisões</Button>
        <MemoryValidityHistory entry={entry} workspaceId={workspaceId} missionId={missionId} />
        {entry.pendingRevision !== null ? (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={onApprove}>Aprovar</Button>
            <Button variant="danger" size="sm" disabled={busy} onClick={onReject}>Rejeitar</Button>
          </>
        ) : entry.status === "active" && entry.currentRevision !== null ? (
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={onEdit}>Propor edição</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={onDelete}>Propor exclusão</Button>
          </>
        ) : null}
      </div>
    </article>
  );
}

function MemoryProposalForm({ form, busy, fact, allowMission, onChange, onClose, onSubmit }: {
  form: ProposalForm;
  busy: boolean;
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
  const title = promoting ? "Promover Run Fact" : deleting ? "Propor exclusão" : form.mode === "update" ? "Propor edição" : "Propor memória";
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={ref} role="dialog" aria-modal="true" aria-labelledby="memory-proposal-title" className="flex max-h-[90vh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-xl border border-gray-200 bg-white p-4 shadow-xl dark:border-white/10 dark:bg-neutral-900">
        <h4 id="memory-proposal-title" className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h4>
        {deleting && <p className="text-xs text-gray-600 dark:text-white/55">A exclusão será registrada como proposta. A memória continuará ativa até a aprovação do usuário.</p>}
        {promoting && <p className="text-xs text-gray-600 dark:text-white/55">A promoção cria uma proposta pendente; o Run Fact original permanece separado e inalterado.</p>}
        {!deleting && (
          <>
            <label className="flex flex-col gap-1 text-[11px] text-gray-600 dark:text-white/55">Escopo
              <select value={form.scope} disabled={form.mode === "update"} onChange={(event) => set("scope", event.target.value as MemoryScope)} className="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs dark:border-white/10 dark:bg-neutral-950">
                <option value="workspace">Memória do Workspace</option>
                {allowMission && <option value="mission">Memória da Mission</option>}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-gray-600 dark:text-white/55">Chave
              <input value={form.key} readOnly={form.mode === "update"} maxLength={128} onChange={(event) => set("key", event.target.value)} className="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs dark:border-white/10 dark:bg-neutral-950" />
            </label>
            {!promoting && <label className="flex flex-col gap-1 text-[11px] text-gray-600 dark:text-white/55">Tipo
              <select value={form.kind} onChange={(event) => set("kind", event.target.value as MemoryKind)} className="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs dark:border-white/10 dark:bg-neutral-950">
                {KINDS.map((kind) => <option key={kind} value={kind}>{KIND_LABEL[kind]}</option>)}
              </select>
            </label>}
            <label className="flex flex-col gap-1 text-[11px] text-gray-600 dark:text-white/55">Conteúdo
              <textarea value={promoting ? fact?.body ?? form.body : form.body} readOnly={promoting} maxLength={4096} rows={5} onChange={(event) => set("body", event.target.value)} className="resize-y rounded border border-gray-200 bg-white px-2 py-1.5 text-xs dark:border-white/10 dark:bg-neutral-950" />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-gray-600 dark:text-white/55">Prioridade ({form.priority})
              <input type="range" min={-10} max={10} value={form.priority} onChange={(event) => set("priority", Number(event.target.value))} />
            </label>
          </>
        )}
        <label className="flex flex-col gap-1 text-[11px] text-gray-600 dark:text-white/55">Motivo (opcional)
          <textarea value={form.reason} maxLength={512} rows={2} onChange={(event) => set("reason", event.target.value)} className="resize-y rounded border border-gray-200 bg-white px-2 py-1.5 text-xs dark:border-white/10 dark:bg-neutral-950" />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>Cancelar</Button>
          <Button variant="primary" size="sm" disabled={busy || !form.key.trim() || !deleting && !form.body.trim()} onClick={onSubmit}>Enviar proposta</Button>
        </div>
      </section>
    </div>
  );
}

function MemoryHistory({ detail, onClose }: { detail: MemoryDetail; onClose: () => void }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-violet-300/40 bg-violet-50/50 p-3 dark:border-violet-300/15 dark:bg-violet-300/5">
      <div className="flex items-center gap-2"><h4 className="mr-auto text-xs font-semibold">Histórico: {detail.entry.key}</h4><Button variant="ghost" size="sm" onClick={onClose}>Fechar</Button></div>
      {detail.revisions.map((revision) => (
        <article key={revision.revision} className="flex flex-col gap-1 border-t border-gray-200 pt-2 dark:border-white/8">
          <p className="text-[10px] font-semibold">Revisão {revision.revision} · {revision.status === "proposed" ? "Pendente" : revision.status === "approved" ? "Aprovada" : "Rejeitada"} · {OPERATION_LABEL[revision.operation]} · {actorLabel(revision.actorKind)} · {dateLabel(revision.createdAt)}</p>
          <p className="text-[10px] text-gray-500 dark:text-white/45">{KIND_LABEL[revision.kind]} · prioridade {revision.priority}{revision.expectedRevision !== null ? ` · baseada na revisão ${revision.expectedRevision}` : ""}</p>
          <pre className="whitespace-pre-wrap break-words rounded bg-white/70 p-2 text-[11px] dark:bg-black/15">{revision.body}</pre>
          {revision.reason && <p className="text-[10px] text-gray-500 dark:text-white/45">Motivo: {revision.reason}</p>}
          {(revision.sourceRunId || revision.sourceTaskId || revision.sourceFactId) && <p className="text-[10px] text-gray-500 dark:text-white/45">Origem: {revision.sourceFactId ? `Run Fact ${revision.sourceFactId.slice(0, 8)}` : "Run"}{revision.sourceTaskId ? ` · Task ${revision.sourceTaskId.slice(0, 8)}` : ""}</p>}
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
        <section className="basis-full flex flex-col gap-2 rounded-lg border border-violet-300/40 bg-violet-50/50 p-3 dark:border-violet-300/15 dark:bg-violet-300/5">
          <div className="flex items-center gap-2">
            <h4 className="mr-auto text-xs font-semibold">{t("memory.history.title", { key: entry.key })}</h4>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>{t("memory.history.close")}</Button>
          </div>
          {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          {busy && intervals === null && <p className="text-xs text-gray-400">Carregando…</p>}
          {intervals !== null && intervals.length === 0 && <p className="text-xs text-gray-400">{t("memory.history.empty")}</p>}
          {intervals?.slice().reverse().map((interval) => (
            <article key={interval.revision} className="flex flex-col gap-1 border-t border-gray-200 pt-2 dark:border-white/8">
              <p className="text-[10px] font-semibold">Revisão {interval.revision} · {OPERATION_LABEL[interval.operation]} · {actorLabel(interval.actorKind)}</p>
              <p className="text-[10px] text-gray-500 dark:text-white/45">{KIND_LABEL[interval.kind]} · prioridade {interval.priority}</p>
              <pre className="whitespace-pre-wrap break-words rounded bg-white/70 p-2 text-[11px] dark:bg-black/15">{interval.body}</pre>
              {interval.reason && <p className="text-[10px] text-gray-500 dark:text-white/45">Motivo: {interval.reason}</p>}
              <p className="text-[10px] text-gray-500 dark:text-white/45">
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
  if (!run) return <p className="text-xs text-gray-400">Esta Mission ainda não possui Run.</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] text-gray-500 dark:text-white/45">Run Facts são dados de colaboração de um único Run. Não são Mission Memory nem Workspace Memory.</p>
      {facts.length === 0 && <p className="text-xs text-gray-400">Este Run ainda não tem fatos compartilhados.</p>}
      {facts.map((fact) => (
        <article key={fact.id} className="flex flex-col gap-1 rounded-lg border border-gray-200 p-3 dark:border-white/10">
          <div className="flex flex-wrap items-center gap-2 text-[10px]"><span className="font-semibold">{KIND_LABEL[fact.kind]}</span><span className="text-gray-500 dark:text-white/45">{fact.author ?? "Usuário"} · {dateLabel(fact.createdAt)}</span><span className="ml-auto" /><Button variant="ghost" size="sm" onClick={() => onPromote(fact)}>Propor promoção</Button></div>
          <pre className="whitespace-pre-wrap break-words text-[11px] text-gray-700 dark:text-white/65">{fact.body}</pre>
        </article>
      ))}
    </div>
  );
}

function RunSnapshot({ snapshot }: { snapshot: MemorySnapshot | null }) {
  if (!snapshot) return <p className="text-xs text-gray-400">Carregando snapshot…</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] text-gray-500 dark:text-white/45">Snapshot usado neste Run: cópia imutável das memórias aprovadas quando o Run começou · {snapshot.meta.contextBytes} bytes de contexto · {snapshot.meta.omittedEntries} omitidas · {snapshot.meta.truncatedEntries} truncadas.</p>
      {snapshot.items.length === 0 && <p className="text-xs text-gray-400">Snapshot vazio: nenhuma memória aprovada foi selecionada para este Run.</p>}
      {snapshot.items.map((item) => (
        <article key={`${item.selectionOrder}-${item.entryId}`} className="flex flex-col gap-1 rounded-lg border border-gray-200 p-3 dark:border-white/10">
          <p className="text-[10px] font-semibold">{item.selectionOrder + 1}. [{item.scope === "mission" ? "Mission" : "Workspace"}] {item.key} · {KIND_LABEL[item.kind]} · prioridade {item.priority} · revisão {item.revision}{item.truncated ? " · truncada" : ""}</p>
          <pre className="whitespace-pre-wrap break-words text-[11px] text-gray-700 dark:text-white/65">{item.body}</pre>
        </article>
      ))}
    </div>
  );
}

function actorLabel(actor: string): string {
  if (actor === "user") return "Usuário";
  if (actor === "lead") return "Lead";
  if (actor === "worker") return "Worker";
  return actor;
}

function dateLabel(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString("pt-BR");
}
