import { useEffect, useState, type ReactNode } from "react";

/**
 * O que o aparelho desenha em volta da página. A vista nativa do navegador é um retângulo por cima da janela e não
 * aceita nada desenhado sobre ela, então a parte OPACA do topo fica aqui, fora dela: a barra de status (hora, rede,
 * bateria, ilha ou câmera) e, no Android, a barra do Chrome. A página começa abaixo dela, como num aparelho de verdade
 * (um `position: fixed; top: 0` do site fica logo abaixo da barra de status). A barra de vidro flutuante do Safari do
 * iOS 26 é desenhada DENTRO da página pelo backend (`device_chrome.js`), para o conteúdo passar por baixo dela.
 */
export type Platform = "ios" | "android";

/** O tamanho, em px de página, das faixas que o aparelho ocupa em volta da página. Pura. */
export function chromeInsets(platform: Platform, landscape: boolean): { top: number; bottom: number; left: number; right: number } {
  if (platform === "ios") {
    return landscape ? { top: 0, bottom: 0, left: 47, right: 47 } : { top: 54, bottom: 0, left: 0, right: 0 };
  }
  return landscape ? { top: 44, bottom: 0, left: 36, right: 0 } : { top: 92, bottom: 30, left: 0, right: 0 };
}

/** O endereço como o navegador do aparelho o mostra: sem protocolo nem `www.`. Pura. */
export function shownAddress(url: string): string {
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, "") || url;
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/^www\./, "");
  }
}

