import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { DESKTOP_OS } from "@/app/platform";
import { useTranslation } from "react-i18next";

import { usePopover } from "@/features/chat/usePopover";
import type { DesignPage } from "@/features/canvas/design/designApi";
import { Segmented } from "@/shared/ui/Segmented";

import { chromeInsets } from "./chromeInsets";
import { canZoomIn, canZoomOut, presetOf, ZOOM_LIMITS, ZOOM_PRESETS, zoomReadout } from "./camera";
import {
  ArrowIcon, BackIcon, CaretIcon, CheckIcon, CommentIcon, DotsIcon, ExportIcon, FrameIcon, HandIcon, LineIcon, NoteIcon, OvalIcon,
  PenIcon, PencilIcon, PlusIcon, RectIcon, SelectIcon, TextIcon,
} from "./studioIcons";
import { DRAW_TOOLS, SHAPE_TOOLS, TOOLS, type DrawTool, type ShapeTool, type Tool } from "./studioModel";

/** O botão "ghost" da barra (altura de controle, sem borda). */
export const ghostBtn = `h-7 px-2 rounded-md inline-flex items-center gap-1.5 text-[12.5px] text-gray-700 dark:text-white/80
  hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-40 disabled:pointer-events-none`;
const menuCls = `absolute top-full mt-1 z-50 p-1 rounded-lg bg-white dark:bg-surface-raised
  shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_8px_24px_rgba(0,0,0,0.12),0_2px_6px_rgba(0,0,0,0.08)]`;
const rowCls = `w-full h-8 px-2 rounded-md flex items-center gap-2 text-left text-[13px] text-gray-800 dark:text-white/85
  hover:bg-gray-100 dark:hover:bg-white/[0.07] disabled:opacity-40 disabled:hover:bg-transparent`;

export const TOOL_ICON: Record<Tool, (p: { className?: string }) => ReactNode> = {
  select: SelectIcon, hand: HandIcon, text: TextIcon, artboard: FrameIcon, note: NoteIcon, comment: CommentIcon,
  pencil: PencilIcon, pen: PenIcon, rect: RectIcon, oval: OvalIcon, line: LineIcon, arrow: ArrowIcon,
};
const toolBtn = (on: boolean) => `w-8 h-7 rounded-md flex items-center justify-center
  ${on ? "bg-accent-500/15 text-accent-600 dark:text-accent-300" : "text-gray-600 dark:text-white/70 hover:bg-gray-100 dark:hover:bg-white/10"}`;

export interface FocusedBar { title: string; fit: "fill" | "fit"; onFit: (v: "fill" | "fit") => void; onBack: () => void }

/**
 * A barra de 40 px: Páginas à esquerda, as ferramentas no centro e o Zoom à direita. No modo focado
 * vira "Voltar ao canvas" + nome da prancheta e o segmentado Preencher | Caber.
 */
