import { useEffect, useRef } from "react";

import { useUiStore } from "@/app/uiStore";
import { FilesView } from "@/features/explorer/FilesView";
import type { RepoInfo } from "@/features/explorer/types";
import { SearchPanel } from "@/features/search/SearchPanel";
import { ScmPanel } from "@/features/scm/ScmPanel";

import { PANEL_BUTTONS_ATTR } from "./PanelButtons";

/** Diálogos e menus que as vistas abrem fora da gaveta (portais): clicar neles não é clicar fora. */
const OWN_LAYERS = `[${PANEL_BUTTONS_ATTR}], [role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]`;

/**
 * Arquivos, busca e git numa gaveta por cima do conteúdo, encostada à direita. Fecha ao clicar fora
 * ou com Esc; o que se abre dela (um arquivo, um diff) vai como aba, igual antes.
 */
export function ExplorerDrawer({ cwd, repo, title }: { cwd: string | null; repo: RepoInfo | null; title: string }) {
  const drawer = useUiStore((s) => s.drawer);
  const close = useUiStore((s) => s.closeDrawer);
  const box = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!drawer) return;
    // Captura: um `stopPropagation` de um terminal ou do canvas não pode deixar a gaveta aberta.
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target || box.current?.contains(target) || target.closest(OWN_LAYERS)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Esc dentro de um campo da gaveta (a busca) é do campo; fora dela, fecha.
      if (box.current?.contains(document.activeElement) && document.activeElement?.matches("input, textarea")) return;
      close();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [drawer, close]);

  if (!drawer) return null;
  return (
    <aside ref={box} data-explorer-drawer
      className="cc-fade absolute top-0 right-0 bottom-0 z-[34] flex flex-col w-80 max-w-[85%] min-h-0
        bg-gray-50 dark:bg-surface-sunken border-l border-gray-200 dark:border-white/7 shadow-xl shadow-black/20">
      {drawer === "files" && <FilesView cwd={cwd} repo={repo} title={title} />}
      {drawer === "search" && <SearchPanel cwd={cwd} />}
      {drawer === "scm" && <ScmPanel cwd={cwd} />}
    </aside>
  );
}
