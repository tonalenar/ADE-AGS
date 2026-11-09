import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { getArchivedSessionTurn, type ArchivedMessageTurn } from "./ipc.conversations";
import { closeArchivedMessagePreview, useChatStore } from "@/features/chat/store";
import { XIcon } from "@/features/chat/chatIcons";

/** Prévia somente leitura. Abrir um resultado nunca relança a sessão arquivada. */
export function ArchivedMessagePreviewHost() {
  const request = useChatStore((state) => state.archivedMessagePreview);
  if (!request) return null;
  return <ArchivedMessagePreview workspaceId={request.workspaceId} hit={request.hit} />;
}

function ArchivedMessagePreview({ workspaceId, hit }: NonNullable<ReturnType<typeof useChatStore.getState>["archivedMessagePreview"]>) {
  const { t, i18n } = useTranslation();
  const [turn, setTurn] = useState<ArchivedMessageTurn | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const date = useMemo(() => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(hit.closedAt * 1000)), [hit.closedAt, i18n.language]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    setTurn(null);
    void getArchivedSessionTurn(workspaceId, hit.historyId, hit.turnIndex, hit.sourceId)
      .then((result) => { if (active) setTurn(result); })
      .catch(() => { if (active) setFailed(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspaceId, hit.historyId, hit.turnIndex, hit.sourceId]);

  return (
    <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeArchivedMessagePreview(); }}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/35 p-6 backdrop-blur-[2px]">
      <section role="dialog" aria-modal="true" aria-label={t("chat.archivedPreview.title")}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeArchivedMessagePreview(); } }}
        className="flex max-h-[min(82vh,900px)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-white/10 dark:bg-surface-raised">
        <header className="flex shrink-0 items-start gap-4 border-b border-gray-200 px-5 py-4 dark:border-white/10">
          <div className="min-w-0 flex-1">
            <div className="text-chat-caption font-medium text-gray-500 dark:text-white/45">{t("chat.archivedPreview.eyebrow")}</div>
            <h2 className="mt-1 truncate text-base font-semibold text-gray-900 dark:text-white">{hit.title || hit.agentLabel}</h2>
            <p className="mt-1 truncate text-chat-caption text-gray-500 dark:text-white/45">{hit.agentLabel} · {date} · {hit.cwd}</p>
          </div>
          <button type="button" onClick={closeArchivedMessagePreview} aria-label={t("chat.find.close")}
            className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:text-white/55 dark:hover:bg-white/[0.08]">
            <XIcon className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-chat-caption text-gray-500 dark:text-white/45">
            <span className="rounded-full bg-gray-100 px-2.5 py-1 dark:bg-white/[0.07]">{t(hit.kind === "user" ? "chat.sidebar.you" : "chat.sidebar.agent")}</span>
            {(turn?.partial ?? hit.partial) && <span>{t("chat.archivedPreview.partial")}</span>}
            {(turn?.turnTruncated ?? hit.turnTruncated) && <span>{t("chat.archivedPreview.truncated")}</span>}
          </div>
          {loading ? <p role="status" className="py-8 text-center text-sm text-gray-500 dark:text-white/45">{t("chat.archivedPreview.loading")}</p>
            : failed || !turn ? <p role="alert" className="py-8 text-center text-sm text-gray-500 dark:text-white/45">{t("chat.archivedPreview.unavailable")}</p>
              : <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-gray-800 dark:text-white/80">{turn.text}</pre>}
        </div>
      </section>
    </div>
  );
}
