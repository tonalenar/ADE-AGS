import { useEffect, useRef, useState, type ReactNode } from "react";

import { useTranslation } from "react-i18next";

import type { PhoneActions } from "./deviceActions";

/**
 * O que o aparelho desenha em volta da página. A vista nativa do navegador é um retângulo por cima da janela e não
 * aceita nada desenhado sobre ela.
 * - iPhone: a barra de status translúcida, o vidro do Safari e a ilha (no topo, ou na lateral quando deitado) ficam
 *   DENTRO da página (`device_chrome.js`), para o conteúdo passar por baixo deles; a página ocupa a tela toda, em pé e
 *   deitada, e o recorte dos cantos é só da máscara nativa.
 * - Android: a barra de status e a barra do Chrome são opacas no topo, como no Chrome real, e ficam aqui, fora da
 *   página, com os botões funcionando direto pelos handlers do navegador. A página vai até o fim da tela; a alça de
 *   gestos fica por cima dela (`device_chrome.js`), como no Chrome real. Deitado, a faixa do furo da câmera vai de ponta
 *   a ponta na esquerda (o furo fica no meio da altura do aparelho) e a barra do Chrome fica à direita dela.
 */
export type Platform = "ios" | "android";

/** O tamanho, em px de página, das faixas que o aparelho ocupa em volta da página. Pura. */
export function chromeInsets(platform: Platform, landscape: boolean): { top: number; bottom: number; left: number; right: number } {
  if (platform === "ios") {
    return { top: 0, bottom: 0, left: 0, right: 0 };
  }
  return landscape ? { top: 44, bottom: 0, left: 44, right: 0 } : { top: 92, bottom: 0, left: 0, right: 0 };
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

/** Barra de status e barra do Chrome do Android, no topo, com voltar, endereço editável, recarregar, abas e menu. */
function AndroidTop({ time, url, address, landscape, actions }: { time: string; url: string; address: string; landscape: boolean; actions?: PhoneActions }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setMenu(false); };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [menu]);
  useEffect(() => { if (editing !== null) input.current?.select(); }, [editing !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const icon = "flex items-center justify-center rounded-full hover:bg-black/5 active:bg-black/10 dark:hover:bg-white/10 dark:active:bg-white/15";
  return (
    <div ref={root} className="relative shrink-0 bg-white text-gray-900 dark:bg-surface dark:text-gray-100">
      {!landscape && (
        <div className="relative flex items-center justify-between px-6" style={{ height: 36 }}>
          <span style={{ fontSize: 14, fontWeight: 500 }}>{time}</span>
          <span className="absolute left-1/2 -translate-x-1/2 rounded-full bg-black" style={{ top: 11, width: 14, height: 14 }} />
          <span className="flex items-center gap-1.5"><Wifi color="currentColor" /><Signal color="currentColor" /><Battery color="currentColor" percent /></span>
        </div>
      )}
      <div className="flex items-center gap-1.5" style={{ height: landscape ? 44 : 56, paddingLeft: 8, paddingRight: landscape ? 28 : 8 }}>
        <button type="button" aria-label={t("browser.device.back")} className={icon} style={{ width: 36, height: 36 }} onClick={() => actions?.back()}>
          <svg width="20" height="20" viewBox="0 0 20 20" stroke="currentColor" {...stroke} aria-hidden><path d="M12.5 4 6.5 10l6 6" /></svg>
        </button>
        <div className="flex flex-1 min-w-0 items-center gap-2 rounded-full bg-gray-100 dark:bg-surface-raised px-3" style={{ height: 40 }}>
          {editing === null ? (
            <button type="button" className="flex-1 min-w-0 truncate text-left" style={{ fontSize: 15 }} aria-label={t("browser.device.address")}
              onClick={() => setEditing(url)}>{address}</button>
          ) : (
            <input ref={input} autoFocus value={editing} aria-label={t("browser.device.address")} enterKeyHint="go"
              className="flex-1 min-w-0 bg-transparent outline-none" style={{ fontSize: 15 }}
              onChange={(e) => setEditing(e.target.value)}
              onBlur={() => setEditing(null)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && editing.trim()) { actions?.navigate(editing.trim()); setEditing(null); }
                if (e.key === "Escape") setEditing(null);
              }} />
          )}
          <button type="button" aria-label={t("browser.device.reload")} className={icon} style={{ width: 28, height: 28 }} onClick={() => actions?.reload()}>
            <svg width="16" height="16" viewBox="0 0 20 20" stroke="currentColor" {...stroke} strokeWidth={2} aria-hidden><path d="M16 10a6 6 0 1 1-1.8-4.3" /><path d="M15.5 2.5v4h-4" /></svg>
          </button>
        </div>
        <button type="button" aria-label={t("browser.device.tabs")} className={icon} style={{ width: 36, height: 36 }} onClick={() => actions?.newTab()}>
          <span className="flex items-center justify-center rounded-md border-2 border-current" style={{ width: 22, height: 22, fontSize: 11, fontWeight: 700 }}>1</span>
        </button>
        <button type="button" aria-label={t("browser.device.menu")} aria-expanded={menu} className={icon} style={{ width: 36, height: 36 }} onClick={() => setMenu((open) => !open)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
        </button>
      </div>
      {menu && (
        <div data-over-webview role="menu" className="absolute right-2 top-full z-20 mt-1 w-56 rounded-2xl bg-white dark:bg-surface-raised py-2 shadow-xl" style={{ fontSize: 15 }}>
          {([
            ["share", () => actions?.share()],
            ["desktop", () => actions?.desktop()],
            ["reload", () => actions?.reload()],
          ] as const).map(([key, run]) => (
            <button key={key} type="button" role="menuitem" className="block w-full px-4 py-2.5 text-left hover:bg-black/5"
              onClick={() => { setMenu(false); run(); }}>{t(`browser.device.${key}`)}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A página dentro do aparelho: o Chrome do Android em volta e `children` (a vista do navegador) no meio. Sem `platform`,
 * é só um contêiner que ocupa tudo, com a MESMA árvore (a vista nativa não pode remontar ao entrar e sair do modo
 * celular nem ao girar): a faixa do furo é irmã absoluta, e a página só ganha uma folga à esquerda.
 */
export function PhoneChrome({ platform = null, landscape = false, url = "", actions, children }: {
  platform?: Platform | null;
  landscape?: boolean;
  url?: string;
  actions?: PhoneActions;
  children: ReactNode;
}) {
  const time = useClock();
  const address = shownAddress(url);
  const inset = platform ? chromeInsets(platform, landscape) : null;
  const strip = platform === "android" && landscape && inset ? (
    <div data-phone-strip aria-hidden className="absolute left-0 top-0 h-full bg-white dark:bg-surface" style={{ width: inset.left }}>
      <span className="absolute top-1/2 -translate-y-1/2 rounded-full bg-black" style={{ left: 14, width: 15, height: 15 }} />
    </div>
  ) : null;
  return (
    <div className="relative flex flex-col w-full h-full min-h-0" style={{ paddingLeft: inset?.left ?? 0 }}>
      {strip}
      {platform === "android" && <AndroidTop time={time} url={url} address={address} landscape={landscape} actions={actions} />}
      <div className="relative flex flex-col flex-1 min-w-0 min-h-0">{children}</div>
    </div>
  );
}