/** A hora do relógio do aparelho (H:MM), atualizada a cada meio minuto. */
function useClock(): string {
  const read = () => {
    const now = new Date();
    return `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
  };
  const [time, setTime] = useState(read);
  useEffect(() => {
    const timer = setInterval(() => setTime(read()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return time;
}

function Signal({ color }: { color: string }) {
  return (
    <svg width="18" height="12" viewBox="0 0 18 12" fill={color} aria-hidden>
      <rect x="0" y="8" width="3" height="4" rx="0.8" /><rect x="5" y="5.5" width="3" height="6.5" rx="0.8" />
      <rect x="10" y="3" width="3" height="9" rx="0.8" /><rect x="15" y="0" width="3" height="12" rx="0.8" />
    </svg>
  );
}

function Wifi({ color }: { color: string }) {
  return (
    <svg width="17" height="12" viewBox="0 0 17 12" fill="none" stroke={color} strokeWidth="1.9" strokeLinecap="round" aria-hidden>
      <path d="M1.2 4.2a10 10 0 0 1 14.6 0" /><path d="M3.9 7a6.2 6.2 0 0 1 9.2 0" />
      <circle cx="8.5" cy="10" r="1.1" fill={color} stroke="none" />
    </svg>
  );
}

function Battery({ color, percent }: { color: string; percent?: boolean }) {
  return (
    <span className="flex items-center gap-1" style={{ color }}>
      {percent && <span style={{ fontSize: 12, fontWeight: 600 }}>87%</span>}
      <svg width="27" height="13" viewBox="0 0 27 13" fill="none" aria-hidden>
        <rect x="0.5" y="0.5" width="23" height="12" rx="3.6" stroke={color} opacity="0.4" />
        <rect x="2" y="2" width="17" height="9" rx="2.2" fill={color} />
        <path d="M25 4.5v4c.9-.3 1.5-1.2 1.5-2s-.6-1.7-1.5-2Z" fill={color} opacity="0.45" />
      </svg>
    </span>
  );
}

const stroke = { fill: "none", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** A barra de status do iPhone: hora à esquerda da ilha, rede e bateria à direita. */
function IosStatusBar({ time, landscape }: { time: string; landscape: boolean }) {
  if (landscape) return null;
  return (
    <div className="relative shrink-0 flex items-end justify-between px-8 pb-2 bg-white text-black" style={{ height: 54 }}>
      <span className="w-[100px] text-center" style={{ fontSize: 17, fontWeight: 600, letterSpacing: -0.3 }}>{time}</span>
      <span className="absolute left-1/2 -translate-x-1/2 rounded-full bg-black" style={{ top: 11, width: 118, height: 34 }} />
      <span className="flex w-[100px] items-center justify-center gap-1.5">
        <Signal color="#000" /><Wifi color="#000" /><Battery color="#000" />
      </span>
    </div>
  );
}

/** Barra de status e endereço do Chrome do Android, no topo. */
function AndroidTop({ time, address, landscape }: { time: string; address: string; landscape: boolean }) {
  return (
    <div className="shrink-0 bg-white text-[#1f1f1f]">
      {!landscape && (
        <div className="relative flex items-center justify-between px-6" style={{ height: 36 }}>
          <span style={{ fontSize: 14, fontWeight: 500 }}>{time}</span>
          <span className="absolute left-1/2 -translate-x-1/2 rounded-full bg-black" style={{ top: 11, width: 14, height: 14 }} />
          <span className="flex items-center gap-1.5"><Wifi color="#1f1f1f" /><Signal color="#1f1f1f" /><Battery color="#1f1f1f" percent /></span>
        </div>
      )}
      <div className="flex items-center gap-2 px-3" style={{ height: landscape ? 44 : 56 }}>
        <div className="flex flex-1 items-center gap-2 rounded-full bg-[#eef0f6] px-3" style={{ height: 40 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" stroke="#444" {...stroke} aria-hidden><path d="M4 8h10M18 8h2M4 16h2M10 16h10" /><circle cx="16" cy="8" r="2" /><circle cx="8" cy="16" r="2" /></svg>
          <span className="flex-1 truncate" style={{ fontSize: 15 }}>{address}</span>
        </div>
        <span className="flex items-center justify-center rounded-md border-2 border-[#444]" style={{ width: 22, height: 22, fontSize: 11, fontWeight: 700 }}>1</span>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="#444" aria-hidden><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
      </div>
    </div>
  );
}

/**
 * A página dentro do aparelho: faixas em volta e `children` (a vista do navegador) no meio. Sem `platform`, é só um
 * contêiner que ocupa tudo, com a MESMA árvore (a vista nativa não pode remontar ao entrar e sair do modo celular).
 */
export function PhoneChrome({ platform = null, landscape = false, url = "", children }: {
  platform?: Platform | null;
  landscape?: boolean;
  url?: string;
  children: ReactNode;
}) {
  const time = useClock();
  const address = shownAddress(url);
  const inset = platform ? chromeInsets(platform, landscape) : null;
  const side = (width: number, island: "ios" | "android" | null, left: boolean) => width > 0 ? (
    <div className={`relative shrink-0 ${"bg-white"}`} style={{ width }}>
      {island && left && (island === "ios"
        ? <span className="absolute top-1/2 -translate-y-1/2 rounded-full bg-black" style={{ left: 12, width: 34, height: 118 }} />
        : <span className="absolute top-1/2 -translate-y-1/2 rounded-full bg-black" style={{ left: 11, width: 14, height: 14 }} />)}
    </div>
  ) : null;
  return (
    <div className="flex flex-col w-full h-full min-h-0">
      {platform === "ios" && <IosStatusBar time={time} landscape={landscape} />}
      {platform === "android" && <AndroidTop time={time} address={address} landscape={landscape} />}
      <div className="flex flex-1 min-h-0 min-w-0">
        {side(inset?.left ?? 0, platform, true)}
        <div className="relative flex flex-col flex-1 min-w-0 min-h-0">{children}</div>
        {side(inset?.right ?? 0, null, false)}
      </div>
      {platform === "android" && !landscape && (
        <div className="relative shrink-0 bg-white" style={{ height: 30 }}>
          <span className="absolute left-1/2 -translate-x-1/2 rounded-full bg-black/80" style={{ bottom: 9, width: 108, height: 4 }} />
        </div>
      )}
    </div>
  );
}
