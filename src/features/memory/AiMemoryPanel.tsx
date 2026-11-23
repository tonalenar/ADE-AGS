import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";
import { PopupSelect } from "@/shared/ui/PopupSelect";

import {
  forgetSweepHours,
  formatCreatedAt,
  groupPendingHandoffs,
  groupSearchHitsByProject,
  guessProject,
  pageExpiryStatus,
  parseSnippet,
  projectKey,
  type AiMemoryForgetSweep,
  type AiMemoryHandoff,
  type AiMemoryPage,
  type AiMemoryProbe,
  type AiMemoryProject,
  type AiMemoryRecentPage,
  type AiMemorySearchHit,
  type AiMemorySession,
} from "./aiMemory";
import { AiMemoryMigration } from "./AiMemoryMigration";
import {
  aiMemoryDisableForgetSweep,
  aiMemoryHandoffs,
  aiMemoryPinPage,
  aiMemoryProbe,
  aiMemoryProjects,
  aiMemoryReadPage,
  aiMemoryRecent,
  aiMemoryRenewPage,
  aiMemorySearch,
  aiMemorySessions,
} from "./aiMemoryIpc";
import { compactMemory } from "./ipc";

interface Loaded {
  probe: AiMemoryProbe;
  pages: AiMemoryRecentPage[];
  handoffs: AiMemoryHandoff[];
}

const COMPACT_RETENTION_DAYS = 30;

/** Trecho de busca do ai-memory como texto puro, com os termos achados destacados. */
function Snippet({ text }: { text: string }) {
  return (
    <span className="text-gray-500 dark:text-gray-400">
      {parseSnippet(text).map((seg, i) => seg.highlight
        ? <mark key={i} className="rounded-sm bg-accent-500/20 px-0.5 text-inherit">{seg.text}</mark>
        : <span key={i}>{seg.text}</span>)}
    </span>
  );
}

/** Selo de vencimento ou fixação de uma página do ai-memory. */
function ExpiryBadge({
  page,
}: {
  page: { expired?: boolean; expires_at?: string | null; pinned?: boolean; frontmatter?: unknown };
}) {
  const { t } = useTranslation();
  const status = pageExpiryStatus(page);
  if (status.kind === "ok") return null;
  if (status.kind === "pinned") {
    return (
      <span className="ml-1.5 rounded bg-accent-500/15 px-1 py-0.5 text-[10px] font-medium text-accent-700 dark:text-accent-300">
        {t("aiMemory.pinnedBadge")}
      </span>
    );
  }
  if (status.kind === "expired") {
    return (
      <span className="ml-1.5 rounded bg-amber-500/15 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
        {t("aiMemory.expiredBadge")}
      </span>
    );
  }
  return (
    <span className="ml-1.5 rounded bg-amber-500/15 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
      {status.daysLeft === 0
        ? t("aiMemory.expiresToday")
        : t("aiMemory.expiresInDays", { count: status.daysLeft })}
    </span>
  );
}

/**
 * Últimas sessões de um projeto do ai-memory. O caminho das sessões não conhece a pasta da aba, por
 * isso o projeto é escolhido explicitamente: começa pelo de nome igual ao da pasta e pode ser trocado.
 */
