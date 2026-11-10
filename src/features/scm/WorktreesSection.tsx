import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, ChevronDownIcon, ChevronRightIcon } from "neogestify-ui-components";

import { scmWorktrees } from "./ipc";
import type { ScmWorktree } from "./types";

/** Nome da pasta, para a lista. O caminho completo fica no título. */
function folderName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Lista os worktrees já abertos. Não cria, não apaga e não troca de pasta:
 * isso continua nas conversas e nas missões.
 */
export function ScmWorktreesSection({ root }: { root: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ScmWorktree[] | null>(null);

  const load = useCallback(() => {
    scmWorktrees(root).then(setRows).catch(() => setRows([]));
  }, [root]);

  useEffect(() => { if (open) load(); }, [open, load]);

  return (
    <div className="border-t border-gray-200 dark:border-white/7">
      <Button variant="custom" onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 h-7 pl-1.5 pr-2 text-left">
        <span className="w-3.5 shrink-0 text-gray-400 dark:text-white/30">
          {open ? <ChevronDownIcon className="w-2.5 h-2.5" /> : <ChevronRightIcon className="w-2.5 h-2.5" />}
        </span>
        <span className="flex-1 text-[10px] font-extrabold uppercase tracking-[0.09em] text-gray-500 dark:text-white/40">
          {t("scm.worktrees")}
        </span>
      </Button>
      {open && (
        <div className="max-h-48 cc-scroll pb-1">
          {rows === null ? (
            <p className="px-3 py-1.5 text-[11px] text-gray-400 dark:text-white/30">{t("scm.loading")}</p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-1.5 text-[11px] text-gray-400 dark:text-white/30">{t("scm.worktree.empty")}</p>
          ) : rows.map((row) => (
            <div key={row.path} className="flex items-center gap-2 min-w-0 px-3 py-1" title={row.path}>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-gray-700 dark:text-gray-200">
                {folderName(row.path)}
              </span>
              <span className="max-w-[46%] truncate text-[10.5px] text-gray-400 dark:text-white/35">
                {row.branch ?? t("scm.worktree.detached")}
                {row.current ? ` · ${t("scm.worktree.current")}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
