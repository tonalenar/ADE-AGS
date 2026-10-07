import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { purgeConfirmed } from "./dreamReview";
import * as memoryIpc from "./ipc";

/**
 * Apagado definitivo (purge) de uma entrada, só pelo usuário. Confirmação forte: é preciso digitar a
 * chave da entrada; Enter NÃO confirma (só o clique no botão, habilitado após digitar certo).
 * O Backend registra um evento de auditoria sem o corpo.
 */
export function PurgeButton({ entryId, entryKey, disabled, onDone }: { entryId: string; entryKey: string; disabled?: boolean; onDone: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const opener = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); setTyped(""); setError(""); setTimeout(() => opener.current?.focus(), 0); };
  const run = async () => {
    if (!purgeConfirmed(typed, entryKey) || busy) return;
    setBusy(true);
    try {
      await memoryIpc.purgeMemoryUser(entryId, null);
      close();
      onDone();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button ref={opener} type="button" disabled={disabled} onClick={() => setOpen(true)} aria-label={t("memoryPurge.buttonLabel", { key: entryKey })} aria-haspopup="dialog"
        className="rounded border border-red-500/50 px-2 py-0.5 text-[11px] text-red-600 disabled:opacity-50 dark:text-red-400">{t("memoryPurge.button")}</button>
      {open && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
          <div role="alertdialog" aria-modal="true" aria-labelledby="memory-purge-title" aria-describedby="memory-purge-body" className="w-full max-w-md rounded-xl border border-red-500/40 bg-white p-4 shadow-xl dark:bg-surface-deep">
            <h3 id="memory-purge-title" className="text-[13px] font-semibold text-red-700 dark:text-red-300">{t("memoryPurge.title")}</h3>
            <p id="memory-purge-body" className="mt-1 text-[12px]">{t("memoryPurge.body", { key: entryKey })}</p>
            <label className="mt-2 block text-[11.5px]">{t("memoryPurge.typeKey", { key: entryKey })}
              <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
                className="mt-1 w-full rounded border border-gray-300 bg-transparent px-2 py-1 font-mono text-[12px] dark:border-white/20" />
            </label>
            {error && <p role="alert" className="mt-1 text-[11px] text-red-600">{error}</p>}
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={close} className="rounded border border-gray-300 px-3 py-1 text-[11.5px] dark:border-white/20">{t("memoryInbox.cancel")}</button>
              <button type="button" disabled={busy || !purgeConfirmed(typed, entryKey)} onClick={() => void run()}
                className="rounded bg-red-600 px-3 py-1 text-[11.5px] font-medium text-white disabled:opacity-40">{t("memoryPurge.confirm")}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
