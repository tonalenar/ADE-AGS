import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { DESIGN_SANDBOX } from "@/features/canvas/design/srcdoc";

import { studioSrcdoc } from "./frameBridge";
import type { Corner } from "./snap";
import { AgentCursorIcon, ExpandIcon, PlayIcon, StopIcon } from "./studioIcons";
import { layoutColumns } from "./studioModel";

export interface StudioBoard { id: string; title: string; x: number; y: number; w: number; h: number; html: string; radius: number; version: number }

/** Os handlers vêm estáveis do DesignStudio (refs), para o `memo` segurar o iframe parado. */
export interface FrameHandlers {
  onTitleDown: (e: React.PointerEvent, id: string) => void;
  onGripDown: (e: React.PointerEvent, id: string, corner: Corner) => void;
  onRenameStart: (id: string) => void;
  /** `null` = desistiu (Esc). */
  onRename: (id: string, title: string | null) => void;
  onContext: (e: React.MouseEvent, id: string) => void;
  onExpand: (id: string) => void;
  onPlay: (id: string) => void;
  onFrameLoad: (id: string) => void;
  onForceLoad: (id: string) => void;
  register: (id: string, el: HTMLIFrameElement | null) => void;
}

const CORNERS: Array<{ c: Corner; cls: string; cursor: string }> = [
  { c: "nw", cls: "left-0 top-0", cursor: "nwse-resize" },
  { c: "ne", cls: "left-full top-0", cursor: "nesw-resize" },
  { c: "sw", cls: "left-0 top-full", cursor: "nesw-resize" },
  { c: "se", cls: "left-full top-full", cursor: "nwse-resize" },
];

/**
 * Uma prancheta no mundo: a moldura branca (sombra, anel de 1 px, raio) com o iframe isolado, o título
 * acima em tamanho constante na tela (`--inv` = 1/escala), as alças nos 4 cantos quando selecionada e,
 * fora da vista, o placeholder listrado "Carregar prancheta".
 */
