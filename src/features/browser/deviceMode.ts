import { useViewTabsStore } from "@/features/tabs/viewStore";
import { clampViewport, FILL_VIEWPORT, isFillViewport, isPhoneViewport, rotate, type Viewport } from "./viewport";

export type DevicePlatform = "ios" | "android" | null;

export interface DeviceModeState {
  viewport: Viewport | null;
  mobile: DevicePlatform;
}

export interface BrowserDeviceActions {
  choosePlatform: (platform: DevicePlatform) => void;
  chooseFull: (full: boolean) => void;
  rotate: () => void;
}

const deviceActions = new Map<string, BrowserDeviceActions>();

/** Tela de partida de cada plataforma (em pé). */
export function startViewportFor(platform: DevicePlatform): Viewport {
  if (platform === "android") return { width: 412, height: 915 };
  if (platform === "ios") return { width: 390, height: 844 };
  return { width: 1440, height: 900 };
}

/** Há uma moldura/quadro explícito quando existe viewport e ele não é o preenchimento (1920×1080). */
export function isFramedViewport(viewport: Viewport | null | undefined): viewport is Viewport {
  return !!viewport && !isFillViewport(viewport);
}

/** Proporção largura/altura a manter na miniatura flutuante; null quando ocupa livremente o cartão. */
export function floatAspectRatioOf(viewport: Viewport | null | undefined): number | null {
  if (!isFramedViewport(viewport) || viewport.width <= 0 || viewport.height <= 0) return null;
  return viewport.width / viewport.height;
}

/** Próximo estado de plataforma e viewport compartilhado entre DeviceBar, BrowserTab e a dock da miniatura. */
export function nextPlatformState(current: DeviceModeState, platform: DevicePlatform): DeviceModeState {
  const framed = isFramedViewport(current.viewport) ? current.viewport : null;
  if (platform === null) {
    return {
      mobile: null,
      viewport: framed ? (isPhoneViewport(framed) ? startViewportFor(null) : framed) : FILL_VIEWPORT,
    };
  }
  if (framed) {
    const landscape = framed.width > framed.height;
    const isStart = [startViewportFor("ios"), startViewportFor("android")].some(
      (d) => (framed.width === d.width && framed.height === d.height) || (framed.width === d.height && framed.height === d.width),
    );
    return {
      mobile: platform,
      viewport: isPhoneViewport(framed) && !isStart
        ? framed
        : (landscape ? rotate(startViewportFor(platform)) : startViewportFor(platform)),
    };
  }
  // No desktop comum (sem modo aparelho ligado), escolher iPhone/Android entra direto na moldura do aparelho.
  if (current.mobile === null && current.viewport === null) {
    return { mobile: platform, viewport: startViewportFor(platform) };
  }
  // No modo Completo (sem moldura), trocar de aparelho mantém o preenchimento com a nova emulação.
  return { mobile: platform, viewport: null };
}

/** Alterna entre Aparelho (quadro do aparelho atual) e Completo (preenche a área disponível). */
export function nextFullState(current: Pick<DeviceModeState, "mobile">, full: boolean): Viewport | null {
  return full ? (current.mobile ? null : FILL_VIEWPORT) : startViewportFor(current.mobile);
}

/** Gira um viewport emoldurado (largura × altura). Retorna null quando está em modo Completo. */
export function nextRotateState(viewport: Viewport | null): Viewport | null {
  if (!isFramedViewport(viewport)) return null;
  return clampViewport(rotate(viewport));
}

export function registerBrowserDeviceActions(viewId: string, actions: BrowserDeviceActions): () => void {
  deviceActions.set(viewId, actions);
  return () => {
    if (deviceActions.get(viewId) === actions) deviceActions.delete(viewId);
  };
}

function readViewState(viewId: string): DeviceModeState {
  const view = useViewTabsStore.getState().views.find((v) => v.id === viewId);
  if (!view || view.kind !== "browser") return { viewport: null, mobile: null };
  return { viewport: view.viewport ?? null, mobile: view.mobile ?? null };
}

export function runBrowserDevicePlatform(viewId: string, platform: DevicePlatform): void {
  const host = deviceActions.get(viewId);
  if (host) {
    host.choosePlatform(platform);
    return;
  }
  const next = nextPlatformState(readViewState(viewId), platform);
  useViewTabsStore.getState().updateView(viewId, { mobile: next.mobile, viewport: next.viewport, touch: next.mobile !== null });
}

export function runBrowserDeviceFull(viewId: string, full: boolean): void {
  const host = deviceActions.get(viewId);
  if (host) {
    host.chooseFull(full);
    return;
  }
  const next = nextFullState(readViewState(viewId), full);
  useViewTabsStore.getState().updateView(viewId, { viewport: next });
}

export function runBrowserDeviceRotate(viewId: string): void {
  const host = deviceActions.get(viewId);
  if (host) {
    host.rotate();
    return;
  }
  const next = nextRotateState(readViewState(viewId).viewport);
  if (next) useViewTabsStore.getState().updateView(viewId, { viewport: next });
}
