/**
 * Os botões da moldura do celular. No iPhone eles ficam dentro da página (`device_chrome.js`) e chegam pela ponte
 * como mensagens `ags-preview` de tipo `device:*`; no Android ficam no app (PhoneChrome.tsx) e chamam direto.
 * Uma página pode forjar essas mensagens, então só esta lista fechada é aceita, e nenhuma vai além do que a
 * própria página já poderia fazer: navegar, abrir uma aba vazia, copiar o próprio endereço, pedir a versão desktop.
 */
export type DeviceAction =
  | { type: "navigate"; text: string }
  | { type: "tabs" }
  | { type: "share"; url: string }
  | { type: "desktop" };

/** Os handlers que a moldura usa (Android direto; iPhone pela ponte). */
export interface PhoneActions {
  back: () => void;
  reload: () => void;
  navigate: (text: string) => void;
  newTab: () => void;
  share: () => void;
  desktop: () => void;
}

/** A ação de uma mensagem da página, ou `null` se não for da moldura. Pura. */
export function deviceAction(message: unknown): DeviceAction | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m.source !== "ags-preview" || typeof m.type !== "string") return null;
  switch (m.type) {
    case "device:navigate":
      return typeof m.text === "string" && m.text.trim() && m.text.length <= 2048 ? { type: "navigate", text: m.text.trim() } : null;
    case "device:tabs":
      return { type: "tabs" };
    case "device:share":
      return typeof m.url === "string" && /^https?:\/\//i.test(m.url) && m.url.length <= 4096 ? { type: "share", url: m.url } : null;
    case "device:desktop":
      return { type: "desktop" };
    default:
      return null;
  }
}

/** Executa uma ação da página com os handlers do navegador. */
export function runDeviceAction(action: DeviceAction, actions: PhoneActions, copy: (text: string) => void): void {
  if (action.type === "navigate") actions.navigate(action.text);
  else if (action.type === "tabs") actions.newTab();
  else if (action.type === "share") copy(action.url);
  else actions.desktop();
}
