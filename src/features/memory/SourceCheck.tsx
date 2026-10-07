import { useState } from "react";
import { useTranslation } from "react-i18next";

import * as memoryIpc from "./ipc";
import type { MemorySourceVerification } from "./types";

const FIELDS = ["runExists", "taskExists", "fileExists", "commitExists"] as const;

/**
 * "Conferir fonte": consulta somente leitura (não muda `last_verified`). Mostra por item se a
 * origem ainda existe; `null` = a entrada não declara esse tipo de origem.
 */
export function SourceCheck({ entryId, disabled }: { entryId: string; disabled?: boolean }) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ status: "idle" } | { status: "loading" } | { status: "error"; detail: string } | { status: "done"; result: MemorySourceVerification }>({ status: "idle" });

  const run = async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "done", result: await memoryIpc.verifyMemorySource(entryId) });
    } catch (e) {
      setState({ status: "error", detail: String(e) });
    }
  };

  return (
    <span className="inline-flex flex-col gap-1">
      <button type="button" disabled={disabled || state.status === "loading"} onClick={() => void run()}
        className="rounded border border-gray-300 px-2 py-0.5 text-[11px] disabled:opacity-50 dark:border-white/20">
        {state.status === "loading" ? t("memorySearch.checking") : t("memorySearch.checkSource")}
      </button>
      {state.status === "error" && <span role="alert" className="text-[10.5px] text-red-600 dark:text-red-400">{t("memorySearch.checkFailed", { detail: state.detail })}</span>}
      {state.status === "done" && (
        <span role="status" className="text-[10.5px] text-gray-600 dark:text-gray-300">
          {FIELDS.map((f) => (
            <span key={f} data-check={f} className={`mr-2 ${state.result[f] === false ? "text-red-600 dark:text-red-400" : ""}`}>
              {t(`memorySearch.source.${f}`)}: {state.result[f] === null ? t("memorySearch.source.na") : state.result[f] ? t("memorySearch.source.yes") : t("memorySearch.source.no")}
            </span>
          ))}
          <span className="text-gray-400">{t("memorySearch.readOnlyNote")}</span>
        </span>
      )}
    </span>
  );
}
