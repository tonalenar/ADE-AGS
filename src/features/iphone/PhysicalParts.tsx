import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { NativeScreen, type NativeScreenApi } from "@/features/simulator/SimulatorScreen";

import { ConnectHint, type Tone } from "./ConnectHint";
import { iphoneMirrorAttach, iphoneMirrorDetach, iphoneMirrorPlace } from "./ipc";
import { deviceHint, isReady, statusView, type MirrorStatus, type PhysicalDevice } from "./model";
import { useIphoneStore } from "./store";

const MIRROR_API: NativeScreenApi = { attach: iphoneMirrorAttach, place: iphoneMirrorPlace, detach: iphoneMirrorDetach };

function Glyph({ family, className }: { family: "iphone" | "ipad"; className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {family === "ipad" ? <rect x="4.5" y="3" width="15" height="18" rx="2" /> : <rect x="7" y="2.5" width="10" height="19" rx="2.5" />}
    </svg>
  );
}

const SECTION: Record<Tone, { title: string; item: string; picked: string; meta: string; hint: string; badge: string; note: string }> = {
  dark: {
    title: "px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-white/45",
    item: "text-white/90 hover:bg-white/8",
    picked: "bg-accent-600 text-white",
    meta: "text-white/45",
    hint: "text-amber-300/90",
    badge: "bg-white/10 text-white/75",
    note: "px-2.5 py-2 text-[11.5px] leading-snug text-white/55",
  },
  panel: {
    title: "px-2 pt-1 pb-1.5 text-chat-caption font-medium text-gray-500 dark:text-white/50",
    item: "text-gray-800 dark:text-white/85 hover:bg-gray-100 dark:hover:bg-white/[0.07]",
    picked: "bg-gray-100 dark:bg-white/[0.08] text-gray-900 dark:text-white",
    meta: "text-gray-400 dark:text-white/40",
    hint: "text-amber-700 dark:text-amber-300",
    badge: "bg-gray-100 dark:bg-white/[0.08] text-gray-600 dark:text-white/70",
    note: "m-0 px-2 py-2 text-chat-note leading-snug text-gray-500 dark:text-white/50",
  },
};

/** A etiqueta "USB" ou "Wi-Fi" de um aparelho com caminho. */
export function TransportBadge({ transport, tone }: { transport: PhysicalDevice["transport"]; tone: Tone }) {
  const { t } = useTranslation();
  if (transport === "none") return null;
  return <span className={`shrink-0 rounded-full px-1.5 text-[10.5px] font-medium leading-[16px] ${SECTION[tone].badge}`}>{t(`iphone.transport.${transport}`)}</span>;
}

/**
 * A seção "Aparelhos" do seletor: os iPhones e iPads físicos que o CoreDevice conhece, com USB ou Wi-Fi, o modelo e
 * o iOS. Os que não estão prontos aparecem apagados, com o que falta. Sem nenhum pronto, o estado vazio animado.
 */
export function PhysicalSection({ tone, current, onPick }: { tone: Tone; current: string | null | undefined; onPick: (device: PhysicalDevice) => void }) {
  const { t } = useTranslation();
  const devices = useIphoneStore((s) => s.devices);
  const loaded = useIphoneStore((s) => s.loaded);
  const unavailable = useIphoneStore((s) => s.unavailable);
  const c = SECTION[tone];
  const ready = devices.filter(isReady);
  return (
    <div role="group" aria-label={t("iphone.section.devices")} className="whitespace-normal">
      <div className={c.title}>{t("iphone.section.devices")}</div>
      {unavailable === "platform" || (unavailable === "xcode" && devices.length === 0) ? (
        <p className={c.note}>{t(`iphone.unavailable.${unavailable}`)}</p>
      ) : (
        <>
          {devices.map((d) => {
            const hint = deviceHint(d);
            const picked = d.id === current;
            return (
              <button key={d.id} type="button" role="option" aria-selected={picked} disabled={hint !== null} onClick={() => onPick(d)}
                title={hint ? t(`iphone.hint.${hint}`) : undefined}
                className={`cc-t flex min-h-[34px] w-full items-center gap-2.5 rounded-md px-2.5 py-1 text-left disabled:opacity-60 disabled:hover:bg-transparent ${picked ? c.picked : c.item}`}>
                <Glyph family={d.family} className="h-[15px] w-[15px] shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{d.name}</span>
                  <span className={`truncate text-[11px] ${hint ? c.hint : picked && tone === "dark" ? "text-white/75" : c.meta}`}>
                    {hint ? t(`iphone.hint.${hint}`) : `${d.model} · ${t("iphone.os", { version: d.os })}`}
                  </span>
                </span>
                <TransportBadge transport={d.transport} tone={tone} />
              </button>
            );
          })}
          {unavailable === "helper" && <p className={c.note}>{t("iphone.unavailable.helper")}</p>}
          {ready.length === 0 && (loaded ? <ConnectHint tone={tone} compact /> : <p className={c.note}>{t("iphone.empty.searching")}</p>)}
        </>
      )}
    </div>
  );
}

