import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

/** Qué hace el mouse sobre el canvas: mover y seleccionar, dibujar o borrar trazos. */
export type Tool = "select" | "draw" | "erase";

export interface DrawStyle {
  color: string;
  width: number;
}

export const DRAW_COLORS = ["#f8fafc", "#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7"] as const;
export const DRAW_WIDTHS = [2, 4, 8] as const;

const icon = "w-[18px] h-[18px]";

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
      className={icon} aria-hidden>
      {children}
    </svg>
  );
}

const ICONS = {
  select: <Svg><path d="M5 3l14 7-6 2-2 6-6-15Z" /></Svg>,
  terminal: <Svg><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M12 15h5" /></Svg>,
  note: <Svg><path d="M5 4h14v11l-5 5H5V4Z" /><path d="M14 20v-5h5" /></Svg>,
  image: <Svg><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-8 9" /></Svg>,
  folder: <Svg><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></Svg>,
  portal: <Svg><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z" /></Svg>,
  device: <Svg><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18.5h2" /></Svg>,
  text: <span className="text-[15px] font-semibold leading-none">Aa</span>,
  draw: <Svg><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z" /><path d="M14 7l3 3" /></Svg>,
  erase: <Svg><path d="M7 20h11M5 13l8-8a2 2 0 0 1 3 0l3 3a2 2 0 0 1 0 3l-8 8H9l-4-4a2 2 0 0 1 0-2Z" /><path d="M9 9l6 6" /></Svg>,
  undo: <Svg><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></Svg>,
};

function ToolButton({ label, active, onClick, children, disabled }: {
  label: string; active?: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean;
}) {
  return (
    <Button variant="custom" onClick={onClick} title={label} aria-label={label} aria-pressed={active} disabled={disabled}
      className={`cc-t w-8 h-8 flex items-center justify-center rounded-md disabled:opacity-35
        ${active
          ? "bg-accent-500/15 text-accent-600 dark:bg-accent-500/20 dark:text-accent-300"
          : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.06] hover:text-gray-800 dark:hover:text-gray-100"}`}>
      {children}
    </Button>
  );
}

/** Material translúcido de las dos cápsulas de la barra (estilo macOS). */
const material = "border-black/[0.08] dark:border-white/[0.08] bg-white/85 dark:bg-surface-raised/75 backdrop-blur-[30px] backdrop-saturate-[180%] shadow-[0_0_0_0.5px_rgba(255,255,255,0.08),0_10px_30px_rgba(0,0,0,0.45),0_2px_6px_rgba(0,0,0,0.3)]";

const Divider = () => <span aria-hidden className="w-px h-5 mx-0.5 bg-black/10 dark:bg-white/[0.08]" />;

/**
 * La barra de herramientas del canvas: seleccionar, abrir un terminal, y poner una nota, una
 * imagen, un portal (navegador), un texto o dibujar encima.
 *
 * Las que ponen algo (nota, imagen, portal, texto) lo dejan en el centro de lo que se ve y
 * vuelven a seleccionar. Dibujar y borrar sí son un modo: el mouse deja de mover nodos hasta
 * volver a "seleccionar".
 */
export function CanvasToolbar({
  tool, onTool, onTerminal, onNote, onImage, onFolder, onPortal, onDevice, onText, style, onStyle, onUndo, canUndo,
}: {
  tool: Tool;
  onTool: (tool: Tool) => void;
  onTerminal: () => void;
  onNote: () => void;
  onImage: () => void;
  onFolder: () => void;
  onPortal: () => void;
  onDevice: () => void;
  onText: () => void;
  style: DrawStyle;
  onStyle: (style: DrawStyle) => void;
  onUndo: () => void;
  canUndo: boolean;
}) {
  const { t } = useTranslation();
  const drawing = tool === "draw" || tool === "erase";

  return (
    <div className="pointer-events-auto absolute left-1/2 top-3 -translate-x-1/2 flex flex-col items-center gap-1.5">
      <div className={`flex items-center gap-0.5 p-1 rounded-xl border ${material}`}>
        <ToolButton label={t("canvas.tool.select")} active={tool === "select"} onClick={() => onTool("select")}>{ICONS.select}</ToolButton>
        <Divider />
        <ToolButton label={t("canvas.tool.terminal")} onClick={onTerminal}>{ICONS.terminal}</ToolButton>
        <ToolButton label={t("canvas.tool.note")} onClick={onNote}>{ICONS.note}</ToolButton>
        <ToolButton label={t("canvas.tool.image")} onClick={onImage}>{ICONS.image}</ToolButton>
        <ToolButton label={t("canvas.tool.folder")} onClick={onFolder}>{ICONS.folder}</ToolButton>
        <ToolButton label={t("canvas.tool.portal")} onClick={onPortal}>{ICONS.portal}</ToolButton>
        <ToolButton label={t("canvas.tool.device")} onClick={onDevice}>{ICONS.device}</ToolButton>
        <ToolButton label={t("canvas.tool.text")} onClick={onText}>{ICONS.text}</ToolButton>
        <Divider />
        <ToolButton label={t("canvas.tool.draw")} active={drawing} onClick={() => onTool(tool === "draw" ? "select" : "draw")}>{ICONS.draw}</ToolButton>
      </div>

      {drawing && (
        <div className={`flex items-center gap-1 px-2 py-1 rounded-xl border ${material}`}>
          {DRAW_COLORS.map((color) => (
            <button key={color} type="button" aria-label={color} aria-pressed={tool === "draw" && style.color === color}
              onClick={() => { onStyle({ ...style, color }); onTool("draw"); }}
              className="cc-t w-5 h-5 rounded-full border border-black/15"
              style={{
                background: color,
                boxShadow: tool === "draw" && style.color === color ? `0 0 0 2px var(--color-surface-raised, white), 0 0 0 3.5px ${color}` : undefined,
              }} />
          ))}
          <Divider />
          {DRAW_WIDTHS.map((width) => (
            <button key={width} type="button" aria-label={t("canvas.tool.width", { width })} aria-pressed={style.width === width}
              onClick={() => { onStyle({ ...style, width }); onTool("draw"); }}
              className={`cc-t w-6 h-6 flex items-center justify-center rounded-md
                ${style.width === width ? "bg-gray-100 dark:bg-white/[0.12]" : "hover:bg-gray-100 dark:hover:bg-white/[0.06]"}`}>
              <span className="rounded-full bg-gray-600 dark:bg-gray-300" style={{ width: width + 3, height: width + 3 }} />
            </button>
          ))}
          <Divider />
          <ToolButton label={t("canvas.tool.erase")} active={tool === "erase"} onClick={() => onTool(tool === "erase" ? "draw" : "erase")}>{ICONS.erase}</ToolButton>
          <ToolButton label={t("canvas.tool.undo")} onClick={onUndo} disabled={!canUndo}>{ICONS.undo}</ToolButton>
        </div>
      )}
    </div>
  );
}
