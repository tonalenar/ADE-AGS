import { ViewportPortal } from "@xyflow/react";

import { strokePath, type Stroke } from "./board";

/**
 * Los trazos a mano alzada, dibujados en las coordenadas del canvas (se mueven y escalan
 * con él). Van por encima de los nodos, sin interceptar nada: un trazo es una anotación,
 * no algo con lo que se interactúa — salvo con la goma, que sí los agarra.
 *
 * El trazo que se está dibujando (`live`) se muestra igual que los guardados.
 */
export function DrawingLayer({
  strokes, live, erasing, onErase,
}: {
  strokes: Stroke[];
  live: Stroke | null;
  erasing: boolean;
  onErase: (id: string) => void;
}) {
  const all = live ? [...strokes, live] : strokes;
  if (all.length === 0) return null;
  return (
    <ViewportPortal>
      {/* \`overflow: visible\` y 1×1: el SVG es solo un lienzo de coordenadas del canvas. */}
      <svg style={{ position: "absolute", left: 0, top: 0, width: 1, height: 1, overflow: "visible", pointerEvents: "none" }}>
        {all.map((s) => (
          <g key={s.id}>
            {erasing && s.id !== live?.id && (
              // Un trazo fino es difícil de agarrar: la goma tiene una zona más ancha.
              <path d={strokePath(s.points)} fill="none" stroke="transparent" strokeWidth={Math.max(s.width, 16)}
                strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: "stroke", cursor: "pointer" }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onErase(s.id);
                }} />
            )}
            <path d={strokePath(s.points)} fill="none" stroke={s.color} strokeWidth={s.width} strokeLinecap="round"
              strokeLinejoin="round" style={{ pointerEvents: "none" }} />
          </g>
        ))}
      </svg>
    </ViewportPortal>
  );
}
