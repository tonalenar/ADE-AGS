import { useTranslation } from "react-i18next";
import { Button, DocumentIcon, SearchIcon, Tooltip } from "neogestify-ui-components";

import { useUiStore, type ExplorerView } from "@/app/uiStore";
import { BranchIcon, PanelIcon } from "@/app/icons";

/** Marca os botões: um clique neles não conta como "clicar fora" da gaveta (ela mesma decide). */
export const PANEL_BUTTONS_ATTR = "data-panel-buttons";

const DRAWERS: { view: ExplorerView; Icon: (p: { className: string }) => React.JSX.Element; label: string }[] = [
  { view: "files", Icon: DocumentIcon, label: "explorer.tab.files" },
  { view: "search", Icon: SearchIcon, label: "explorer.tab.search" },
  { view: "scm", Icon: BranchIcon, label: "explorer.tab.changes" },
];

const BUTTON = `cc-t relative flex items-center justify-center w-7 h-7 self-center rounded-md shrink-0 p-0
  text-gray-400 dark:text-white/35 hover:text-gray-700 dark:hover:text-white
  hover:bg-gray-200/60 dark:hover:bg-white/[0.08]`;
const ON = "bg-accent-500/12 dark:bg-accent-400/13 text-accent-600 dark:text-accent-400";

/**
 * O canto de cima à direita, como no Claude Code: arquivos, busca e git abrem numa gaveta por cima
 * do conteúdo (antes eram uma coluna fixa que comia a largura dos terminais o tempo todo), e o último
 * botão mostra ou esconde o painel da sessão.
 */
export function PanelButtons({ changes }: { changes: number }) {
  const { t } = useTranslation();
  const drawer = useUiStore((s) => s.drawer);
  const openDrawer = useUiStore((s) => s.openDrawer);
  const hidden = useUiStore((s) => s.sidePanelHidden);
  const toggleSidePanel = useUiStore((s) => s.toggleSidePanel);

  return (
    <div {...{ [PANEL_BUTTONS_ATTR]: "" }} data-tauri-drag-region="false"
      className="flex items-center gap-0.5 shrink-0 pl-1.5 ml-1 border-l border-gray-200 dark:border-white/[0.08]">
      {DRAWERS.map(({ view, Icon, label }) => (
        <Tooltip key={view} content={t(label)} placement="bottom">
          <Button variant="icon" onClick={() => openDrawer(view)} aria-label={t(label)} aria-pressed={drawer === view}
            className={`${BUTTON} ${drawer === view ? ON : ""}`}>
            <Icon className="w-4 h-4" />
            {view === "scm" && changes > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-1 rounded-full
                bg-amber-500 text-white text-[8.5px] font-bold leading-[14px] tabular-nums text-center">
                {changes > 99 ? "99+" : changes}
              </span>
            )}
          </Button>
        </Tooltip>
      ))}
      <Tooltip content={hidden ? t("sidePanel.show") : t("sidePanel.hide")} placement="bottom">
        <Button variant="icon" onClick={toggleSidePanel} aria-label={hidden ? t("sidePanel.show") : t("sidePanel.hide")}
          aria-pressed={!hidden} className={`${BUTTON} ${hidden ? "" : ON}`}>
          <PanelIcon className="w-[15px] h-[15px] -scale-x-100" />
        </Button>
      </Tooltip>
    </div>
  );
}
