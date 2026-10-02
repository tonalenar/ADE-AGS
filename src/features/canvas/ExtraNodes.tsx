import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { Button, CloseIcon } from "neogestify-ui-components";

import { TEXT_SIZES, type CanvasImage, type CanvasText } from "./board";
import { canvasActions, useActiveBoardKey } from "./store";

// ── Texto ───────────────────────────────────────────────────────────

export interface TextNodeData extends Record<string, unknown> {
  id: string;
  text: CanvasText;
}
export type TextFlowNode = Node<TextNodeData, "text">;

/**
 * Un rótulo suelto sobre el canvas: texto sin marco, para titular una zona o dejar una
 * aclaración al lado de lo que importa. Decoración: ningún agente lo lee (para eso están
 * las notas).
 *
 * Se agarra del asa de arriba a la izquierda (el texto en sí es de escribir), y solo se ve
 * el marco cuando está seleccionado o con el mouse encima.
 */
export const TextNode = memo(function TextNode({ data, selected }: NodeProps<TextFlowNode>) {
  const { t } = useTranslation();
  const key = useActiveBoardKey();
  const { id, text } = data;
  const area = useRef<HTMLTextAreaElement>(null);

  // Un rótulo recién creado nace listo para escribir.
  useEffect(() => {
    if (selected && text.text === "") area.current?.focus();
    // Solo al crearse: después, el foco es de quien escribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nextSize = () => {
    const at = TEXT_SIZES.findIndex((s) => s >= text.size);
    const next = TEXT_SIZES[(at + 1) % TEXT_SIZES.length];
    if (key) canvasActions.updateText(key, id, { size: next });
  };

  return (
    <div className={`group h-full w-full rounded-md ${selected ? "ring-1 ring-accent-400" : "hover:ring-1 hover:ring-gray-400/40"}`}>
      <NodeResizer isVisible={selected} minWidth={80} minHeight={32}
        lineClassName="border-transparent!" handleClassName="w-2.5! h-2.5! rounded-sm! bg-accent-400! border-0!" />
      <div className={`absolute -top-6 left-0 flex items-center gap-0.5 rounded-md px-0.5 py-0.5
        bg-white/95 dark:bg-surface-raised/95 border border-gray-200 dark:border-white/10 shadow-sm
        ${selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
        <span className="ade-node-drag cursor-grab active:cursor-grabbing px-1 text-[12px] leading-none text-gray-400 select-none"
          title={t("canvas.text.drag")}>⠿</span>
        <Button variant="custom" onClick={nextSize} title={t("canvas.text.size")}
          className="nodrag cc-t h-5 px-1.5 rounded text-[11px] font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/8">
          Aa
        </Button>
        <Button variant="custom" onClick={() => key && canvasActions.removeText(key, id)} title={t("canvas.text.delete")}
          aria-label={t("canvas.text.delete")}
          className="nodrag cc-t w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-red-500">
          <CloseIcon className="w-3 h-3" />
        </Button>
      </div>
      <textarea
        ref={area}
        value={text.text}
        onChange={(e) => key && canvasActions.updateText(key, id, { text: e.target.value })}
        placeholder={t("canvas.text.placeholder")}
        aria-label={t("canvas.text.placeholder")}
        spellCheck={false}
        style={{ fontSize: text.size, lineHeight: 1.25 }}
        // Igual que la nota: seleccionado es de escribir, sin seleccionar se agarra de cualquier lado.
        className={`${selected ? "nodrag nowheel" : ""} h-full w-full resize-none overflow-hidden bg-transparent outline-none px-1.5 py-1
          font-semibold text-gray-800 dark:text-gray-100 placeholder:text-gray-400/60 dark:placeholder:text-gray-500/60`}
      />
    </div>
  );
});

// ── Imagen ──────────────────────────────────────────────────────────

export interface ImageNodeData extends Record<string, unknown> {
  id: string;
  image: CanvasImage;
}
export type ImageFlowNode = Node<ImageNodeData, "image">;

/** Las que ya se leyeron del disco: un nodo se renderiza muchas veces y la imagen pesa. */
const loaded = new Map<string, string>();

/**
 * Una imagen en el canvas (una captura, un diseño, un diagrama). Decoración, como el texto.
 * Se agarra de cualquier parte; el borrar y el marco aparecen con el mouse encima.
 */
export const ImageNode = memo(function ImageNode({ data, selected }: NodeProps<ImageFlowNode>) {
  const { t } = useTranslation();
  const key = useActiveBoardKey();
  const { id, image } = data;
  const [src, setSrc] = useState<string | null>(loaded.get(image.asset) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (loaded.has(image.asset)) return setSrc(loaded.get(image.asset) ?? null);
    let alive = true;
    invoke<string>("canvas_asset_load", { id: image.asset })
      .then((url) => {
        loaded.set(image.asset, url);
        if (alive) setSrc(url);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [image.asset]);

  return (
    <div className={`group relative h-full w-full rounded-md overflow-hidden
      ${selected ? "ring-1 ring-accent-400" : "hover:ring-1 hover:ring-gray-400/40"}`}>
      <NodeResizer isVisible={selected} minWidth={40} minHeight={40} keepAspectRatio
        lineClassName="border-transparent!" handleClassName="w-2.5! h-2.5! rounded-sm! bg-accent-400! border-0!" />
      {src ? (
        <img src={src} alt={image.name} draggable={false} className="h-full w-full object-contain select-none" />
      ) : (
        <div className="h-full w-full flex items-center justify-center text-[11px] text-gray-400 bg-gray-100 dark:bg-white/5">
          {failed ? t("canvas.image.missing") : "…"}
        </div>
      )}
      <Button variant="custom" onClick={() => key && canvasActions.removeImage(key, id)} title={t("canvas.image.delete")}
        aria-label={t("canvas.image.delete")}
        className={`nodrag cc-t absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded
          bg-black/55 text-white hover:bg-red-500 ${selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
        <CloseIcon className="w-3 h-3" />
      </Button>
    </div>
  );
});
