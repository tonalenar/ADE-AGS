import type { ReactNode } from "react";

/**
 * A tela do aparelho. A barra de status (hora, rede, bateria, ilha ou câmera) e o navegador do sistema (Safari do
 * iOS 26 com a barra de vidro flutuante, Chrome do Android) são desenhados DENTRO da página pelo backend
 * (`real_browser_emulate`), porque a vista nativa fica por cima do DOM e nada daqui a cobriria. Assim a página passa
 * por baixo das barras, como num aparelho de verdade. Aqui a página ocupa a tela inteira.
 */
export type Platform = "ios" | "android";

/** O endereço como o navegador do aparelho o mostra: sem protocolo nem `www.`. Pura. */
export function shownAddress(url: string): string {
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, "") || url;
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/^www\./, "");
  }
}

export function PhoneChrome({ children }: { platform?: Platform | null; landscape?: boolean; url?: string; children: ReactNode }) {
  return <div className="relative flex flex-col w-full h-full min-h-0 min-w-0">{children}</div>;
}
