import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { formatCreatedAt, groupPendingHandoffs, parseSnippet } from "./aiMemory";
import type { AiMemoryHandoff, AiMemoryPage, AiMemoryProbe, AiMemoryRecentPage } from "./aiMemory";
import { aiMemoryHandoffs, aiMemoryProbe, aiMemoryReadPage, aiMemoryRecent } from "./aiMemoryIpc";

interface Loaded {
  probe: AiMemoryProbe;
  pages: AiMemoryRecentPage[];
  handoffs: AiMemoryHandoff[];
}

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

/**
 * Painel "Memória" do ai-memory (somente leitura): wiki do projeto da pasta, handoffs pendentes e
 * últimas sessões. Tudo vem do binário pelo envelope UNTRUSTED e é mostrado como texto, nunca HTML.
 */
export function AiMemoryPanel({ cwd }: { cwd: string }) {
  const { t, i18n } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<AiMemoryPage | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const probe = (await aiMemoryProbe(cwd)).data;
      if (probe.state !== "ok") { setLoaded({ probe, pages: [], handoffs: [] }); return; }
      const [pages, handoffs] = await Promise.all([aiMemoryRecent(cwd), aiMemoryHandoffs(cwd)]);
      setLoaded({ probe, pages: pages.data, handoffs: handoffs.data });
    } catch (e) {
      setError(String(e));
    }
  }, [cwd]);

  useEffect(() => { setLoaded(null); setPage(null); void load(); }, [load]);

  const openPage = (path: string) => {
    aiMemoryReadPage(cwd, path).then((r) => setPage(r.data)).catch((e) => setError(String(e)));
  };

  const probe = loaded?.probe;
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
          <div>
            <h4 className="mb-1 font-semibold">{t("aiMemory.wiki")}</h4>
            {loaded.pages.length === 0
              ? <p className="text-gray-500">{t("aiMemory.wikiEmpty")}</p>
              : (
                <ul className="grid gap-1">
                  {loaded.pages.map((p) => (
                    <li key={p.path}>
                      <Button variant="custom" className="cc-t w-full rounded-md px-1.5 py-1 text-left hover:bg-gray-200/70 dark:hover:bg-white/5" onClick={() => openPage(p.path)}>
                        <span className="block font-medium">{p.title || p.path}</span>
                        <Snippet text={p.snippet} />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            {page && (
              <article className="mt-2 rounded-md bg-gray-200/60 p-2 dark:bg-white/5">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="font-semibold">{page.title || page.path}</span>
                  <Button variant="custom" className="cc-t h-5 rounded px-1.5 text-[10.5px] hover:brightness-110" onClick={() => setPage(null)}>
                    {t("aiMemory.closePage")}
                  </Button>
                </div>
                {page.expired && <p className="mb-1 text-amber-600 dark:text-amber-400">{t("aiMemory.expired")}</p>}
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

          <div>
            <h4 className="mb-1 font-semibold">{t("aiMemory.sessions")}</h4>
            <p className="text-gray-500">
              {probe.sessions_supported ? t("aiMemory.sessionsCount", { count: probe.status?.counts.sessions ?? 0 }) : t("aiMemory.sessionsSoon")}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
