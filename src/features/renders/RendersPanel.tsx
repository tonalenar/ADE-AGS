import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { ChevronLeftIcon, ExternalIcon, ReloadIcon, TrashIcon } from "@/features/chat/chatIcons";

import { renderDelete, renderList, renderOpenExternal, type RenderPage } from "./ipc";
import { RenderFrame } from "./RenderFrame";
import { renderProjectName } from "./model";
import { useRendersStore } from "./store";

/** O evento que o backend manda quando uma página nova é publicada (ver `ipc/commands/renders.rs`). */
export const RENDERS_CHANGED_EVENT = "cc-render-changed";

const iconButton = "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-white/50 dark:hover:bg-white/[0.07] dark:hover:text-white disabled:opacity-40";

/**
 * A superfície "Páginas HTML" do painel direito: as páginas que os agentes publicaram, com abrir, recarregar, abrir no
 * navegador do sistema e apagar (só por clique, em dois passos). Uma página aberta mostra o quadro isolado.
 */
export function RendersPanel() {
  const { t } = useTranslation();
  const selectedId = useRendersStore((s) => s.selectedId);
  const select = useRendersStore((s) => s.select);
  const [pages, setPages] = useState<RenderPage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    return renderList()
      .then((list) => {
        setPages(list);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    void load();
    let alive = true;
    let unlisten: UnlistenFn | null = null;
    void listen(RENDERS_CHANGED_EVENT, () => void load()).then((stop) => {
      if (alive) unlisten = stop;
      else stop();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [load]);

  const open = (id: string | null) => {
    setConfirmId(null);
    setActionError(null);
    select(id);
  };

  if (selectedId !== null) {
    const page = pages?.find((p) => p.id === selectedId) ?? null;
    const confirming = confirmId === selectedId;
    const openOutside = () => {
      setActionError(null);
      renderOpenExternal(selectedId).catch((e: unknown) => setActionError(String(e)));
    };
    const remove = () => {
      setActionError(null);
      renderDelete(selectedId)
        .then(() => {
          open(null);
          return load();
        })
        .catch((e: unknown) => setActionError(String(e)));
    };
    return (
      <section aria-label={page?.title ?? t("renders.untitled")} className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-10 shrink-0 items-center gap-1 border-b border-gray-200 px-2 dark:border-white/10">
          <button type="button" aria-label={t("renders.back")} title={t("renders.back")} onClick={() => open(null)} className={iconButton}>
            <ChevronLeftIcon className="w-4 h-4" />
          </button>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-800 dark:text-white/85">{page?.title ?? t("renders.untitled")}</span>
          <button type="button" aria-label={t("renders.reload")} title={t("renders.reload")} onClick={() => setReloadKey((k) => k + 1)} className={iconButton}>
            <ReloadIcon className="w-4 h-4" />
          </button>
          <button type="button" aria-label={t("renders.openExternal")} title={t("renders.openExternal")} onClick={openOutside} className={iconButton}>
            <ExternalIcon className="w-4 h-4" />
          </button>
          {confirming ? (
            <>
              <button type="button" onClick={remove} className="h-7 rounded-md bg-red-600 px-2 text-[12px] font-medium text-white hover:bg-red-500">{t("renders.confirmDelete")}</button>
              <button type="button" onClick={() => setConfirmId(null)} className="h-7 rounded-md px-2 text-[12px] text-gray-600 hover:bg-gray-100 dark:text-white/65 dark:hover:bg-white/[0.07]">{t("renders.cancel")}</button>
            </>
          ) : (
            <button type="button" aria-label={t("renders.delete")} title={t("renders.delete")} onClick={() => setConfirmId(selectedId)} className={iconButton}>
              <TrashIcon className="w-4 h-4" />
            </button>
          )}
        </header>
        {confirming && <p className="shrink-0 border-b border-gray-200 px-3 py-2 text-[12px] text-gray-600 dark:border-white/10 dark:text-white/65">{t("renders.deleteConfirm")}</p>}
        {actionError && <p role="alert" className="shrink-0 px-3 py-2 text-[12px] text-red-600 dark:text-red-400">{actionError}</p>}
        <div className="min-h-0 flex-1 overflow-hidden">
          <RenderFrame key={selectedId} id={selectedId} reloadKey={reloadKey} title={page?.title ?? t("renders.untitled")} />
        </div>
      </section>
    );
  }

  return (
    <section aria-label={t("renders.title")} className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-gray-200 px-3 dark:border-white/10">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-800 dark:text-white/85">{t("renders.title")}</span>
        <button type="button" aria-label={t("renders.refresh")} title={t("renders.refresh")} onClick={() => void load()} className={iconButton}>
          <ReloadIcon className="w-4 h-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {failed && (
          <p role="alert" className="px-3 py-3 text-[12.5px] text-red-600 dark:text-red-400">{t("renders.loadFailed")}</p>
        )}
        {pages !== null && pages.length === 0 && !failed && (
          <p className="px-3 py-6 text-center text-[12.5px] text-gray-500 dark:text-white/50">{t("renders.empty")}</p>
        )}
        {pages !== null && pages.length > 0 && (
          <ul className="flex flex-col p-1.5">
            {pages.map((page) => (
              <li key={page.id}>
                <button type="button" onClick={() => open(page.id)}
                  className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left hover:bg-gray-100 dark:hover:bg-white/[0.07]">
                  <span className="w-full truncate text-[13px] font-medium text-gray-800 dark:text-white/85">{page.title || t("renders.untitled")}</span>
                  <span className="w-full truncate text-[11.5px] text-gray-500 dark:text-white/50">
                    {[renderProjectName(page.cwd), new Date(page.createdAt).toLocaleString()].filter(Boolean).join(" · ")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