const DOT: Record<"ok" | "wait" | "off", string> = {
  ok: "bg-emerald-500 dark:bg-emerald-400",
  wait: "bg-amber-400",
  off: "bg-gray-400 dark:bg-white/35",
};

/** A linha de estado: "Ligado · Wi-Fi", "Reconectando… · USB", "Sem conexão". */
export function MirrorStatusLine({ status, className = "" }: { status: MirrorStatus | undefined; className?: string }) {
  const { t } = useTranslation();
  const view = statusView(status);
  const text = view.transport ? `${t(view.key)} · ${t(view.transport)}` : t(view.key);
  return (
    <span role="status" className={`inline-flex min-w-0 items-center gap-1.5 ${className}`} title={status?.error ?? text}>
      <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${DOT[view.tone]} ${view.tone === "wait" ? "animate-pulse motion-reduce:animate-none" : ""}`} />
      <span className="truncate">{text}</span>
      {status?.state === "live" && status.fps != null && (
        <span aria-live="off" className="shrink-0 tabular-nums">{t("iphone.status.fps", { count: status.fps })}</span>
      )}
    </span>
  );
}

/**
 * A tela espelhada dentro da moldura: a view nativa por cima do webview (a mesma medição da tela do simulador),
 * com o estado por baixo. A view fica transparente até o primeiro quadro e quando a conexão some, então o texto
 * daqui aparece nessas horas; ligado, o vídeo cobre tudo. Só ver: o clique na tela não vai para o aparelho.
 */
export function PhysicalMirror({ screenId, device, known, status, radius, onError, pausedAction, engaged = true, showStatus = true }: {
  screenId: string;
  device: string;
  /** O aparelho está na lista do CoreDevice agora. */
  known: boolean;
  status: MirrorStatus | undefined;
  radius: number;
  onError: (message: string) => void;
  pausedAction?: ReactNode;
  /** A superfície está aberta. Fechada, a view fica no lugar e o espelho não começa. */
  engaged?: boolean;
  /** O painel lateral exibe o estado na barra única, sem duplicá-lo sobre a tela. */
  showStatus?: boolean;
}) {
  const { t } = useTranslation();
  const disconnected = useIphoneStore((s) => s.disconnectedDevices.includes(device));
  const state = status?.state ?? "connecting";
  // Todos os hooks antes do retorno do aparelho desconectado: a ordem não pode mudar entre renders.
  const [resumeAttempt, setResumeAttempt] = useState(0);
  const [resumePending, setResumePending] = useState(false);
  useEffect(() => {
    if (state !== "paused") setResumePending(false);
  }, [state]);
  if (disconnected) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black px-6 text-center">
        {showStatus && <p className="m-0 max-w-[28ch] text-[12.5px] leading-relaxed text-white/70">{t("iphone.session.paused")}</p>}
        {pausedAction}
      </div>
    );
  }
  const note = !known && state !== "live" ? t("iphone.screen.notFound") : t(`iphone.screen.${state}`);
  const activeScreenId = resumeAttempt === 0 ? screenId : `${screenId}:resume:${resumeAttempt}`;

  return (
    <>
      {showStatus && <div data-over-webview={state === "paused" ? "" : undefined} className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-5 text-center">
        {state === "paused" ? (
          <>
            <span className="max-w-[280px] text-[12.5px] leading-snug text-white/75">{t("iphone.screen.pausedBody")}</span>
            <button type="button" disabled={resumePending} onClick={() => { setResumePending(true); setResumeAttempt((attempt) => attempt + 1); }}
              className="rounded-lg bg-white/12 px-3 py-1.5 text-[11.5px] font-medium text-white hover:bg-white/20 disabled:opacity-60">
              {t(resumePending ? "iphone.screen.resuming" : "iphone.screen.resume")}
            </button>
          </>
        ) : (
          <span className="text-[12.5px] leading-snug text-white/70">{note}</span>
        )}
        {status?.error && state !== "live" && state !== "paused" && <span className="line-clamp-3 text-[11px] leading-snug text-white/45">{status.error}</span>}
      </div>}
      <NativeScreen key={activeScreenId} api={MIRROR_API} screenId={activeScreenId} target={device} radius={radius} onError={onError} engaged={engaged} />
    </>
  );
}
