import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SIM_BAR_H } from "./geometry";
import type { SimDevice } from "./ipc";

const icon = "w-[15px] h-[15px]";
const button = "nodrag cc-t relative flex items-center justify-center h-7 min-w-7 px-1.5 rounded-full text-white/75 hover:text-white hover:bg-white/12 disabled:opacity-35 disabled:hover:bg-transparent";

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className={icon} aria-hidden>
      {children}
    </svg>
  );
}

const ICONS = {
  home: <Svg><path d="M4 11l8-7 8 7v9H4z" /></Svg>,
  lock: <Svg><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Svg>,
  shot: <Svg><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></Svg>,
  chat: <Svg><path d="M4 5h16v11H9l-5 4z" /></Svg>,
  more: <Svg><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></Svg>,
  light: <Svg><path d="M13 3L5 14h6l-1 7 8-11h-6z" /></Svg>,
  phone: <Svg><rect x="7" y="2.5" width="10" height="19" rx="2.5" /></Svg>,
  pad: <Svg><rect x="4.5" y="3" width="15" height="18" rx="2" /></Svg>,
};

function Dot({ state }: { state: SimDevice["state"] | "error" }) {
  const tone = state === "booted" ? "bg-emerald-400" : state === "booting" ? "bg-amber-400" : state === "error" ? "bg-red-400" : "bg-white/35";
  return <span aria-hidden className={`h-[7px] w-[7px] shrink-0 rounded-full ${tone}`} />;
}

/** Fecha o popover ao clicar fora ou apertar Esc. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("mousedown", down, true); window.removeEventListener("keydown", key, true); };
  }, [open, close]);
  return ref;
}

/** O seletor de aparelho: busca, iPhones e iPads do Xcode, com o estado de cada um. */
function DevicePicker({ devices, current, state, label, onPick, onOpen }: {
  devices: SimDevice[];
  current: SimDevice | undefined;
  state: SimDevice["state"] | "error";
  label: string;
  onPick: (udid: string) => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useDismiss(open, () => setOpen(false));
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return devices.filter((d) => !q || d.name.toLowerCase().includes(q) || d.runtime.toLowerCase().includes(q));
  }, [devices, query]);
  const groups: [string, SimDevice[]][] = [
    [t("simulator.group.iphone"), shown.filter((d) => d.family === "iphone")],
    [t("simulator.group.ipad"), shown.filter((d) => d.family === "ipad")],
  ];
  return (
    <div ref={ref} className="relative min-w-0">
      <button type="button" onClick={() => { if (!open) onOpen(); setOpen(!open); }} title={t("simulator.pick")} aria-haspopup="listbox" aria-expanded={open}
        className="nodrag cc-t flex h-7 min-w-0 max-w-full items-center gap-2 rounded-full bg-white/8 pl-2.5 pr-2 text-[11.5px] text-white hover:bg-white/12">
        <Dot state={state} />
        <span className="truncate">{label}</span>
        <span aria-hidden className="text-[9px] opacity-50">▼</span>
      </button>
      {open && (
        <div role="listbox" aria-label={t("simulator.pick")}
          className="nodrag nowheel absolute left-0 top-9 z-50 w-72 max-h-[420px] overflow-y-auto rounded-xl p-1.5 text-[12.5px]
            bg-surface-raised/97 ring-1 ring-white/10 shadow-[0_18px_50px_rgba(0,0,0,0.5)]">
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("simulator.search")}
            className="mb-1 h-7 w-full rounded-md border border-white/8 bg-black/25 px-2.5 text-[12px] text-white outline-none placeholder:text-white/40" />
          {groups.filter(([, list]) => list.length > 0).map(([title, list]) => (
            <div key={title}>
              <div className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-white/45">{title}</div>
              {list.map((d) => (
                <button key={d.udid} type="button" role="option" aria-selected={d.udid === current?.udid}
                  onClick={() => { onPick(d.udid); setOpen(false); }}
                  className={`cc-t flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-left
                    ${d.udid === current?.udid ? "bg-accent-600 text-white" : "text-white/90 hover:bg-white/8"}`}>
                  {d.family === "ipad" ? ICONS.pad : ICONS.phone}
                  <span className="truncate">{d.name}</span>
                  {d.state === "booted" && <span className="rounded-full bg-emerald-400/15 px-1.5 text-[10.5px] text-emerald-300">{t("simulator.state.booted")}</span>}
                  <span className="ml-auto shrink-0 text-[11px] text-white/45">{d.runtime}</span>
                </button>
              ))}
            </div>
          ))}
          {devices.length === 0 && <div className="px-2.5 py-2 text-[11.5px] text-white/55">{t("simulator.noDevices")}</div>}
          <div className="mx-1.5 my-1 h-px bg-white/8" />
          <div className="px-2.5 py-1 text-[11px] leading-snug text-white/45">{t("simulator.fromXcode")}</div>
        </div>
      )}
    </div>
  );
}

export interface SimBarActions {
  onPick: (udid: string) => void;
  onOpenPicker: () => void;
  onButton: (name: "home" | "lock") => void;
  onShot: () => void;
  onChat: () => void;
  onScale: (direction: 1 | -1) => void;
  onLight: () => void;
  onShutdown: () => void;
  onClose: () => void;
}

