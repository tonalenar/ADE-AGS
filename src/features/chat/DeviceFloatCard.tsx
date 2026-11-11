import { lazy, Suspense, useCallback, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { CHAT_SHELL_ATTR } from "./ConversationView";
import { deviceFloatBox, type DeviceFloatBox } from "./deviceFloatModel";
import { addSurface, closeDeviceFloat, useChatStore } from "./store";

// O flutuante mostra o mesmo painel do aparelho (a tela nativa e os controles), só que sobre a conversa: o botão de cada
// aparelho continua no DevicesPane, e nada aqui copia a tela.
const IosPane = lazy(() => import("./DevicesPane").then((m) => ({ default: m.IosPane })));
const AndroidPane = lazy(() => import("./DevicesPane").then((m) => ({ default: m.AndroidPane })));

const sameBox = (a: DeviceFloatBox | null, b: DeviceFloatBox) =>
  a !== null && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

/**
 * O aparelho que um agente abriu, flutuando sobre a conversa (como o navegador flutuante). Some quando a conversa não
 * está à vista; fechar só tira a janela, e o aparelho segue ligado. "Abrir no painel" troca para a aba da coluna.
 */
export function DeviceFloatHost({ hidden }: { hidden: boolean }) {
  const { t } = useTranslation();
  const kind = useChatStore((s) => s.deviceFloat);
  const name = useChatStore((s) => (s.deviceFloat ? s.deviceNames[s.deviceFloat] : null));
  const [box, setBox] = useState<DeviceFloatBox | null>(null);

  const measure = useCallback(() => {
    const main = document.querySelector<HTMLElement>(`[${CHAT_SHELL_ATTR}] main`);
    if (!main) return setBox(null);
    const rect = main.getBoundingClientRect();
    const next = deviceFloatBox({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    setBox((prev) => (sameBox(prev, next) ? prev : next));
  }, []);

  useLayoutEffect(() => {
    if (kind === null || hidden) return;
    measure();
    const main = document.querySelector<HTMLElement>(`[${CHAT_SHELL_ATTR}] main`);
    const shell = document.querySelector<HTMLElement>(`[${CHAT_SHELL_ATTR}]`);
    const observer = new ResizeObserver(measure);
    if (main) observer.observe(main);
    if (shell) observer.observe(shell);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [kind, hidden, measure]);

  if (kind === null || hidden || box === null) return null;
  const fallback = t(kind === "ios" ? "chat.deviceFloat.kind.ios" : "chat.deviceFloat.kind.android");
  return (
    <section aria-label={t("chat.deviceFloat.label")} data-device-float={kind}
      className="fixed z-40 flex flex-col overflow-hidden rounded-2xl bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)]"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-gray-200 px-3 dark:border-white/10">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-gray-800 dark:text-white/85">{name || fallback}</span>
        <button type="button" onClick={() => addSurface(kind)}
          className="h-7 shrink-0 rounded-md px-2 text-[12px] text-gray-600 hover:bg-gray-100 dark:text-white/65 dark:hover:bg-white/[0.07]">
          {t("chat.deviceFloat.openPanel")}
        </button>
        <button type="button" aria-label={t("chat.deviceFloat.close")} title={t("chat.deviceFloat.close")} onClick={closeDeviceFloat}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 dark:text-white/50 dark:hover:bg-white/[0.07]">
          ✕
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={null}>{kind === "ios" ? <IosPane /> : <AndroidPane />}</Suspense>
      </div>
    </section>
  );
}
