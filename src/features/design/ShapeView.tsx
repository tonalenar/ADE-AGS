import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { arrowHead, fillClass, headClass, polylinePath, shapeBox, strokeClass, textClass, type Shape } from "./shapes";

/**
 * Uma forma no mundo (retângulo, oval, linha, seta, lápis, caneta, texto). Linhas e traços têm uma
 * área de clique mais larga e invisível. O texto edita no lugar com duplo clique.
 */
export const ShapeView = memo(function ShapeView({ shape, selected, editing, onDown, onEditStart, onEditEnd, onContext }: {
  shape: Shape;
  selected: boolean;
  editing: boolean;
  onDown: (e: React.PointerEvent, id: string) => void;
  onEditStart: (id: string) => void;
  /** `null` = desistiu (Esc). */
  onEditEnd: (id: string, text: string | null) => void;
  onContext: (e: React.MouseEvent, id: string) => void;
}) {
  const { t } = useTranslation();
  const box = shapeBox(shape);
  const { data } = shape;
  const sw = data.width;
  const pad = Math.max(sw, 6);
  const [text, setText] = useState(data.text);
  useEffect(() => { if (editing) setText(data.text); }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps -- só ao abrir

  const common = {
    "data-shape": shape.id,
    onPointerDown: (e: React.PointerEvent) => { if (!editing) onDown(e, shape.id); },
    onContextMenu: (e: React.MouseEvent) => onContext(e, shape.id),
  };
  const ring = selected ? { outline: "calc(1.5px * var(--inv)) solid var(--color-accent-500)", outlineOffset: "calc(3px * var(--inv))" } : undefined;

  if (shape.kind === "text") {
    return (
      <div {...common} onDoubleClick={() => onEditStart(shape.id)}
        className={`absolute ${textClass(data.stroke)} ${editing ? "" : "cursor-move"} leading-tight whitespace-pre-wrap break-words`}
        style={{ left: box.x, top: box.y, width: Math.max(40, box.w), minHeight: box.h, fontSize: data.size, ...ring }}>
        {editing ? (
          <textarea autoFocus value={text} aria-label={t("design.shape.text")} onChange={(e) => setText(e.target.value)}
            onBlur={() => onEditEnd(shape.id, text)} onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onEditEnd(shape.id, null); }}
            className="block w-full resize-none bg-transparent outline-none ring-1 ring-accent-500" style={{ fontSize: data.size, minHeight: box.h }} />
        ) : (data.text || <span className="opacity-40">{t("design.shape.textPlaceholder")}</span>)}
      </div>
    );
  }

  // Coordenadas locais da caixa, com folga para o traço não ser cortado.
  const w = box.w;
  const h = box.h;
  const lx1 = shape.x - box.x;
  const ly1 = shape.y - box.y;
  const lx2 = shape.x + shape.w - box.x;
  const ly2 = shape.y + shape.h - box.y;
  let body: React.ReactNode = null;
  let hit: React.ReactNode = null;
  switch (shape.kind) {
    case "rect":
      body = <rect x={0} y={0} width={w} height={h} rx={2} strokeWidth={sw} className={`${strokeClass(data.stroke)} ${fillClass(data.fill)}`} pointerEvents="all" />;
      break;
    case "oval":
      body = <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} strokeWidth={sw} className={`${strokeClass(data.stroke)} ${fillClass(data.fill)}`} pointerEvents="all" />;
      break;
    case "line":
    case "arrow": {
      body = (
        <>
          <line x1={lx1} y1={ly1} x2={lx2} y2={ly2} strokeWidth={sw} strokeLinecap="round" className={strokeClass(data.stroke)} />
          {shape.kind === "arrow" && (
            <polygon points={arrowHead(lx1, ly1, lx2, ly2, Math.max(10, sw * 4)).map((p) => p.join(",")).join(" ")} className={headClass(data.stroke)} />
          )}
        </>
      );
      hit = <line x1={lx1} y1={ly1} x2={lx2} y2={ly2} stroke="transparent" strokeWidth={sw + 12} pointerEvents="stroke" />;
      break;
    }
    case "pencil":
    case "pen": {
      const d = polylinePath(data.points, w, h);
      body = <path d={d} fill="none" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" className={strokeClass(data.stroke)} />;
      hit = <path d={d} fill="none" stroke="transparent" strokeWidth={sw + 12} pointerEvents="stroke" />;
      break;
    }
  }
  return (
    <div className="absolute pointer-events-none" style={{ left: box.x - pad, top: box.y - pad, width: w + pad * 2, height: h + pad * 2 }}>
      <div className="absolute pointer-events-none" style={{ left: pad, top: pad, width: w, height: h, ...ring }} />
      <svg {...common} width={w + pad * 2} height={h + pad * 2} className="absolute left-0 top-0 overflow-visible cursor-move"
        style={{ pointerEvents: "none" }}>
        <g transform={`translate(${pad} ${pad})`} style={{ pointerEvents: "auto" }}>{body}{hit}</g>
      </svg>
    </div>
  );
});