/**
 * A barra que flutua acima do simulador solto. Ela é a alça de arrastar o nó (`ade-node-drag`); os controles não
 * arrastam (`nodrag`). `full` = a conversa está aberta e a barra cobre o bloco inteiro (aparelho + conversa);
 * compacta, ela tem a largura do aparelho e o zoom, o modo leve, desligar e fechar vão para o "⋯".
 */
export function SimulatorBar({ full, devices, current, state, scale, light, agents, chatOpen, closeArmed, actions }: {
  full: boolean;
  devices: SimDevice[];
  current: SimDevice | undefined;
  state: SimDevice["state"] | "error";
  scale: number;
  light: boolean;
  agents: number;
  chatOpen: boolean;
  closeArmed: boolean;
  actions: SimBarActions;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState(false);
  const menuRef = useDismiss(menu, () => setMenu(false));
  const on = state === "booted";
  const label = current ? (full ? current.name : current.name.replace(/^iPhone |^iPad /, "")) : t("simulator.pick");

  const zoom = (
    <>
      <button type="button" className={button} onClick={() => actions.onScale(-1)} title={t("simulator.smaller")} aria-label={t("simulator.smaller")}>−</button>
      <span className="w-9 text-center font-mono text-[10.5px] tabular-nums text-white/55">{Math.round(scale * 100)}%</span>
      <button type="button" className={button} onClick={() => actions.onScale(1)} title={t("simulator.bigger")} aria-label={t("simulator.bigger")}>+</button>
    </>
  );
  const lightButton = (
    <button type="button" className={`${button} ${light ? "bg-amber-400/20 text-amber-300 hover:bg-amber-400/30 hover:text-amber-200" : ""}`} onClick={actions.onLight} title={t("simulator.light")} aria-label={t("simulator.light")} aria-pressed={light}>
      {ICONS.light}
    </button>
  );

  return (
    // `relative z-20`: o desfoque cria um contexto de empilhamento; sem subir a barra, os menus dela abririam atrás
    // do aparelho e da conversa.
    <div className="ade-node-drag relative z-20 flex w-full items-center gap-0.5 rounded-full pl-1.5 pr-1 cursor-grab active:cursor-grabbing
      bg-surface/92 backdrop-blur-md ring-1 ring-white/10 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.6)] ade-device-bar-in"
      style={{ height: SIM_BAR_H }}>
      <DevicePicker devices={devices} current={current} state={state} label={label} onPick={actions.onPick} onOpen={actions.onOpenPicker} />
      {full ? <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-white/12" /> : <span className="flex-1" />}
      <button type="button" className={button} disabled={!on} onClick={() => actions.onButton("home")} title={t("simulator.home")} aria-label={t("simulator.home")}>{ICONS.home}</button>
      <button type="button" className={button} disabled={!on} onClick={() => actions.onButton("lock")} title={t("simulator.lock")} aria-label={t("simulator.lock")}>{ICONS.lock}</button>
      <button type="button" className={button} disabled={!on} onClick={actions.onShot} title={t("simulator.shot")} aria-label={t("simulator.shot")}>{ICONS.shot}</button>
      {full && (
        <>
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-white/12" />
          {zoom}
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-white/12" />
          {lightButton}
          <span className="flex-1" />
        </>
      )}
      <button type="button" className={`${button} ${chatOpen ? "bg-accent-500/25 text-accent-100" : ""}`} onClick={actions.onChat}
        title={t("simulator.chat.toggle")} aria-label={t("simulator.chat.toggle")} aria-pressed={chatOpen}>
        {ICONS.chat}
        {agents > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-accent-600 px-1 text-[9.5px] font-bold text-white">{agents}</span>
        )}
      </button>
      <div ref={menuRef} className="relative">
        <button type="button" className={`${button} ${closeArmed ? "bg-red-500 text-white hover:bg-red-600" : ""}`} onClick={() => setMenu(!menu)}
          title={t("simulator.more")} aria-label={t("simulator.more")} aria-haspopup="menu" aria-expanded={menu}>
          {ICONS.more}
        </button>
        {menu && (
          <div role="menu" className="nodrag absolute right-0 top-9 z-50 w-60 rounded-xl p-1.5 text-[12.5px]
            bg-surface-raised/97 ring-1 ring-white/10 shadow-[0_18px_50px_rgba(0,0,0,0.5)]">
            {!full && (
              <div className="flex items-center gap-1 px-1.5 py-1 text-white/80">
                <span className="mr-auto text-[12px]">{t("simulator.zoom")}</span>
                {zoom}
              </div>
            )}
            {!full && (
              <button type="button" role="menuitemcheckbox" aria-checked={light} onClick={actions.onLight}
                className="cc-t flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-white/90 hover:bg-white/8">
                {ICONS.light}<span className="flex-1">{t("simulator.lightShort")}</span>{light && <span aria-hidden>✓</span>}
              </button>
            )}
            <button type="button" role="menuitem" disabled={!on} onClick={() => { setMenu(false); actions.onShutdown(); }}
              className="cc-t flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-white/90 hover:bg-white/8 disabled:opacity-40">
              {t("simulator.shutdown")}
            </button>
            <div className="mx-1.5 my-1 h-px bg-white/8" />
            <button type="button" role="menuitem" onClick={actions.onClose}
              className={`cc-t flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-left hover:bg-white/8 ${closeArmed ? "text-red-300" : "text-white/90"}`}>
              {closeArmed ? t("simulator.closeConfirm") : t("simulator.close")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
