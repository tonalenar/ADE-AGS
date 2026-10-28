import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AppDialog } from "@/shared/ui/AppDialog";

import { compareDiff } from "./ipc";
import { diffLines } from "./model";
import { closeDiff, useCompareStore } from "./store";
import type { DiffView } from "./types";

const LINE: Record<ReturnType<typeof diffLines>[number]["kind"], string> = {
  add: "text-green-700 dark:text-green-300 bg-green-500/10",
  del: "text-red-700 dark:text-red-300 bg-red-500/10",
  hunk: "text-accent-600 dark:text-accent-300",
  meta: "text-gray-500 dark:text-gray-400 font-semibold",
  ctx: "text-gray-700 dark:text-gray-300",
};

/** O que um modelo mudou em relação à base da comparação: o `--stat`, os arquivos novos e o patch. */
export function DiffDialog({ comparisonId, pick }: { comparisonId: string; pick: string }) {
  const { t } = useTranslation();
  const label = useCompareStore((s) => s.comparisons.find((c) => c.id === comparisonId)?.entries.find((e) => e.pick === pick)?.label ?? pick);
  const [view, setView] = useState<DiffView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    compareDiff(comparisonId, pick).then((v) => alive && setView(v)).catch((e) => alive && setError(String(e)));
    return () => { alive = false; };
  }, [comparisonId, pick]);

  const lines = useMemo(() => (view ? diffLines(view.patch) : []), [view]);

  return (
    <AppDialog title={t("compare.diff.title", { label })} size="xl" closeOnEsc closeOnBackdrop onClose={closeDiff}>
      <div className="flex flex-col gap-3 text-[12px]">
        {error && <p role="alert" className="text-red-500 dark:text-red-400">{error}</p>}
        {!view && !error && <p className="text-gray-500">{t("compare.diff.loading")}</p>}
        {view && (
          <>
            <p className="text-gray-500 dark:text-gray-400">
              {t("compare.diff.base", { base: view.base.slice(0, 10), branch: view.branch ?? "" })}
            </p>
            {view.stat && <pre className="cc-scroll overflow-auto max-h-40 rounded-md bg-gray-100 dark:bg-white/5 p-2 font-mono text-[11px]">{view.stat}</pre>}
            {view.untracked.length > 0 && (
              <div>
                <p className="font-medium text-gray-600 dark:text-gray-300">{t("compare.diff.untracked", { count: view.untracked.length })}</p>
                <ul className="font-mono text-[11px] text-green-700 dark:text-green-300">
                  {view.untracked.slice(0, 50).map((f) => <li key={f}>+ {f}</li>)}
                </ul>
              </div>
            )}
            {lines.length > 0 && view.patch ? (
              <pre className="cc-scroll overflow-auto max-h-[55vh] rounded-md border border-gray-200 dark:border-white/10 font-mono text-[11px] leading-[1.45]">
                {lines.map((line, i) => <div key={i} className={`px-2 whitespace-pre ${LINE[line.kind]}`}>{line.text || " "}</div>)}
              </pre>
            ) : (
              !view.untracked.length && <p className="text-gray-500">{t("compare.diff.empty")}</p>
            )}
            {view.truncated && <p className="text-amber-700 dark:text-amber-300">{t("compare.diff.truncated")}</p>}
          </>
        )}
      </div>
    </AppDialog>
  );
}
