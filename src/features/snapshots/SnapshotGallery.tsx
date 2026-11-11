import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { DESKTOP_OS } from "@/app/platform";
import { Lightbox } from "@/features/chat/attachments/Lightbox";
import { useImagePreview } from "@/features/chat/attachments/useImagePreview";
import { attachToComposer } from "@/features/chat/store";
import { ReloadIcon } from "@/features/chat/chatIcons";

import { snapshotGalleryCopy, snapshotGalleryDelete, snapshotGalleryList, type SnapshotItem } from "./ipc";
import { snapshotCanCopy, snapshotLabel, snapshotTime } from "./model";

const button = "h-7 shrink-0 rounded-md px-2 text-[11.5px] text-gray-600 hover:bg-gray-100 dark:text-white/65 dark:hover:bg-white/[0.07] disabled:opacity-40";

/**
 * A galeria de SnapShots: as capturas da pasta de capturas, com ver (no visualizador), copiar (macOS), anexar ao chat e
 * apagar. Apagar é por clique, em dois passos, e só apaga a captura e a legenda dela. A captura em si é de outra peça.
 */
export function SnapshotGallery({ composerTarget }: { composerTarget?: string | null }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<SnapshotItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(() => {
    return snapshotGalleryList()
      .then((list) => {
        setItems(list);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = (item: SnapshotItem) => {
    setStatus(null);
    snapshotGalleryCopy(item.id)
      .then(() => setStatus(t("snapshots.copied")))
      .catch((e: unknown) => setStatus(String(e)));
  };

  const remove = (item: SnapshotItem) => {
    setStatus(null);
    snapshotGalleryDelete(item.id)
      .then(() => {
        setConfirmId(null);
        return load();
      })
      .catch((e: unknown) => setStatus(String(e)));
  };

  return (
    <section aria-label={t("snapshots.title")} className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-gray-200 px-3 dark:border-white/10">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-800 dark:text-white/85">{t("snapshots.title")}</span>
        <button type="button" aria-label={t("snapshots.refresh")} title={t("snapshots.refresh")} onClick={() => void load()}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 dark:text-white/50 dark:hover:bg-white/[0.07]">
          <ReloadIcon className="w-4 h-4" />
        </button>
      </header>
      {status && <p role="status" className="shrink-0 border-b border-gray-200 px-3 py-1.5 text-[12px] text-gray-600 dark:border-white/10 dark:text-white/65">{status}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {failed && <p role="alert" className="px-3 py-3 text-[12.5px] text-red-600 dark:text-red-400">{t("snapshots.loadFailed")}</p>}
        {items !== null && items.length === 0 && !failed && (
          <p className="px-3 py-6 text-center text-[12.5px] text-gray-500 dark:text-white/50">{t("snapshots.empty")}</p>
        )}
        {items !== null && items.length > 0 && (
          <ul className="grid grid-cols-2 gap-2 p-2">
            {items.map((item, index) => (
              <li key={item.id}>
                <SnapshotCard item={item} confirming={confirmId === item.id} canCopy={snapshotCanCopy(DESKTOP_OS)}
                  onView={() => setViewing(index)}
                  onCopy={() => copy(item)}
                  onAttach={() => attachToComposer([item.path], composerTarget)}
                  onAskDelete={() => setConfirmId(item.id)}
                  onCancelDelete={() => setConfirmId(null)}
                  onDelete={() => remove(item)} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {viewing !== null && items !== null && (
        <Lightbox images={items.map((item) => ({ path: item.path, name: snapshotLabel(item) || item.id, preview: null }))}
          index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} />
      )}
    </section>
  );
}

function SnapshotCard({ item, confirming, canCopy, onView, onCopy, onAttach, onAskDelete, onCancelDelete, onDelete }: {
  item: SnapshotItem;
  confirming: boolean;
  canCopy: boolean;
  onView: () => void;
  onCopy: () => void;
  onAttach: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const { src, missing } = useImagePreview(item.path, null);
  const label = snapshotLabel(item);
  return (
    <article className="flex flex-col overflow-hidden rounded-lg border border-gray-200 dark:border-white/10">
      <button type="button" onClick={onView} aria-label={t("snapshots.view")} className="block aspect-video w-full bg-gray-100 dark:bg-white/[0.05]">
        {src ? (
          <img src={src} alt={label || t("snapshots.untitled")} className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-[11px] text-gray-400 dark:text-white/40">
            {missing ? t("snapshots.missing") : t("snapshots.loading")}
          </span>
        )}
      </button>
      <div className="flex flex-col gap-1 p-2">
        <span className="truncate text-[12px] font-medium text-gray-800 dark:text-white/85">{label || t("snapshots.untitled")}</span>
        <span className="truncate text-[11px] text-gray-500 dark:text-white/50">{new Date(snapshotTime(item)).toLocaleString()}</span>
        <div className="flex flex-wrap gap-1">
          {canCopy && <button type="button" onClick={onCopy} className={button}>{t("snapshots.copy")}</button>}
          <button type="button" onClick={onAttach} className={button}>{t("snapshots.attach")}</button>
          {confirming ? (
            <>
              <button type="button" onClick={onDelete} className="h-7 rounded-md bg-red-600 px-2 text-[11.5px] font-medium text-white hover:bg-red-500">{t("snapshots.confirmDelete")}</button>
              <button type="button" onClick={onCancelDelete} className={button}>{t("snapshots.cancel")}</button>
            </>
          ) : (
            <button type="button" onClick={onAskDelete} className={button}>{t("snapshots.delete")}</button>
          )}
        </div>
      </div>
    </article>
  );
}
