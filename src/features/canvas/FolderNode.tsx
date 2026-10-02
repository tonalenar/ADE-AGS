import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { Button, CloseIcon } from "neogestify-ui-components";

import { readDir } from "@/features/explorer/ipc";
import type { DirEntry } from "@/features/explorer/types";
import { useViewTabsStore } from "@/features/tabs/viewStore";

import { FOLDER_MIN, type CanvasFolder } from "./board";
import { canvasActions, useActiveBoardKey } from "./store";

export interface FolderNodeData extends Record<string, unknown> {
  id: string;
  /** La carpeta del proyecto del canvas: de ella cuelgan las pestañas de archivo que se abren. */
  cwd: string;
  folder: CanvasFolder;
}
export type FolderFlowNode = Node<FolderNodeData, "folder">;

const MAX_ROWS = 600;

export interface Row {
  entry: DirEntry;
  depth: number;
  expanded: boolean;
}

/**
 * Aplana el árbol a las filas que se ven: cada carpeta abierta mete sus hijos debajo, con
 * un tope de filas (una carpeta con miles de entradas no puede colgar el canvas). Pura,
 * para probarla sin disco.
 */
export function flatten(
  root: string,
  listing: Record<string, DirEntry[]>,
  open: ReadonlySet<string>,
  showHidden: boolean,
  limit = MAX_ROWS,
): { rows: Row[]; truncated: boolean } {
  const rows: Row[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number) => {
    for (const entry of listing[dir] ?? []) {
      if (!showHidden && entry.isHidden) continue;
      if (rows.length >= limit) {
        truncated = true;
        return;
      }
      const expanded = entry.isDir && open.has(entry.path);
      rows.push({ entry, depth, expanded });
      if (expanded) walk(entry.path, depth + 1);
      if (truncated) return;
    }
  };
  walk(root, 0);
  return { rows, truncated };
}

/**
 * Una carpeta puesta en el canvas: su árbol de archivos a la vista, a mano, junto a lo que
 * se está haciendo. Un clic en un archivo lo abre en una pestaña del editor; las carpetas
 * se abren y se cierran en el lugar.
 *
 * Decoración y atajo: ningún agente la ve. Solo lee la carpeta (no la modifica).
 */
