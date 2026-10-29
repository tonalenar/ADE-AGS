import { useEffect, useRef } from "react";

import { boxOf, clippingAncestors, COVER_MS, coversOf } from "@/features/browser/nativeSurface";
import { placeOf, type Box } from "@/features/browser/realBrowser";

import { simulatorAttach, simulatorDetach, simulatorPlace, type SimPlace } from "./ipc";

/** O aparelho fica por cima dos outros nós do canvas (terminais, notas, cordas): só menus e diálogos do app abrem
 *  buraco na tela. */
const IGNORE = ".react-flow__node, .react-flow__edge, .react-flow__pane, [data-terminal-tab], [data-term-scale]";

/**
 * O lugar da tela do aparelho. A tela é uma NSView nativa por cima do webview (ver `simulator::native::view`),
 * que mostra a `IOSurface` do simulador sem copiar quadros: este elemento só reserva o espaço e, a cada quadro,
 * diz a ela onde está, o que está à vista e o que do app está por cima (menus, diálogos). Toque e teclado vão
 * direto para o aparelho, sem passar por aqui.
 *
 * Só manda algo quando o lugar muda: com o canvas parado, nada vai ao backend.
 */
export function SimulatorScreen({ screenId, udid, radius, onError }: {
  /** Único por tela aberta (o id do nó, ou o da aba). */
  screenId: string;
  udid: string;
  /** Raio dos cantos da tela em px de layout (o zoom do canvas é aplicado aqui). */
  radius: number;
  onError: (message: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef({ radius, onError });
  latest.current = { radius, onError };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let attached = false;
    let closed = false;
    let sent: SimPlace | null = null;
    let clips: HTMLElement[] = clippingAncestors(el);
    let covers: Box[] = [];
    let coveredAt = 0;
    let frame = 0;

    const measure = (): SimPlace => {
      const rect = boxOf(el);
      const now = performance.now();
      const shown = document.visibilityState !== "hidden" && rect.width > 1 && rect.height > 1
        && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
      if (shown && now - coveredAt > COVER_MS) {
        coveredAt = now;
        clips = clippingAncestors(el);
        covers = coversOf(el, rect, IGNORE);
      }
      const windowBox = { x: 0, y: 0, width: innerWidth, height: innerHeight };
      const place = placeOf(rect, el.offsetWidth, 1, [windowBox, ...clips.map(boxOf)], shown ? covers : [], shown);
      return { rect: place.rect, radius: Math.round(latest.current.radius * place.zoom * 10) / 10, visible: place.visible, holes: place.holes };
    };

    const tick = () => {
      if (attached) {
        const place = measure();
        if (!sent || JSON.stringify(sent) !== JSON.stringify(place)) {
          sent = place;
          simulatorPlace(screenId, place).catch(() => undefined);
        }
      }
      frame = requestAnimationFrame(tick);
    };

    sent = measure();
    simulatorAttach(screenId, udid, sent)
      .then(() => {
        if (closed) simulatorDetach(screenId).catch(() => undefined);
        attached = true;
      })
      .catch((e) => latest.current.onError(String(e)));
    frame = requestAnimationFrame(tick);

    return () => {
      closed = true;
      cancelAnimationFrame(frame);
      simulatorDetach(screenId).catch(() => undefined);
    };
  }, [screenId, udid]);

  return <div ref={box} data-simulator-screen className="absolute inset-0" />;
}
