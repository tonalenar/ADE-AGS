import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { purgeConfirmed } from "./dreamReview";
import * as memoryIpc from "./ipc";

/**
 * Apagado definitivo (purge) de uma entrada, só pelo usuário. Confirmação forte: é preciso digitar a
 * chave da entrada; Enter NÃO confirma (só o clique no botão, habilitado após digitar certo).
 * O backend apaga as revisões no SQLite, reescreve o histórico git local, o revisions.json
 * e os backups automáticos do ADE, e registra auditoria sem o corpo.
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
        className="h-7 rounded-md px-2.5 text-[12px] font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400">{t("memoryPurge.button")}</button>
      {open && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[4px]" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
          <div role="alertdialog" aria-modal="true" aria-labelledby="memory-purge-title" aria-describedby="memory-purge-body"
            className="w-full max-w-md rounded-2xl bg-gray-50 p-5 shadow-[0_0_0_0.5px_rgba(255,255,255,0.08),0_10px_30px_rgba(0,0,0,0.45),0_2px_6px_rgba(0,0,0,0.3)] dark:bg-surface">
            <h3 id="memory-purge-title" className="text-[15px] font-semibold tracking-[-0.01em] text-red-700 dark:text-red-300">{t("memoryPurge.title")}</h3>
            <p id="memory-purge-body" className="mt-1.5 text-[12.5px] leading-[17px] text-gray-700 dark:text-gray-300">{t("memoryPurge.body", { key: entryKey })}</p>
            <label className="mt-3 block text-[11.5px] text-gray-600 dark:text-white/55">{t("memoryPurge.typeKey", { key: entryKey })}
              <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
                className="mt-1.5 h-7 w-full rounded-md bg-gray-200/70 px-2.5 font-mono text-[12px] tabular-nums text-gray-900 focus:outline-none focus-visible:ring-[3px] focus-visible:ring-accent-500/25 dark:bg-surface-raised dark:text-gray-100" />
            </label>
            {error && <p role="alert" className="mt-2 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={close} className="h-7 rounded-md bg-gray-200/80 px-3 text-[12px] font-medium text-gray-800 hover:bg-gray-300/70 dark:bg-surface-overlay dark:text-gray-100 dark:hover:bg-white/[0.14]">{t("memoryInbox.cancel")}</button>
              <button type="button" disabled={busy || !purgeConfirmed(typed, entryKey)} onClick={() => void run()}
                className="h-7 rounded-md bg-red-600 px-3 text-[12px] font-medium text-white hover:bg-red-500 disabled:opacity-40">{t("memoryPurge.confirm")}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