function Sessions({ cwd }: { cwd: string }) {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<AiMemoryProject[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [sessions, setSessions] = useState<AiMemorySession[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    aiMemoryProjects(cwd).then((r) => {
      if (!alive) return;
      setProjects(r.data);
      const guess = guessProject(r.data, cwd);
      setSelected(guess ? projectKey(guess) : "");
    }).catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [cwd]);

  useEffect(() => {
    const project = projects?.find((p) => projectKey(p) === selected);
    setSessions(null);
    if (!project) return;
    let alive = true;
    aiMemorySessions(cwd, project.workspace_name, project.project_name)
      .then((r) => { if (alive) setSessions(r.data); })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [projects, selected, cwd]);

  if (error) return <p className="text-red-500" role="alert">{t("aiMemory.error", { error })}</p>;
  if (!projects) return <p className="text-gray-500" role="status">{t("aiMemory.loading")}</p>;
  if (projects.length === 0) return <p className="text-gray-500">{t("aiMemory.noProjects")}</p>;
  return (
    <div className="grid gap-1">
      <PopupSelect aria-label={t("aiMemory.project")} value={selected} placeholder={t("aiMemory.pickProject")}
        onChange={(event) => setSelected(event.target.value)} className="min-w-44">
        {projects.map((p) => <option key={projectKey(p)} value={projectKey(p)}>{projectKey(p)}</option>)}
      </PopupSelect>
      {selected && sessions?.length === 0 && <p className="text-gray-500">{t("aiMemory.sessionsEmpty")}</p>}
      {sessions && sessions.length > 0 && (
        <ul className="grid gap-0.5">
          {sessions.map((s) => (
            <li key={s.session_id}>
              {t("aiMemory.sessionLine", { agent: s.agent_kind, when: s.last_activity_at })}
              {s.current && <span className="ml-1 text-gray-500">· {t("aiMemory.sessionCurrent")}</span>}
              {s.handed_off && <span className="ml-1 text-gray-500">· {t("aiMemory.sessionHandedOff")}</span>}
              {s.ended && <span className="ml-1 text-gray-500">· {t("aiMemory.sessionEnded")}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Painel "Memória" do ai-memory: busca, wiki do projeto da pasta com aviso de vencimento e
 * renovação/fixação, alerta de apagamento automático, handoffs pendentes, últimas sessões e
 * compactação do histórico rejeitado do banco legado. Tudo que vem do ai-memory chega no envelope
 * UNTRUSTED e é mostrado como texto puro, nunca HTML.
 */
export function AiMemoryPanel({ cwd, workspaceId }: { cwd: string; workspaceId?: string | null }) {
  const { t, i18n } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<AiMemoryPage | null>(null);
  const [pageBusy, setPageBusy] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<AiMemorySearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [sweepDialogOpen, setSweepDialogOpen] = useState(false);
  const [sweepBusy, setSweepBusy] = useState(false);
  const [sweepError, setSweepError] = useState<string | null>(null);

  const [compactDialogOpen, setCompactDialogOpen] = useState(false);
  const [compactBusy, setCompactBusy] = useState(false);
  const [compactResult, setCompactResult] = useState<number | null>(null);
  const [compactError, setCompactError] = useState<string | null>(null);

  const loadSeqRef = useRef(0);
  const pageSeqRef = useRef(0);
  const searchSeqRef = useRef(0);

  const load = useCallback(async () => {
    const reqId = ++loadSeqRef.current;
    setError(null);
    if (!cwd) {
      setLoaded(null);
      return;
    }
    try {
      const probe = (await aiMemoryProbe(cwd)).data;
      if (loadSeqRef.current !== reqId) return;
      if (probe.state !== "ok") {
        setLoaded({ probe, pages: [], handoffs: [] });
        return;
      }
      const [pages, handoffs] = await Promise.all([aiMemoryRecent(cwd), aiMemoryHandoffs(cwd)]);
      if (loadSeqRef.current !== reqId) return;
      setLoaded({ probe, pages: pages.data, handoffs: handoffs.data });
    } catch (e) {
      if (loadSeqRef.current !== reqId) return;
      setError(String(e));
    }
  }, [cwd]);

  useEffect(() => {
    pageSeqRef.current += 1;
    searchSeqRef.current += 1;
    setLoaded(null);
    setPage(null);
    setSearchQuery("");
    setSearchHits(null);
    setSearchError(null);
    setSweepDialogOpen(false);
    setSweepError(null);
    void load();
    return () => {
      loadSeqRef.current += 1;
      pageSeqRef.current += 1;
      searchSeqRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    const onChanged = () => { void load(); };
    window.addEventListener("ade-ai-memory-changed", onChanged);
    return () => window.removeEventListener("ade-ai-memory-changed", onChanged);
  }, [load]);

  const openPage = (path: string) => {
    const reqId = ++pageSeqRef.current;
    aiMemoryReadPage(cwd, path)
      .then((r) => {
        if (pageSeqRef.current !== reqId) return;
        setPage(r.data);
      })
      .catch((e) => {
        if (pageSeqRef.current !== reqId) return;
        setError(String(e));
      });
  };

  const closePage = () => {
    pageSeqRef.current += 1;
    setPage(null);
  };

  const handleRenewOrPin = async (path: string, pin: boolean) => {
    const reqId = ++pageSeqRef.current;
    setPageBusy(true);
    setError(null);
    try {
      const res = pin ? await aiMemoryPinPage(cwd, path) : await aiMemoryRenewPage(cwd, path);
      if (pageSeqRef.current !== reqId) return;
      setPage(res.data);
      void load();
    } catch (e) {
      if (pageSeqRef.current !== reqId) return;
      setError(String(e));
    } finally {
      if (pageSeqRef.current === reqId) setPageBusy(false);
    }
  };

  const runSearch = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      searchSeqRef.current += 1;
      setSearchHits(null);
      setSearchError(null);
      return;
    }
    const reqId = ++searchSeqRef.current;
    setSearching(true);
    setSearchError(null);
    try {
      const res = await aiMemorySearch(cwd, trimmed, null, null);
      if (searchSeqRef.current !== reqId) return;
      setSearchHits(res.data);
    } catch (e) {
      if (searchSeqRef.current !== reqId) return;
      setSearchError(String(e));
    } finally {
      if (searchSeqRef.current === reqId) setSearching(false);
    }
  };

  const clearSearch = () => {
    searchSeqRef.current += 1;
    setSearchQuery("");
    setSearchHits(null);
    setSearchError(null);
    setSearching(false);
  };

  const confirmDisableSweep = async () => {
    if (sweepBusy) return;
    setSweepBusy(true);
    setSweepError(null);
    try {
      const updated: AiMemoryForgetSweep = await aiMemoryDisableForgetSweep(cwd);
      setLoaded((cur) => cur ? { ...cur, probe: { ...cur.probe, forget_sweep: updated } } : cur);
      setSweepDialogOpen(false);
    } catch (e) {
      setSweepError(String(e));
    } finally {
      setSweepBusy(false);
    }
  };

  const confirmCompact = async () => {
    if (compactBusy) return;
    setCompactBusy(true);
    setCompactError(null);
    try {
      const count = await compactMemory(COMPACT_RETENTION_DAYS);
      setCompactResult(count);
      setCompactDialogOpen(false);
    } catch (e) {
      setCompactError(String(e));
    } finally {
      setCompactBusy(false);
    }
  };

  const probe = loaded?.probe;
  const sweep = probe?.forget_sweep ?? null;
  const pageExpiry = page ? pageExpiryStatus(page) : null;
  const searchGroups = searchHits ? groupSearchHitsByProject(searchHits) : [];

  return (
    <section aria-label={t("aiMemory.title")} className="mb-4 rounded-xl bg-gray-100/70 p-3 text-[11.5px] text-gray-700 dark:bg-surface-raised/60 dark:text-gray-200">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold text-gray-900 dark:text-gray-100">
          {t("aiMemory.title")}
          {probe?.version && <span className="ml-1.5 font-normal text-gray-500">{probe.version}</span>}
        </h3>
        <Button variant="custom" className="cc-t h-6 rounded-md bg-gray-200/80 px-2 text-[11px] hover:brightness-110 dark:bg-white/8" onClick={() => void load()}>
          {t("aiMemory.refresh")}
        </Button>
      </div>
      <p className="mb-2 text-gray-500">{t("aiMemory.untrusted")}</p>

      {!cwd && <p className="text-gray-500">{t("aiMemory.noFolder")}</p>}
      {cwd && error && <p className="text-red-500" role="alert">{t("aiMemory.error", { error })}</p>}
      {cwd && !error && !loaded && <p className="text-gray-500" role="status">{t("aiMemory.loading")}</p>}

      {probe && probe.state !== "ok" && (
        <div role="status">
          <p className="font-medium">{t(`aiMemory.state.${probe.state}`)}</p>
          {probe.installation_instruction && (
            <pre className="mt-1 whitespace-pre-wrap rounded-md bg-gray-200/70 p-2 font-mono text-[11px] dark:bg-white/5">{probe.installation_instruction}</pre>
          )}
        </div>
      )}

      {probe?.state === "ok" && loaded && (
        <div className="grid gap-3">
          {sweep?.enabled && (
            <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-amber-800 dark:text-amber-300">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex-1">{t("aiMemory.forgetSweep.alert", { hours: forgetSweepHours(sweep) })}</p>
                <Button
                  variant="custom"
                  className="cc-t h-6 rounded-md bg-amber-500/20 px-2 text-[11px] font-medium hover:brightness-110"
                  onClick={() => { setSweepError(null); setSweepDialogOpen(true); }}
                >
                  {t("aiMemory.forgetSweep.disable")}
                </Button>
              </div>
            </div>
          )}

          {sweep && !sweep.enabled && (
            <p className="text-gray-500">{t("aiMemory.forgetSweep.disabled")}</p>
          )}

          <div>
            <h4 className="mb-1 font-semibold">{t("aiMemory.wiki")}</h4>
            {!sweep && <p className="mb-1 text-gray-500">{t("aiMemory.decayNote")}</p>}

            <form onSubmit={(e) => void runSearch(e)} className="mb-2 flex items-center gap-1.5">
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("aiMemory.search.placeholder")}
                aria-label={t("aiMemory.search.label")}
                className="h-7 flex-1 rounded-md border border-gray-300/80 bg-white/80 px-2 text-[11.5px] text-gray-900 placeholder:text-gray-400 focus:border-accent-500 focus:outline-none dark:border-white/10 dark:bg-white/5 dark:text-gray-100"
              />
              <Button
                type="submit"
                variant="custom"
                disabled={searching || !searchQuery.trim()}
                className="cc-t h-7 rounded-md bg-gray-200/80 px-2.5 text-[11px] hover:brightness-110 disabled:opacity-50 dark:bg-white/8"
              >
                {searching ? t("aiMemory.search.searching") : t("aiMemory.search.submit")}
              </Button>
              {searchHits !== null && (
                <Button
                  type="button"
                  variant="custom"
                  className="cc-t h-7 rounded-md px-2 text-[11px] text-gray-500 hover:brightness-110"
                  onClick={clearSearch}
                >
                  {t("aiMemory.search.clear")}
                </Button>
              )}
            </form>

            {searchError && <p className="mb-2 text-red-500" role="alert">{t("aiMemory.error", { error: searchError })}</p>}

            {searchHits !== null ? (
              <div className="mb-2">
                {searchHits.length === 0 ? (
                  <p className="text-gray-500">{t("aiMemory.search.empty")}</p>
                ) : (
                  <div className="grid gap-2">
                    {searchGroups.map((group) => (
                      <div key={group.projectLabel ?? "__current"}>
                        <p className="mb-0.5 text-[10.5px] font-medium text-gray-500">
                          {group.projectLabel ?? t("aiMemory.search.currentProject")}
                        </p>
                        <ul className="grid gap-1">
                          {group.hits.map((hit) => (
                            <li key={`${group.projectLabel ?? ""}:${hit.path}`}>
                              <Button
                                variant="custom"
                                className="cc-t w-full rounded-md px-1.5 py-1 text-left hover:bg-gray-200/70 dark:hover:bg-white/5"
                                onClick={() => openPage(hit.path)}
                              >
                                <span className="block font-medium">{hit.title || hit.path}</span>
                                <Snippet text={hit.snippet} />
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : loaded.pages.length === 0 ? (
              <p className="text-gray-500">{t("aiMemory.wikiEmpty")}</p>
            ) : (
              <ul className="grid gap-1">
                {loaded.pages.map((p) => (
                  <li key={p.path}>
                    <Button variant="custom" className="cc-t w-full rounded-md px-1.5 py-1 text-left hover:bg-gray-200/70 dark:hover:bg-white/5" onClick={() => openPage(p.path)}>
                      <span className="flex flex-wrap items-center font-medium">
                        <span>{p.title || p.path}</span>
                        <ExpiryBadge page={p} />
                      </span>
                      <Snippet text={p.snippet} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {page && (
              <article className="mt-2 rounded-md bg-gray-200/60 p-2 dark:bg-white/5">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center font-semibold">
                    <span>{page.title || page.path}</span>
                    <ExpiryBadge page={page} />
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="custom"
                      disabled={pageBusy}
                      className="cc-t h-5 rounded bg-gray-300/60 px-1.5 text-[10.5px] hover:brightness-110 disabled:opacity-50 dark:bg-white/10"
                      onClick={() => void handleRenewOrPin(page.path, false)}
                    >
                      {t("aiMemory.renewPage")}
                    </Button>
                    {pageExpiry?.kind !== "pinned" && (
                      <Button
                        variant="custom"
                        disabled={pageBusy}
                        className="cc-t h-5 rounded bg-accent-500/20 px-1.5 text-[10.5px] text-accent-700 hover:brightness-110 disabled:opacity-50 dark:text-accent-300"
                        onClick={() => void handleRenewOrPin(page.path, true)}
                      >
                        {t("aiMemory.pinPage")}
                      </Button>
                    )}
                    <Button variant="custom" className="cc-t h-5 rounded px-1.5 text-[10.5px] hover:brightness-110" onClick={closePage}>
                      {t("aiMemory.closePage")}
                    </Button>
                  </div>
                </div>
                {pageExpiry?.kind === "expired" && (
                  <p className="mb-1 text-amber-600 dark:text-amber-400">{t("aiMemory.expired")}</p>
                )}
                {pageExpiry?.kind === "expiring_soon" && (
                  <p className="mb-1 text-amber-600 dark:text-amber-400">
                    {pageExpiry.daysLeft === 0
                      ? t("aiMemory.expiresTodayDetail")
                      : t("aiMemory.expiresSoonDetail", { count: pageExpiry.daysLeft })}
                  </p>
                )}
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px]">{page.body}</pre>
              </article>
            )}
          </div>

          <div>
            <h4 className="mb-1 font-semibold">{t("aiMemory.handoffs")}</h4>
            {loaded.handoffs.length === 0
              ? <p className="text-gray-500">{t("aiMemory.handoffsEmpty")}</p>
              : groupPendingHandoffs(loaded.handoffs).map((group) => (
                <div key={group.toAgent ?? ""} className="mb-1">
                  <p className="text-gray-500">{group.toAgent ? t("aiMemory.handoffsTo", { agent: group.toAgent }) : t("aiMemory.handoffsAnyone")}</p>
                  <ul className="ml-2">
                    {group.handoffs.map((h) => (
                      <li key={h.id}>{t("aiMemory.handoffFrom", { agent: h.from_agent, when: formatCreatedAt(h.created_at_ms, i18n.language) })}</li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>

          {workspaceId && <AiMemoryMigration workspaceId={workspaceId} cwd={cwd} />}

          <div>
            <h4 className="mb-1 font-semibold">{t("aiMemory.sessions")}</h4>
            {probe.sessions_supported
              ? <Sessions cwd={cwd} />
              : <p className="text-gray-500">{t("aiMemory.sessionsSoon")}</p>}
          </div>
        </div>
      )}

      <div className="mt-3 border-t border-gray-200/80 pt-2 dark:border-white/10">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="font-semibold">{t("aiMemory.compact.title")}</h4>
            <p className="text-gray-500">{t("aiMemory.compact.hint")}</p>
          </div>
          <Button
            variant="custom"
            className="cc-t h-6 rounded-md bg-gray-200/80 px-2 text-[11px] hover:brightness-110 dark:bg-white/8"
            onClick={() => { setCompactError(null); setCompactDialogOpen(true); }}
          >
            {t("aiMemory.compact.action")}
          </Button>
        </div>
        {compactResult !== null && (
          <p className="mt-1 text-gray-500" role="status">
            {t("aiMemory.compact.done", { count: compactResult })}
          </p>
        )}
      </div>

      {sweepDialogOpen && sweep && (
        <AppDialog
          title={t("aiMemory.forgetSweep.dialogTitle")}
          size="md"
          closeOnEsc
          onClose={() => !sweepBusy && setSweepDialogOpen(false)}
          footer={(
            <>
              <Button variant="outline" disabled={sweepBusy} onClick={() => setSweepDialogOpen(false)}>
                {t("btn.cancel")}
              </Button>
              <Button variant="primary" disabled={sweepBusy} onClick={() => void confirmDisableSweep()}>
                {t("aiMemory.forgetSweep.confirm")}
              </Button>
            </>
          )}
        >
          <div className="grid gap-2 text-[12px] text-gray-700 dark:text-gray-200">
            <p>{t("aiMemory.forgetSweep.dialogBody")}</p>
            <code className="block rounded bg-gray-100 p-1.5 font-mono text-[11px] dark:bg-white/5">
              {sweep.config_path}
            </code>
            <p className="text-gray-500">{t("aiMemory.forgetSweep.dialogRestartHint")}</p>
            {sweepError && <p className="text-red-500" role="alert">{sweepError}</p>}
          </div>
        </AppDialog>
      )}

      {compactDialogOpen && (
        <AppDialog
          title={t("aiMemory.compact.dialogTitle")}
          size="md"
          closeOnEsc
          onClose={() => !compactBusy && setCompactDialogOpen(false)}
          footer={(
            <>
              <Button variant="outline" disabled={compactBusy} onClick={() => setCompactDialogOpen(false)}>
                {t("btn.cancel")}
              </Button>
              <Button variant="primary" disabled={compactBusy} onClick={() => void confirmCompact()}>
                {t("aiMemory.compact.confirm")}
              </Button>
            </>
          )}
        >
          <div className="grid gap-2 text-[12px] text-gray-700 dark:text-gray-200">
            <p>{t("aiMemory.compact.explain", { days: COMPACT_RETENTION_DAYS })}</p>
            {compactError && <p className="text-red-500" role="alert">{compactError}</p>}
          </div>
        </AppDialog>
      )}
    </section>
  );
}