export function StudioToolbar(p: {
  leading?: ReactNode;
  trailing?: ReactNode;
  pages: DesignPage[];
  pageId: string | null;
  onPage: (id: string) => void;
  onAddPage: () => void;
  onRenamePage: (id: string, name: string) => void;
  onDeletePage: (id: string) => void;
  onCopyPageLink: (id: string) => void;
  tool: Tool;
  onTool: (tool: Tool) => void;
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onPreset: (scale: number) => void;
  mod: string;
  focused: FocusedBar | null;
  /** A última ferramenta de desenho e de forma usadas (o botão do menu mostra ela). */
  lastDraw: DrawTool;
  lastShape: ShapeTool;
  guides: boolean;
  onToggleGuides: () => void;
  /** Exportar a prancheta selecionada; `null` = nenhuma (uma só) selecionada. */
  exportBoard: { onHtml: () => void; onPdf: () => void } | null;
  /** Espaço à direita para o X da tela cheia (RouteModal). */
  padRight?: boolean;
}) {
  const { t } = useTranslation();
  if (p.focused) {
    const f = p.focused;
    return (
      <Bar padRight={p.padRight}>
        <button type="button" className={ghostBtn} onClick={f.onBack} title={`${t("design.studio.back")} (Esc)`}>
          <BackIcon className="w-3.5 h-3.5" />{t("design.studio.back")}
        </button>
        <span className="min-w-0 max-w-[40vw] truncate text-sm text-gray-800 dark:text-white/85" title={f.title}>{f.title}</span>
        <span className="flex-1" />
        <Segmented label={t("design.studio.fitMode")} value={f.fit} onChange={f.onFit}
          options={[{ value: "fill", label: t("design.studio.fill") }, { value: "fit", label: t("design.studio.fit") }]} />
      </Bar>
    );
  }
  return (
    <Bar padRight={p.padRight}>
      {/*
        Três grupos que não se encavalam: as páginas (encolhem e truncam), as ferramentas e o zoom (não encolhem), com
        vãos flexíveis entre eles. Antes os grupos das pontas encolhiam até zero e o conteúdo deles passava por baixo das
        ferramentas. Com a barra estreita (< 36rem, `@container/studiobar`), só Seleção e Mão ficam à vista: o resto vai
        para o menu de excesso (⋯), e o seletor de página encolhe.
      */}
      <div className="flex min-w-0 shrink items-center gap-1">
        {p.leading}
        <PagesMenu {...p} />
      </div>
      <span aria-hidden="true" className="flex-1 min-w-1" />
      <div role="toolbar" aria-label={t("design.studio.tools")} className="flex shrink-0 items-center gap-0.5">
        {TOOLS.map(({ id, key }) => {
          const Icon = TOOL_ICON[id];
          const on = p.tool === id;
          const btn = (
            <button key={id} type="button" aria-pressed={on} onClick={() => p.onTool(id)}
              title={`${t(`design.studio.tool.${id}`)} (${key})`} aria-label={t(`design.studio.tool.${id}`)}
              className={`${toolBtn(on)} ${PRIMARY_TOOLS.includes(id) ? "" : SECONDARY}`}>
              <Icon />
            </button>
          );
          // Desenho e formas entram depois da Nota, antes de Comentar.
          return id === "comment" ? [
            <span key="draw" className={`contents ${SECONDARY}`}><ToolMenu label={t("design.studio.drawTools")} items={DRAW_TOOLS} last={p.lastDraw} tool={p.tool} onTool={p.onTool} /></span>,
            <span key="shapes" className={`contents ${SECONDARY}`}><ToolMenu label={t("design.studio.shapes")} items={SHAPE_TOOLS} last={p.lastShape} tool={p.tool} onTool={p.onTool} /></span>,
            btn,
          ] : btn;
        })}
        <ToolOverflow tool={p.tool} onTool={p.onTool} />
      </div>
      <span aria-hidden="true" className="flex-1 min-w-1" />
      <div className="flex shrink-0 items-center justify-end gap-1">
        <ExportMenu {...p} />
        <ZoomMenu {...p} />
        {/* Sem o botão de alternar o painel lateral do estúdio: ao lado do de tela cheia ele parecia duplicado (o painel
            direito do chat tem o próprio). O painel do estúdio continua no atalho (⌘\ ou Ctrl+\). */}
        {p.trailing}
      </div>
    </Bar>
  );
}

/** As ferramentas que ficam à vista mesmo com a barra estreita. */
const PRIMARY_TOOLS: Tool[] = ["select", "hand"];
/** Some da barra estreita (o menu de excesso as mostra). */
const SECONDARY = "@max-[36rem]/studiobar:hidden";

/**
 * O menu de excesso da barra estreita (< 36rem): as ferramentas que saíram da barra (Texto, Prancheta, Nota, desenho,
 * formas, Comentar), com a tecla de cada uma. Na barra larga ele some.
 */
