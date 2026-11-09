import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, EmptyState } from "neogestify-ui-components";

import { PullRequestIcon } from "@/app/icons";
import { ForgeItemsView, type ItemFilter } from "@/features/forge/ForgeItemsView";
import { ItemDetailView } from "@/features/forge/ItemDetailView";
import { useRepoTarget } from "@/features/forge/useRepoTarget";
import type { ForgeItem } from "@/features/forge/types";

/** PRs do repositório da conversa e os PRs ligados à branch que ela está usando. */
export function PullRequestPane({ cwd, branch, quoteKey = null }: { cwd: string; branch: string | null; quoteKey?: string | null }) {
  const { t } = useTranslation();
  const { target } = useRepoTarget(cwd);
  const [view, setView] = useState<"all" | "linked">("all");
  const [filter, setFilter] = useState<ItemFilter>("open");
  const [opened, setOpened] = useState<ForgeItem | null>(null);
  const [version, setVersion] = useState(0);

  if (target === undefined) {
    return <p role="status" className="p-4 text-chat-note text-gray-400 dark:text-white/40">{t("chat.panel.loading")}</p>;
  }
  if (target === null) {
    return (
      <EmptyState className="m-auto" icon={<PullRequestIcon className="w-8 h-8" />}
        title={t("forge.page.noRemote")} />
    );
  }

  if (opened) {
    return (
      <ItemDetailView key={`${cwd}:${opened.number}:${version}`} cwd={cwd} workspaces={[{ cwd, branch }]} item={opened} pr quoteKey={quoteKey}
        onBack={() => setOpened(null)} onChanged={() => setVersion((value) => value + 1)} />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label={t("chat.panel.pr.views")}
        className="flex h-11 shrink-0 items-center gap-1 border-b border-gray-200 px-3 dark:border-white/8">
        <Button variant="custom" role="tab" aria-selected={view === "all"} onClick={() => setView("all")}
          className={`cc-t h-7 rounded-lg px-2.5 text-[12px] ${view === "all" ? "bg-gray-200 font-semibold text-gray-900 dark:bg-white/10 dark:text-white" : "text-gray-500 hover:bg-gray-100 dark:text-white/45 dark:hover:bg-white/6"}`}>
          {t("forge.panel.pulls")}
        </Button>
        <Button variant="custom" role="tab" aria-selected={view === "linked"} disabled={!branch}
          title={branch ? t("chat.panel.pr.linkedTitle", { branch }) : t("chat.panel.pr.branchNeeded")}
          onClick={() => setView("linked")}
          className={`cc-t h-7 rounded-lg px-2.5 text-[12px] disabled:cursor-not-allowed disabled:opacity-40 ${view === "linked" ? "bg-gray-200 font-semibold text-gray-900 dark:bg-white/10 dark:text-white" : "text-gray-500 hover:bg-gray-100 dark:text-white/45 dark:hover:bg-white/6"}`}>
          {t("chat.panel.pr.linked")}
        </Button>
      </div>
      {view === "linked" && branch && (
        <div className="flex h-8 shrink-0 items-center border-b border-gray-100 px-4 text-chat-caption text-gray-500 dark:border-white/5 dark:text-white/40">
          <span className="truncate font-mono" title={branch}>{branch}</span>
        </div>
      )}
      <ForgeItemsView key={`${cwd}:${view}:${version}:${target.account?.id ?? "none"}`} cwd={cwd} target={target} what="pulls"
        branch={branch} filter={filter} linkedBranch={view === "linked" ? branch : undefined}
        onFilter={setFilter} onOpen={setOpened} />
    </div>
  );
}