export const FolderNode = memo(function FolderNode({ data, selected }: NodeProps<FolderFlowNode>) {
  const { t } = useTranslation();
  const key = useActiveBoardKey();
  const { id, cwd, folder } = data;
  const [listing, setListing] = useState<Record<string, DirEntry[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [armed, setArmed] = useState(false);
  const open = useMemo(() => new Set(folder.open), [folder.open]);

  const load = useCallback(async (dir: string) => {
    try {
      const entries = await readDir(dir);
      setListing((prev) => ({ ...prev, [dir]: entries }));
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }, []);

  // La raíz y cada carpeta abierta se leen al aparecer.
  useEffect(() => {
    setError(null);
    void load(folder.path);
  }, [folder.path, load]);
  useEffect(() => {
    for (const dir of folder.open) if (!(dir in listing)) void load(dir);
    // `listing` cambia al cargar: solo importa qué carpetas hay abiertas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder.open, load]);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const { rows, truncated } = useMemo(() => flatten(folder.path, listing, open, showHidden), [folder.path, listing, open, showHidden]);

  const toggle = (dir: string) => {
    if (!key) return;
    const next = open.has(dir) ? folder.open.filter((d) => d !== dir) : [...folder.open, dir];
    canvasActions.updateFolder(key, id, { open: next });
  };

  const refresh = () => {
    setListing({});
    setError(null);
    void load(folder.path);
    for (const dir of folder.open) void load(dir);
  };

  const change = async () => {
    const picked = await pickFolder({ directory: true, multiple: false, defaultPath: folder.path });
    if (typeof picked === "string" && key) {
      canvasActions.updateFolder(key, id, { path: picked, name: baseName(picked), open: [] });
    }
  };

  return (
    <div className={`h-full w-full flex flex-col rounded-lg overflow-hidden border bg-white dark:bg-surface
      ${selected ? "border-accent-500 dark:border-accent-400 shadow-[0_0_0_1px_var(--color-accent-400)]" : "border-emerald-300/70 dark:border-emerald-200/15"}`}>
      <NodeResizer isVisible={selected} minWidth={FOLDER_MIN.w} minHeight={FOLDER_MIN.h}
        lineClassName="border-transparent!" handleClassName="w-2.5! h-2.5! rounded-sm! bg-accent-400! border-0!" />

      <div className="ade-node-drag flex items-center gap-2 pl-3 pr-1.5 h-[34px] shrink-0 cursor-grab active:cursor-grabbing
        border-b border-emerald-200 dark:border-emerald-100/10 bg-emerald-50 dark:bg-emerald-100/5">
        <FolderIcon className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-300/80" />
        <span className="truncate text-[12.5px] font-medium text-gray-800 dark:text-gray-100" title={folder.path}>{folder.name}</span>
        <span className="flex-1" />
        <IconButton label={t("canvas.folder.hidden")} pressed={showHidden} onClick={() => setShowHidden((v) => !v)}>
          <span className="text-[11px] font-bold leading-none">.*</span>
        </IconButton>
        <IconButton label={t("canvas.folder.refresh")} onClick={refresh}><span className="text-[13px] leading-none">↻</span></IconButton>
        <IconButton label={t("canvas.folder.change")} onClick={() => void change()}><span className="text-[12px] leading-none">⋯</span></IconButton>
        <Button variant="custom"
          onClick={() => (armed ? key && canvasActions.removeFolder(key, id) : setArmed(true))}
          title={armed ? t("canvas.folder.deleteConfirm") : t("canvas.folder.delete")}
          aria-label={armed ? t("canvas.folder.deleteConfirm") : t("canvas.folder.delete")}
          className={`nodrag cc-t shrink-0 flex items-center justify-center h-6 rounded-md
            ${armed ? "px-2 text-[11px] font-medium text-white bg-red-500 hover:bg-red-600"
              : "w-6 text-gray-400 hover:text-red-500 hover:bg-emerald-200/60 dark:hover:bg-white/8"}`}>
          {armed ? t("canvas.folder.deleteConfirm") : <CloseIcon className="w-3 h-3" />}
        </Button>
      </div>

      {/* `nodrag nowheel`: dentro del árbol, arrastrar y la rueda son del árbol. */}
      <div className="nodrag nowheel flex-1 min-h-0 overflow-y-auto py-1 text-[12px]">
        {error ? (
          <p className="px-3 py-2 text-red-500 dark:text-red-400">{error}</p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-2 text-gray-400 dark:text-gray-500">{listing[folder.path] ? t("canvas.folder.empty") : "…"}</p>
        ) : (
          rows.map(({ entry, depth, expanded }) => (
            <button key={entry.path} type="button"
              onClick={() => (entry.isDir ? toggle(entry.path) : useViewTabsStore.getState().openFile(cwd || folder.path, entry.path))}
              title={entry.path}
              className="w-full flex items-center gap-1.5 h-[22px] pr-2 text-left hover:bg-gray-100 dark:hover:bg-white/6
                text-gray-700 dark:text-gray-300"
              style={{ paddingLeft: 8 + depth * 14 }}>
              <span className="w-3 shrink-0 text-center text-[9px] text-gray-400">{entry.isDir ? (expanded ? "▾" : "▸") : ""}</span>
              <span className={`truncate ${entry.isDir ? "font-medium text-gray-800 dark:text-gray-100" : ""} ${entry.isHidden ? "opacity-60" : ""}`}>
                {entry.name}
              </span>
            </button>
          ))
        )}
        {truncated && <p className="px-3 py-1 text-[10.5px] text-gray-400 dark:text-gray-500">{t("canvas.folder.truncated", { count: MAX_ROWS })}</p>}
      </div>
    </div>
  );
});

/** El nombre de la última carpeta de una ruta, con cualquiera de las dos barras. */
export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function IconButton({ label, onClick, pressed, children }: { label: string; onClick: () => void; pressed?: boolean; children: React.ReactNode }) {
  return (
    <Button variant="custom" onClick={onClick} title={label} aria-label={label} aria-pressed={pressed}
      className={`nodrag cc-t shrink-0 w-6 h-6 flex items-center justify-center rounded-md
        ${pressed ? "bg-emerald-200/70 dark:bg-white/12 text-gray-800 dark:text-white" : "text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-emerald-200/50 dark:hover:bg-white/8"}`}>
      {children}
    </Button>
  );
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}