function ToolOverflow({ tool, onTool }: { tool: Tool; onTool: (t: Tool) => void }) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const items: Array<{ id: Tool; key: string }> = [...TOOLS.filter((x) => !PRIMARY_TOOLS.includes(x.id)), ...DRAW_TOOLS, ...SHAPE_TOOLS];
  const active = items.some((i) => i.id === tool);
  return (
    <div ref={ref} data-tool-overflow="" className="relative hidden @max-[36rem]/studiobar:flex">
      <button type="button" aria-pressed={active} aria-expanded={open} onClick={() => setOpen(!open)} className={toolBtn(active)}
        title={t("design.studio.moreTools")} aria-label={t("design.studio.moreTools")}>
        {active ? (() => { const I = TOOL_ICON[tool]; return <I />; })() : <DotsIcon className="w-3.5 h-3.5" />}
      </button>
      {open && (
        <div role="menu" data-studio-menu="" className={`${menuCls} right-0 min-w-48`}>
          {items.map((i) => {
            const I = TOOL_ICON[i.id];
            return (
              <button key={i.id} type="button" role="menuitemradio" aria-checked={tool === i.id} className={rowCls} onClick={() => { onTool(i.id); setOpen(false); }}>
                <I className="w-3.5 h-3.5" /><span className="flex-1">{t(`design.studio.tool.${i.id}`)}</span><kbd className="text-[11px] text-gray-400">{i.key}</kbd>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PagesMenu(p: Parameters<typeof StudioToolbar>[0]) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const current = p.pages.find((pg) => pg.id === p.pageId) ?? null;
  const close = () => { setOpen(false); setRowMenu(null); setRenaming(null); };
  const commitRename = () => {
    if (renaming && renaming.name.trim()) p.onRenamePage(renaming.id, renaming.name.trim());
    setRenaming(null);
  };
  return (
    <div ref={ref} className="relative min-w-0">
      <button type="button" className={`${ghostBtn} min-w-0 max-w-[20rem] @max-[36rem]/studiobar:max-w-[7.5rem]`} aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}
        title={t("design.studio.pagesHint")}>
        <span className="min-w-0 truncate">{current?.name ?? t("design.studio.pages")}</span>
        {p.pages.length > 1 && (
          <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-gray-100 dark:bg-white/10 text-[11px] leading-[18px] text-gray-600 dark:text-white/60 tabular-nums">{p.pages.length}</span>
        )}
        <CaretIcon />
      </button>
      {open && (
        <div role="menu" data-studio-menu="" className={`${menuCls} left-0 min-w-60`} style={{ maxWidth: "28rem" }}>
          {p.pages.map((pg) => (
            <div key={pg.id} className="relative group">
              {renaming?.id === pg.id ? (
                <input autoFocus value={renaming.name} aria-label={t("design.studio.renamePage")}
                  onChange={(e) => setRenaming({ id: pg.id, name: e.target.value })}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  className="w-full h-8 px-2 rounded-md text-[13px] bg-transparent ring-1 ring-accent-500 outline-none" />
              ) : (
                <button type="button" role="menuitemradio" aria-checked={pg.id === p.pageId} className={`${rowCls} pr-9`}
                  onClick={() => { p.onPage(pg.id); close(); }}>
                  <span className="w-3.5 shrink-0 text-accent-600 dark:text-accent-300">{pg.id === p.pageId && <CheckIcon />}</span>
                  <span className="truncate">{pg.name}</span>
                </button>
              )}
              {renaming?.id !== pg.id && (
                <button type="button" aria-label={t("design.studio.pageActions", { name: pg.name })}
                  onClick={() => setRowMenu(rowMenu === pg.id ? null : pg.id)}
                  className="absolute right-1 top-1 w-6 h-6 rounded-md flex items-center justify-center text-gray-500 dark:text-white/50 hover:bg-gray-200 dark:hover:bg-white/10">
                  <DotsIcon className="w-3.5 h-3.5" />
                </button>
              )}
              {rowMenu === pg.id && (
                <div role="menu" className={`${menuCls} left-full top-0 mt-0 ml-1 min-w-48`}>
                  <button type="button" role="menuitem" className={rowCls} onClick={() => { p.onCopyPageLink(pg.id); close(); }}>{t("design.studio.copyPageLink")}</button>
                  <button type="button" role="menuitem" className={rowCls} onClick={() => { setRenaming({ id: pg.id, name: pg.name }); setRowMenu(null); }}>{t("design.studio.rename")}</button>
                  <button type="button" role="menuitem" className={`${rowCls} text-red-600 dark:text-red-400`} disabled={p.pages.length <= 1}
                    title={p.pages.length <= 1 ? t("design.studio.lastPage") : undefined}
                    onClick={() => { p.onDeletePage(pg.id); close(); }}>{t("design.studio.delete")}</button>
                </div>
              )}
            </div>
          ))}
          <div className="my-1 h-px bg-gray-200 dark:bg-white/10" />
          <button type="button" role="menuitem" className={rowCls} onClick={() => { p.onAddPage(); close(); }}>
            <PlusIcon className="w-3.5 h-3.5" />{t("design.studio.newPage")}
          </button>
        </div>
      )}
    </div>
  );
}

function ZoomMenu(p: Parameters<typeof StudioToolbar>[0]) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const preset = presetOf(p.scale);
  const run = (fn: () => void) => () => { fn(); setOpen(false); };
  return (
    <div ref={ref} className="relative">
      <button type="button" className={`${ghostBtn} tabular-nums`} aria-expanded={open} onClick={() => setOpen(!open)}
        title={t("design.studio.zoomHint", { mod: p.mod })}>
        {zoomReadout(p.scale)}%<CaretIcon />
      </button>
      {open && (
        <div role="menu" data-studio-menu="" className={`${menuCls} right-0 min-w-52`}>
          <button type="button" role="menuitem" className={rowCls} disabled={!canZoomIn(p.scale)} onClick={run(p.onZoomIn)}>
            <span className="flex-1">{t("design.studio.zoomIn")}</span><kbd className="text-[11px] text-gray-400">{p.mod}+</kbd>
          </button>
          <button type="button" role="menuitem" className={rowCls} disabled={!canZoomOut(p.scale)} onClick={run(p.onZoomOut)}>
            <span className="flex-1">{t("design.studio.zoomOut")}</span><kbd className="text-[11px] text-gray-400">{p.mod}−</kbd>
          </button>
          <button type="button" role="menuitem" className={rowCls} onClick={run(p.onFit)}>
            <span className="flex-1">{t("design.studio.fitAll")}</span><kbd className="text-[11px] text-gray-400">{p.mod}0</kbd>
          </button>
          <div className="my-1 h-px bg-gray-200 dark:bg-white/10" />
          {preset === null && <div className="h-7 px-2 flex items-center text-[12px] text-gray-500 dark:text-white/45">{t("design.studio.zoomNow", { n: zoomReadout(p.scale) })}</div>}
          {ZOOM_PRESETS.map((z) => {
            const out = z < ZOOM_LIMITS.min || z > ZOOM_LIMITS.max;
            return (
              <button key={z} type="button" role="menuitemradio" aria-checked={preset === z} className={rowCls} disabled={out}
                title={out ? t(z < ZOOM_LIMITS.min ? "design.studio.belowLimit" : "design.studio.pastLimit") : undefined}
                onClick={run(() => p.onPreset(z))}>
                <span className="w-3.5 shrink-0 text-accent-600 dark:text-accent-300">{preset === z && <CheckIcon />}</span>
                <span className="tabular-nums">{Math.round(z * 100)}%</span>
              </button>
            );
          })}
          <div className="my-1 h-px bg-gray-200 dark:bg-white/10" />
          <button type="button" role="menuitemcheckbox" aria-checked={p.guides} className={rowCls} onClick={run(p.onToggleGuides)}>
            <span className="w-3.5 shrink-0 text-accent-600 dark:text-accent-300">{p.guides && <CheckIcon />}</span>
            <span className="flex-1">{t("design.studio.guides")}</span><kbd className="text-[11px] text-gray-400">⇧G</kbd>
          </button>
        </div>
      )}
    </div>
  );
}

/** Um botão que é a última ferramenta do grupo e, pelo caret, abre o menu com as outras. */
function ToolMenu({ label, items, last, tool, onTool }: {
  label: string; items: Array<{ id: Tool; key: string }>; last: Tool; tool: Tool; onTool: (t: Tool) => void;
}) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const active = items.find((i) => i.id === tool);
  const shown = active ?? items.find((i) => i.id === last) ?? items[0];
  const Icon = TOOL_ICON[shown.id];
  return (
    <div ref={ref} className="relative flex items-center">
      <button type="button" aria-pressed={!!active} onClick={() => onTool(shown.id)} className={toolBtn(!!active)}
        title={`${t(`design.studio.tool.${shown.id}`)} (${shown.key})`} aria-label={t(`design.studio.tool.${shown.id}`)}>
        <Icon />
      </button>
      <button type="button" aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen(!open)}
        className="w-3.5 h-7 -ml-0.5 rounded flex items-center justify-center text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/10">
        <CaretIcon className="w-2.5 h-2.5" />
      </button>
      {open && (
        <div role="menu" data-studio-menu="" className={`${menuCls} left-0 min-w-44`}>
          {items.map((i) => {
            const I = TOOL_ICON[i.id];
            return (
              <button key={i.id} type="button" role="menuitemradio" aria-checked={tool === i.id} className={rowCls} onClick={() => { onTool(i.id); setOpen(false); }}>
                <I className="w-3.5 h-3.5" /><span className="flex-1">{t(`design.studio.tool.${i.id}`)}</span><kbd className="text-[11px] text-gray-400">{i.key}</kbd>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Exportar a prancheta selecionada: HTML (.html) e PDF (imprimir). */
function ExportMenu(p: Parameters<typeof StudioToolbar>[0]) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const ex = p.exportBoard;
  return (
    <div ref={ref} className="relative">
      <button type="button" className={toolBtn(false)} aria-expanded={open} onClick={() => setOpen(!open)}
        title={ex ? t("design.export.title") : t("design.export.pickOne")} aria-label={t("design.export.title")}>
        <ExportIcon />
      </button>
      {open && (
        <div role="menu" data-studio-menu="" className={`${menuCls} right-0 min-w-[190px]`}>
          {!ex && <div className="px-2 py-1.5 text-[12px] text-gray-500 dark:text-white/45">{t("design.export.pickOne")}</div>}
          <button type="button" role="menuitem" className={rowCls} disabled={!ex} onClick={() => { ex?.onHtml(); setOpen(false); }}>
            <span className="flex-1">{t("design.export.html")}</span>
          </button>
          <button type="button" role="menuitem" className={rowCls} disabled={!ex} onClick={() => { ex?.onPdf(); setOpen(false); }}>
            <span className="flex-1">{t("design.export.pdf")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A barra de 40 px. Quando ela encosta no topo da janela, deixa livre o canto dos controles da janela
 * (semáforos overlay do macOS à esquerda; botões do Windows/Linux à direita): nada cobre o "Voltar".
 */
function Bar({ padRight, children }: { padRight?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [ins, setIns] = useState({ left: 0, right: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const n = chromeInsets(el.getBoundingClientRect(), window.innerWidth, DESKTOP_OS);
      setIns((p) => (p.left === n.left && p.right === n.right ? p : n));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  return (
    <header ref={ref} data-tauri-drag-region=""
      className="@container/studiobar relative h-10 shrink-0 flex items-center gap-1 border-b border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-deep"
      style={{ paddingLeft: 4 + ins.left, paddingRight: (padRight ? 48 : 4) + ins.right }}>
      {children}
    </header>
  );
}
