import { setChatBrowser, useChatStore } from "./store";

type ChatBrowserSurface = { viewId: string; rect: { left: number; top: number; width: number; height: number } };

function isMeasured(browser: ChatBrowserSurface | null, viewId: string): browser is ChatBrowserSurface {
  return browser?.viewId === viewId && browser.rect.width > 0 && browser.rect.height > 0;
}

/** Espera a medida publicada pelo slot real antes de abrir uma miniatura para o agente. */
export function subscribeToMeasuredChatBrowser(viewId: string, onMeasured: (browser: ChatBrowserSurface) => void): () => void {
  const current = useChatStore.getState().browser;
  if (isMeasured(current, viewId)) {
    onMeasured(current);
    return () => undefined;
  }

  let active = true;
  const unsubscribe = useChatStore.subscribe((state) => {
    if (!active || !isMeasured(state.browser, viewId)) return;
    active = false;
    unsubscribe();
    onMeasured(state.browser);
  });
  return () => {
    active = false;
    unsubscribe();
  };
}

/** Retângulos transitórios sem área não apagam a última medida válida publicada. */
export function publishMeasuredChatBrowser(viewId: string | null, rect: { left: number; top: number; width: number; height: number } | null): void {
  if (!viewId || !rect || rect.width <= 0 || rect.height <= 0) return;
  setChatBrowser({ viewId, rect });
}