export const ArtboardFrame = memo(function ArtboardFrame({ board, live, selected, grips, passThrough, agent, renaming, playing, editing = false, guides, h }: {
  board: StudioBoard;
  live: boolean;
  selected: boolean;
  grips: boolean;
  /** O iframe não pega o mouse (Mão, criação, arrasto em curso). */
  passThrough: boolean;
  /** O nome do agente que acabou de mudar esta prancheta (cursor violeta), ou `null`. */
  agent: string | null;
  /** O título está em edição (duplo clique ou "Renomear" do menu). */
  renaming: boolean;
  /** O protótipo está vivo dentro da moldura (Play no canvas). */
  playing: boolean;
  /** Tocando e selecionada com a Seleção: o botão vira "Editar" (para de tocar e volta a editar). */
  editing?: boolean;
  /** Guias de layout (Shift+G): 12 colunas. */
  guides: boolean;
  h: FrameHandlers;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(board.title);
  useEffect(() => { if (renaming) setName(board.title); }, [renaming]); // eslint-disable-line react-hooks/exhaustive-deps -- só ao abrir
  const srcDoc = useMemo(() => (live ? studioSrcdoc(board.html) : ""), [live, board.html]);
  const commit = () => {
    const next = name.trim();
    h.onRename(board.id, next && next !== board.title ? next : null);
  };
  return (
    <div data-board={board.id} className="absolute" style={{ left: board.x, top: board.y, width: board.w, height: board.h }}>
      {/* Faixa do título: 24 px de tela + 4 px até a moldura, sempre do mesmo tamanho. */}
      <div className="absolute left-0 bottom-full origin-bottom-left pb-1"
        style={{ width: `calc(${board.w}px * var(--s))`, transform: "scale(var(--inv))" }}>
        <div className={`h-6 flex items-center gap-1.5 text-xs select-none cursor-grab active:cursor-grabbing
          ${selected ? "text-accent-600 dark:text-accent-300" : "text-gray-500 dark:text-white/55"}`}
          onPointerDown={(e) => { if (!renaming) h.onTitleDown(e, board.id); }}
          onDoubleClick={() => h.onRenameStart(board.id)}
          onContextMenu={(e) => h.onContext(e, board.id)}>
          {renaming ? (
            <input autoFocus value={name} aria-label={t("design.studio.renameBoard")}
              onChange={(e) => setName(e.target.value)} onBlur={commit}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commit();
                if (e.key === "Escape") h.onRename(board.id, null);
              }}
              className="h-5 min-w-0 flex-1 px-1 rounded-sm bg-white dark:bg-surface-raised text-gray-900 dark:text-white ring-1 ring-accent-500 outline-none" />
          ) : (
            <span className="min-w-0 truncate" title={board.title}>{board.title}</span>
          )}
          <span className="flex-1" />
          <button type="button" aria-pressed={playing} title={playing ? (editing ? t("design.studio.editHint") : t("design.studio.stop")) : t("design.studio.playOnCanvas")}
            onPointerDown={(e) => e.stopPropagation()} onClick={() => h.onPlay(board.id)}
            className={`h-5 px-1.5 shrink-0 rounded inline-flex items-center gap-1 text-[11px] font-medium
              ${playing ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900" : "text-gray-500 dark:text-white/55 hover:bg-gray-200/70 dark:hover:bg-white/10"}`}>
            {playing ? <StopIcon className="w-2.5 h-2.5" /> : <PlayIcon className="w-2.5 h-2.5" />}
            {playing ? (editing ? t("design.studio.edit") : t("design.studio.stop")) : t("design.studio.play")}
          </button>
          <button type="button" aria-label={t("design.studio.expand")} title={t("design.studio.expand")}
            onPointerDown={(e) => e.stopPropagation()} onClick={() => h.onExpand(board.id)}
            className="w-5 h-5 shrink-0 rounded flex items-center justify-center text-gray-500 dark:text-white/55 hover:bg-gray-200/70 dark:hover:bg-white/10">
            <ExpandIcon className="w-3 h-3" />
          </button>
        </div>
      </div>

      <div className={`absolute inset-0 bg-white overflow-clip shadow-[0_2px_4px_rgba(24,24,27,0.07),0_6px_16px_rgba(24,24,27,0.08)]
        ${playing ? "ring-2 ring-green-500" : agent ? "ring-1 ring-violet-500" : "ring-1 ring-gray-200 dark:ring-white/10"}`}
        style={{
          borderRadius: board.radius,
          outline: selected ? "calc(2px * var(--inv)) solid var(--color-accent-500)" : undefined,
          outlineOffset: selected ? "calc(-1px * var(--inv))" : undefined,
        }}>
        {live ? (
          <iframe ref={(el) => h.register(board.id, el)} title={board.title} sandbox={DESIGN_SANDBOX} srcDoc={srcDoc}
            referrerPolicy="no-referrer" onLoad={() => h.onFrameLoad(board.id)}
            className="block border-0 w-full h-full" style={{ pointerEvents: passThrough ? "none" : "auto" }} />
        ) : (
          <div className="w-full h-full flex items-center justify-center"
            style={{ backgroundImage: "repeating-linear-gradient(135deg, var(--color-gray-100) 0 10px, var(--color-gray-50) 10px 20px)" }}>
            <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => h.onForceLoad(board.id)}
              className="origin-center px-3 h-8 rounded-md bg-white text-[13px] text-gray-700 ring-1 ring-gray-200 shadow-sm hover:bg-gray-50"
              style={{ transform: "scale(var(--inv))" }}>
              {t("design.studio.loadBoard", { title: board.title })}
            </button>
          </div>
        )}
      </div>

      {guides && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ borderRadius: board.radius }} aria-hidden="true">
          {layoutColumns(board.w).map((c, i) => <div key={i} className="absolute top-0 bottom-0 bg-red-500/10" style={{ left: c.x, width: c.w }} />)}
        </div>
      )}
      {grips && CORNERS.map(({ c, cls, cursor }) => (
        <div key={c} role="presentation" onPointerDown={(e) => h.onGripDown(e, board.id, c)}
          className={`absolute ${cls} w-3.5 h-3.5 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center`}
          style={{ cursor, transform: "scale(var(--inv))" }}>
          <div className="w-2 h-2 rounded-[2px] bg-white border border-accent-500" />
        </div>
      ))}

      {agent && (
        <div className="pointer-events-none absolute left-full top-0 origin-top-left" style={{ transform: "scale(var(--inv))" }}>
          <div className="flex items-start gap-0.5 translate-x-[18px] -translate-y-1 text-violet-500">
            <AgentCursorIcon className="w-4 h-4 drop-shadow" />
            <span className="mt-3 px-1.5 h-5 leading-5 rounded-md bg-violet-500 text-white text-[11px] font-medium whitespace-nowrap shadow">{agent}</span>
          </div>
        </div>
      )}
    </div>
  );
});
