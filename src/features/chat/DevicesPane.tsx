import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

import { toDevicePoint } from "@/features/canvas/DeviceNode";
import { AlertaToast } from "@/shared/ui/alerts";
import { DEFAULT_SCREEN } from "@/features/simulator/geometry";
import { simulatorBoot, simulatorButton, simulatorOpenUrl, simulatorPriority, simulatorScreenshot, simulatorShutdown, type SimDevice } from "@/features/simulator/ipc";
import { useSimulatorPrefs } from "@/features/simulator/prefs";
import { SimulatorScreen } from "@/features/simulator/SimulatorScreen";
import { refreshDevices, setDeviceState, useSimulatorStore } from "@/features/simulator/store";
import { ChatSwitch } from "@/features/settings/SettingsSection";

import {
  BackTriangleIcon, CameraIcon, CheckIcon, ChevronDownIcon, CircleIcon, ContrastIcon, FaceIdIcon, HomeIcon, KeyboardIcon,
  LogIcon, MoreVerticalIcon, PhoneIcon, PinIcon, RotateIcon, SquareIcon, VolumeIcon,
} from "./chatIcons";
import { mentionFor } from "./ChatComposer";
import {
  androidInfo, androidLogcat, androidRotate, androidScreenshot, simulatorAppearance, simulatorBiometric, simulatorForegroundApp,
  simulatorLocation, simulatorOrientation, simulatorRelaunch, simulatorRotate, simulatorType,
} from "./devicesIpc";
import { androidLabel, deviceFrame, iosLabel, LOCATION_PRESETS, parseCoord, type AndroidInfo, type Size } from "./devicesModel";
import { insertIntoComposer, setDeviceControl, setPanelDevice, useChatStore } from "./store";
import { usePopover } from "./usePopover";

/*
 * As abas de aparelho do painel direito (pranchetas 9 e 10): o simulador iOS e o Android ao lado da
 * conversa, os mesmos do canvas. Em cima, o aparelho e o estado; no meio, o aparelho numa moldura com
 * os controles à direita; embaixo, a chave que libera os agentes (`ags device`). O iOS é a tela nativa
 * (`SimulatorScreen`, sem copiar quadros); o Android, quadros do `adb` com toque e deslizar.
 */

const toolbarCls = "h-12 shrink-0 flex items-center gap-2 px-3 border-b border-gray-200 dark:border-white/[0.08] text-chat-note";
const ctlCls = "hover:bg-gray-100 dark:hover:bg-white/[0.06] hover:text-gray-900 dark:hover:text-white";
const ibCls = `w-8 h-8 inline-flex items-center justify-center rounded-lg text-gray-500 dark:text-white/50 ${ctlCls} disabled:opacity-40 disabled:pointer-events-none`;
const popCls = "absolute z-50 rounded-xl p-1.5 text-chat-note bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)]";
const itemCls = "w-full h-8 px-2 rounded-md flex items-center gap-2 text-left text-gray-800 dark:text-white/85 hover:bg-gray-100 dark:hover:bg-white/[0.07] disabled:opacity-40";
const fieldCls = "h-8 min-w-0 px-2.5 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/[0.04] text-chat-note text-gray-900 dark:text-white outline-none focus:border-accent-500";
const okCls = "text-emerald-700 dark:text-emerald-400";

/** O tamanho de um elemento, acompanhado. */
function useBoxSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

/**
 * Onde o painelzinho de um botão da coluna se encosta: os botões de cima abrem para baixo (`top-0`), mas o
 * «mais» fica no pé da coluna e, abrindo para baixo, o menu (Desligar, Abrir URL…) saía da janela e não dava para
 * clicar. Esse (`anchor = "bottom"`) abre para cima. A altura se limita à janela e rola por dentro.
 */
export function popPlacementCls(anchor: "top" | "bottom", wide: boolean): string {
  return `right-full ${anchor === "bottom" ? "bottom-0" : "top-0"} mr-2 max-h-[calc(100vh-96px)] overflow-y-auto cc-scroll-hidden ${wide ? "w-[440px]" : "w-[260px]"}`;
}

/** Um botão da coluna de controles; com `pop`, abre o painelzinho dele à esquerda. */
function NavButton({ label, onClick, disabled, children, pop, wide = false, anchor = "top" }: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  pop?: (close: () => void) => React.ReactNode;
  wide?: boolean;
  anchor?: "top" | "bottom";
}) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label={label} title={label} disabled={disabled} aria-expanded={pop ? open : undefined}
        onClick={() => (pop ? setOpen(!open) : onClick?.())} className={`${ibCls} ${open ? "bg-gray-100 dark:bg-white/[0.06] text-gray-900 dark:text-white" : ""}`}>
        {children}
      </button>
      {pop && open && (
        <div role="dialog" aria-label={label} className={`${popCls} ${popPlacementCls(anchor, wide)}`}>
          {pop(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function PopTitle({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pt-1 pb-1.5 text-chat-caption font-medium text-gray-500 dark:text-white/50">{children}</div>;
}

/** A coluna de controles (52 px) à direita do aparelho. */
function DeviceNav({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <nav aria-label={label} className="w-[52px] shrink-0 flex flex-col items-center gap-1 py-3 border-l border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-deep">
      {children}
    </nav>
  );
}

/** O rodapé com a chave dos agentes: desligada, o agente só vê (`shot`/`tree`). */
function AgentControlFooter({ hint }: { hint: "ios" | "android" }) {
  const { t } = useTranslation();
  const on = useChatStore((s) => s.deviceControl);
  return (
    <div className="shrink-0 flex items-center gap-3 px-3.5 py-2.5 border-t border-gray-200 dark:border-white/[0.08] text-chat-note">
      <div className="flex-1 min-w-0">
        <b className="font-medium text-gray-900 dark:text-white">{t("chat.devices.agentControl")}</b>
        <div className="text-chat-caption text-gray-500 dark:text-white/50">
          {t(`chat.devices.agentHint.${hint}.before`)}<span className="font-mono">ags device</span>{t(`chat.devices.agentHint.${hint}.after`)}
        </div>
      </div>
      <ChatSwitch label={t("chat.devices.agentControl")} checked={on} onChange={setDeviceControl} />
    </div>
  );
}

/** Manda a captura para o composer da conversa aberta, como `@caminho`. */
function sendShotToChat(path: string, t: (k: string) => string) {
  insertIntoComposer(mentionFor(null, path));
  void AlertaToast(t("chat.devices.shot"), t("chat.devices.shotSent"), "success", 2500);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// iOS (prancheta 9)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** De quanto em quanto tempo o painel relê qual app está aberto no aparelho (não há aviso do iOS). */
const APP_EVERY_MS = 5000;

export function IosPane() {
  const { t } = useTranslation();
  const devices = useSimulatorStore((s) => s.devices);
  const loaded = useSimulatorStore((s) => s.loaded);
  const error = useSimulatorStore((s) => s.error);
  const light = useSimulatorPrefs((s) => s.light);
  const picked = useChatStore((s) => s.devices.ios);
  const [booting, setBooting] = useState(false);
  const [bundle, setBundle] = useState<string | null>(null);
  const [landscape, setLandscape] = useState(false);
  const [dark, setDark] = useState<boolean | null>(null);
  const { ref, size } = useBoxSize();
  useEffect(() => { void refreshDevices(); }, []);

  const current = devices.find((d) => d.udid === picked) ?? devices.find((d) => d.state === "booted") ?? devices[0] ?? null;
  const udid = current?.udid ?? null;
  const booted = current?.state === "booted" && !booting;
  useEffect(() => { setPanelDevice("ios", udid, current?.name ?? null); }, [udid, current?.name]);

  const fail = useCallback((e: unknown) => { void AlertaToast(current?.name ?? t("chat.panel.ios"), String(e), "error", 5000); }, [current?.name, t]);

  // O app aberto (para "Reabrir app") e a aparência, relidos enquanto o aparelho está ligado.
  useEffect(() => {
    setBundle(null);
    setDark(null);
    setLandscape(false);
    if (!booted || !udid) return;
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      simulatorForegroundApp(udid).then((b) => alive && setBundle(b)).catch(() => undefined);
    };
    load();
    simulatorAppearance(udid).then((a) => alive && setDark(a === "dark")).catch(() => undefined);
    simulatorOrientation(udid).then((o) => alive && setLandscape(o.startsWith("landscape"))).catch(() => undefined);
    const timer = window.setInterval(load, APP_EVERY_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [booted, udid]);

  const boot = async () => {
    if (!current) return;
    setBooting(true);
    try {
      await simulatorBoot(current.udid, light);
      setDeviceState(current.udid, "booted");
    } catch (e) {
      fail(e);
    } finally {
      setBooting(false);
    }
  };
  const run = (job: Promise<unknown>) => { job.catch(fail); };

  const screen: Size = current && current.width > 0 ? { w: current.width, h: current.height } : { w: DEFAULT_SCREEN.width, h: DEFAULT_SCREEN.height };
  const shown = landscape ? { w: screen.h, h: screen.w } : screen;
  const frame = deviceFrame(current?.family === "ipad" ? "ipad" : "ios", shown, { w: size.w - 40, h: size.h - 40 });

  return (
    <div className="h-full flex flex-col">
      <div className={toolbarCls}>
        <IosPicker devices={devices} current={current} loaded={loaded} />
        {current && (
          <span className={booted ? okCls : "text-gray-500 dark:text-white/50"}>
            ● {booting ? t("simulator.booting") : booted ? t("chat.devices.on") : t("chat.devices.off")}
          </span>
        )}
        <span className="flex-1" />
        {booted && bundle && <span className="font-mono text-chat-code text-gray-500 dark:text-white/50 truncate" title={bundle}>{bundle}</span>}
        <button type="button" disabled={!booted || !bundle} onClick={() => udid && bundle && run(simulatorRelaunch(udid, bundle))}
          className={`h-7 px-2.5 rounded-[7px] text-chat-note border border-gray-200 dark:border-white/10 text-gray-800 dark:text-white/85 ${ctlCls} disabled:opacity-40 disabled:pointer-events-none`}>
          {t("chat.devices.relaunch")}
        </button>
      </div>

      <div className="flex-1 min-h-0 flex bg-gray-100 dark:bg-white/[0.02]">
        <div ref={ref} className="flex-1 min-w-0 flex items-center justify-center p-5">
          {error ? <p className="text-chat-note text-gray-500 dark:text-white/45">{error}</p> : !current ? (
            <p className="max-w-[260px] text-center text-chat-note text-gray-500 dark:text-white/45">{loaded ? t("chat.devices.noIos") : t("chat.panel.loading")}</p>
          ) : frame.outerW > 0 && (
            <div className="shrink-0 box-border bg-gray-900 shadow-[0_0_0_2px_rgba(58,58,60,1),0_24px_48px_-20px_rgba(0,0,0,0.45)]"
              style={{ width: frame.outerW, height: frame.outerH, padding: frame.pad, borderRadius: frame.outerRadius }}>
              <div className="relative h-full w-full overflow-hidden bg-gray-100 dark:bg-black" style={{ borderRadius: frame.screenRadius }}>
                {booted ? (
                  <SimulatorScreen screenId="chat-devices" udid={current.udid} radius={frame.screenRadius} onError={fail} />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2.5 px-5 text-center">
                    <span className="text-chat-heading font-semibold text-gray-900 dark:text-white">{current.name}</span>
                    <span className="text-chat-caption leading-snug text-gray-500 dark:text-white/50">
                      {booting ? t("simulator.booting") : `${current.runtime} · ${t("simulator.offHint")}`}
                    </span>
                    {!booting && (
                      <button type="button" onClick={() => void boot()}
                        className="h-8 rounded-lg bg-accent-600 px-4 text-chat-note font-medium text-white hover:bg-accent-700">{t("simulator.boot")}</button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <DeviceNav label={t("chat.devices.controls")}>
          <NavButton label={t("chat.devices.home")} disabled={!booted} onClick={() => udid && run(simulatorButton(udid, "home"))}><HomeIcon className="w-[17px] h-[17px]" /></NavButton>
          <NavButton label={t("chat.devices.rotate")} disabled={!booted}
            onClick={() => udid && simulatorRotate(udid, landscape ? "right" : "left").then((o) => setLandscape(o.startsWith("landscape"))).catch(fail)}>
            <RotateIcon className="w-[17px] h-[17px]" />
          </NavButton>
          <NavButton label={t("chat.devices.shotToChat")} disabled={!booted} onClick={() => udid && simulatorScreenshot(udid).then((p) => sendShotToChat(p, t)).catch(fail)}>
            <CameraIcon className="w-[17px] h-[17px]" />
          </NavButton>
          <NavButton label={dark ? t("chat.devices.appearanceLight") : t("chat.devices.appearanceDark")} disabled={!booted || dark === null}
            onClick={() => udid && simulatorAppearance(udid, dark ? "light" : "dark").then((a) => setDark(a === "dark")).catch(fail)}>
            <ContrastIcon className="w-[17px] h-[17px]" />
          </NavButton>
          <NavButton label={t("chat.devices.location")} disabled={!booted} pop={(close) => udid && <LocationPop udid={udid} onDone={close} onError={fail} />}>
            <PinIcon className="w-[17px] h-[17px]" />
          </NavButton>
          <NavButton label={t("chat.devices.faceId")} disabled={!booted} pop={() => udid && <FaceIdPop udid={udid} onError={fail} />}>
            <FaceIdIcon className="w-[17px] h-[17px]" />
          </NavButton>
          <NavButton label={t("chat.devices.keyboard")} disabled={!booted} pop={(close) => udid && <TypePop udid={udid} onDone={close} onError={fail} />}>
            <KeyboardIcon className="w-[17px] h-[17px]" />
          </NavButton>
          <span className="flex-1" />
          <NavButton anchor="bottom" label={t("chat.devices.more")} disabled={!current} pop={(close) => current && (
            <IosMore device={current} booted={booted} onBoot={() => { close(); void boot(); }} onDone={close} onError={fail} />
          )}>
            <MoreVerticalIcon className="w-[17px] h-[17px]" />
          </NavButton>
        </DeviceNav>
      </div>
      <AgentControlFooter hint="ios" />
    </div>
  );
}

/** O seletor do iOS: "iPhone 18 Pro · iOS 26 simulador ▾", com a lista dos aparelhos do Xcode. */
function IosPicker({ devices, current, loaded }: { devices: SimDevice[]; current: SimDevice | null; loaded: boolean }) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const groups: [string, SimDevice[]][] = [
    [t("simulator.group.iphone"), devices.filter((d) => d.family === "iphone")],
    [t("simulator.group.ipad"), devices.filter((d) => d.family === "ipad")],
  ];
  return (
    <div ref={ref} className="relative min-w-0">
      <button type="button" onClick={() => { if (!open) void refreshDevices(); setOpen(!open); }} aria-haspopup="listbox" aria-expanded={open} aria-label={t("simulator.pick")}
        className={`inline-flex max-w-full items-center gap-2 h-[30px] px-2.5 rounded-lg border border-gray-200 dark:border-white/10 text-gray-900 dark:text-white ${ctlCls}`}>
        <PhoneIcon className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{current ? iosLabel(current.name, current.runtime) : loaded ? t("chat.devices.noIos") : t("chat.panel.loading")}</span>
        <span className="shrink-0 text-gray-500 dark:text-white/50">{t("chat.devices.simulator")}</span>
        <ChevronDownIcon className="w-3 h-3 shrink-0" />
      </button>
      {open && (
        <div role="listbox" aria-label={t("simulator.pick")} className={`${popCls} left-0 top-full mt-1 w-72 max-h-[420px] overflow-y-auto`}>
          {groups.filter(([, list]) => list.length > 0).map(([title, list]) => (
            <div key={title}>
              <PopTitle>{title}</PopTitle>
              {list.map((d) => (
                <button key={d.udid} type="button" role="option" aria-selected={d.udid === current?.udid}
                  onClick={() => { setPanelDevice("ios", d.udid, d.name); setOpen(false); }} className={itemCls}>
                  <span className="w-4 shrink-0">{d.udid === current?.udid && <CheckIcon className="w-3.5 h-3.5" />}</span>
                  <span className="truncate">{d.name}</span>
                  {d.state === "booted" && <span className={`text-[11px] ${okCls}`}>● {t("chat.devices.on")}</span>}
                  <span className="ml-auto shrink-0 text-[11.5px] text-gray-400 dark:text-white/40">{d.runtime}</span>
                </button>
              ))}
            </div>
          ))}
          {devices.length === 0 && <p className="m-0 px-2 py-2 text-chat-note text-gray-500 dark:text-white/50">{t("simulator.noDevices")}</p>}
        </div>
      )}
    </div>
  );
}

/** A localização simulada: lugares prontos, coordenadas digitadas ou limpar. */
function LocationPop({ udid, onDone, onError }: { udid: string; onDone: () => void; onError: (e: unknown) => void }) {
  const { t } = useTranslation();
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const la = parseCoord(lat, 90);
  const lo = parseCoord(lon, 180);
  const set = (a: number | null, b: number | null) => simulatorLocation(udid, a, b).then(onDone).catch(onError);
  return (
    <div className="flex flex-col">
      <PopTitle>{t("chat.devices.location")}</PopTitle>
      {LOCATION_PRESETS.map((p) => (
        <button key={p.id} type="button" onClick={() => void set(p.lat, p.lon)} className={itemCls}>
          <PinIcon className="w-3.5 h-3.5 text-gray-400 dark:text-white/40" />{t(`chat.devices.place.${p.id}`)}
        </button>
      ))}
      <form className="flex items-center gap-1.5 px-1 pt-2" onSubmit={(e) => { e.preventDefault(); if (la !== null && lo !== null) void set(la, lo); }}>
        <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder={t("chat.devices.lat")} aria-label={t("chat.devices.lat")} className={`${fieldCls} w-0 flex-1`} />
        <input value={lon} onChange={(e) => setLon(e.target.value)} placeholder={t("chat.devices.lon")} aria-label={t("chat.devices.lon")} className={`${fieldCls} w-0 flex-1`} />
        <button type="submit" disabled={la === null || lo === null} className="h-8 px-2.5 rounded-lg bg-accent-600 text-white text-chat-note font-medium disabled:opacity-40">{t("chat.devices.apply")}</button>
      </form>
      <button type="button" onClick={() => void set(null, null)} className={`${itemCls} mt-1 text-gray-500 dark:text-white/55`}>{t("chat.devices.clearLocation")}</button>
    </div>
  );
}

/** O Face ID do simulador: cadastrar e simular um rosto que confere ou não. */
function FaceIdPop({ udid, onError }: { udid: string; onError: (e: unknown) => void }) {
  const { t } = useTranslation();
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  useEffect(() => { simulatorBiometric(udid, "state").then(setEnrolled).catch(onError); }, [udid]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = (action: "enroll" | "unenroll" | "match" | "nomatch") => simulatorBiometric(udid, action).then(setEnrolled).catch(onError);
  return (
    <div className="flex flex-col">
      <PopTitle>{t("chat.devices.faceId")}</PopTitle>
      <div className="flex items-center justify-between gap-3 px-2 h-9">
        <span id="faceid-enrolled" className="text-gray-800 dark:text-white/85">{t("chat.devices.faceIdEnrolled")}</span>
        <ChatSwitch labelId="faceid-enrolled" checked={!!enrolled} disabled={enrolled === null} onChange={(on) => void act(on ? "enroll" : "unenroll")} />
      </div>
      <button type="button" disabled={!enrolled} onClick={() => void act("match")} className={itemCls}>{t("chat.devices.faceIdMatch")}</button>
      <button type="button" disabled={!enrolled} onClick={() => void act("nomatch")} className={itemCls}>{t("chat.devices.faceIdNoMatch")}</button>
    </div>
  );
}

/** Digitar no aparelho (o teclado do Mac também digita direto na tela). */
function TypePop({ udid, onDone, onError }: { udid: string; onDone: () => void; onError: (e: unknown) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  return (
    <form className="flex flex-col gap-2 p-1" onSubmit={(e) => { e.preventDefault(); if (text) simulatorType(udid, text).then(() => { setText(""); onDone(); }).catch(onError); }}>
      <PopTitle>{t("chat.devices.keyboard")}</PopTitle>
      <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t("chat.devices.typePlaceholder")} aria-label={t("chat.devices.typePlaceholder")} className={fieldCls} />
      <p className="m-0 px-1 text-chat-caption text-gray-500 dark:text-white/50">{t("chat.devices.typeHint")}</p>
      <button type="submit" disabled={!text} className="self-end h-8 px-3 rounded-lg bg-accent-600 text-white text-chat-note font-medium disabled:opacity-40">{t("chat.devices.type")}</button>
    </form>
  );
}

/** O "⋮" do iOS: bloquear, abrir uma URL, modo leve e ligar/desligar. */
function IosMore({ device, booted, onBoot, onDone, onError }: { device: SimDevice; booted: boolean; onBoot: () => void; onDone: () => void; onError: (e: unknown) => void }) {
  const { t } = useTranslation();
  const light = useSimulatorPrefs((s) => s.light);
  const setPrefs = useSimulatorPrefs((s) => s.set);
  const [url, setUrl] = useState("");
  const toggleLight = () => {
    const next = !light;
    setPrefs({ light: next });
    if (booted) simulatorPriority(device.udid, next).catch(onError);
  };
  return (
    <div className="flex flex-col">
      {booted && <button type="button" onClick={() => { simulatorButton(device.udid, "lock").then(onDone).catch(onError); }} className={itemCls}>{t("simulator.lock")}</button>}
      {booted && (
        <form className="flex items-center gap-1.5 px-1 py-1" onSubmit={(e) => { e.preventDefault(); if (url.trim()) simulatorOpenUrl(device.udid, url.trim()).then(onDone).catch(onError); }}>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t("chat.devices.openUrl")} aria-label={t("chat.devices.openUrl")} className={`${fieldCls} flex-1`} />
        </form>
      )}
      <button type="button" onClick={toggleLight} className={itemCls} title={t("simulator.light")}>
        <span className="w-4 shrink-0">{light && <CheckIcon className="w-3.5 h-3.5" />}</span>{t("simulator.lightShort")}
      </button>
      <div className="my-1 h-px bg-gray-200 dark:bg-white/[0.08]" />
      {booted ? (
        <button type="button" onClick={() => { simulatorShutdown(device.udid).then(() => { setDeviceState(device.udid, "shutdown"); onDone(); }).catch(onError); }}
          className={`${itemCls} text-red-600 dark:text-red-400`}>{t("simulator.shutdown")}</button>
      ) : (
        <button type="button" onClick={onBoot} className={itemCls}>{t("simulator.boot")}</button>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Android (prancheta 10)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

interface AndroidList { devices: { serial: string; state: string; model: string }[]; avds: string[]; adb: boolean }
interface Frame { png: string; width: number; height: number }

/** Os mesmos ritmos do nó do canvas: `screencap` demora, e um emulador demora a aparecer. */
const FRAME_EVERY_MS = 700;
const LIST_EVERY_MS = 4000;
const SWIPE_PX = 12;
const LOGCAT_LINES = 200;

export function AndroidPane() {
  const { t } = useTranslation();
  const [list, setList] = useState<AndroidList | null>(null);
  const [infos, setInfos] = useState<Record<string, AndroidInfo>>({});
  const picked = useChatStore((s) => s.devices.android);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const down = useRef<{ x: number; y: number } | null>(null);
  const { ref, size } = useBoxSize();

  useEffect(() => {
    let alive = true;
    const load = () => invoke<AndroidList>("android_list").then((l) => alive && setList(l)).catch(() => undefined);
    void load();
    const timer = window.setInterval(load, LIST_EVERY_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  const ready = useMemo(() => (list?.devices ?? []).filter((d) => d.state === "device"), [list]);
  const chosen = picked && ready.some((d) => d.serial === picked) ? picked : ready[0]?.serial ?? null;
  const fallback = (d: { serial: string; model: string }): AndroidInfo => ({ model: d.model, api: null, emulator: d.serial.startsWith("emulator-") });

  // O modelo e a API de cada aparelho, lidos uma vez.
  useEffect(() => {
    for (const d of ready) {
      if (infos[d.serial]) continue;
      androidInfo(d.serial)
        .then((info) => setInfos((prev) => ({ ...prev, [d.serial]: info })))
        .catch(() => setInfos((prev) => ({ ...prev, [d.serial]: fallback(d) })));
    }
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosenDevice = ready.find((d) => d.serial === chosen) ?? null;
  const info = chosenDevice ? infos[chosenDevice.serial] ?? fallback(chosenDevice) : null;
  useEffect(() => { setPanelDevice("android", chosen, info ? info.model || chosen : null); }, [chosen, info?.model]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!chosen) { setFrame(null); return; }
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const f = await invoke<Frame>("android_frame", { serial: chosen });
          if (alive) { setFrame(f); setProblem(null); }
        } catch (e) {
          if (alive) setProblem(String(e));
        }
      }
      if (alive) timer = window.setTimeout(tick, FRAME_EVERY_MS);
    };
    void tick();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [chosen]);

  const fail = (e: unknown) => { void AlertaToast(t("chat.panel.android"), String(e), "error", 5000); };
  const point = (e: React.PointerEvent) => {
    const el = img.current;
    if (!el || !frame) return null;
    const r = el.getBoundingClientRect();
    return toDevicePoint({ left: r.left, top: r.top, width: r.width, height: r.height }, frame, e.clientX, e.clientY);
  };
  const onUp = (e: React.PointerEvent) => {
    const from = down.current;
    down.current = null;
    const to = point(e);
    if (!chosen || !from || !to) return;
    if (Math.hypot(to.x - from.x, to.y - from.y) > SWIPE_PX * (frame ? frame.width / 360 : 1)) {
      invoke("android_swipe", { serial: chosen, x1: from.x, y1: from.y, x2: to.x, y2: to.y }).catch(fail);
    } else {
      invoke("android_tap", { serial: chosen, x: to.x, y: to.y }).catch(fail);
    }
  };
  const press = (keyName: string) => { if (chosen) invoke("android_key", { serial: chosen, keyName }).catch(fail); };
  const startAvd = (name: string) => { invoke("android_start_avd", { name }).catch(fail); };
  const words = { emulator: t("chat.devices.emulator"), usb: t("chat.devices.usb") };
  const avds = list?.avds ?? [];

  const dims = deviceFrame("android", frame ? { w: frame.width, h: frame.height } : { w: 1080, h: 2424 }, { w: size.w - 40, h: size.h - 40 });

  return (
    <div className="h-full flex flex-col">
      <div className={toolbarCls}>
        {ready.length > 0 ? (
          <div role="group" aria-label={t("chat.devices.device")} className="flex min-w-0 gap-0.5 p-0.5 rounded-lg bg-gray-100 dark:bg-white/[0.06]">
            {ready.map((d) => {
              const on = d.serial === chosen;
              return (
                <button key={d.serial} type="button" aria-pressed={on} onClick={() => setPanelDevice("android", d.serial, infos[d.serial]?.model || d.model || d.serial)}
                  className={`h-6 px-2.5 rounded-md text-chat-caption font-medium truncate ${on
                    ? "bg-white dark:bg-white/[0.12] text-gray-900 dark:text-white shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                    : "text-gray-500 dark:text-white/50 hover:text-gray-900 dark:hover:text-white"}`}>
                  {androidLabel(infos[d.serial] ?? fallback(d), words)}
                </button>
              );
            })}
          </div>
        ) : (
          <span className="truncate text-gray-500 dark:text-white/50">{list && !list.adb ? t("chat.devices.noAdbShort") : t("chat.devices.noAndroid")}</span>
        )}
        {info && <span className={`shrink-0 ${okCls}`}>● {info.emulator ? t("chat.devices.on") : t("chat.devices.usbOn")}</span>}
        <span className="flex-1" />
        {chosen && <span className="font-mono text-chat-code text-gray-500 dark:text-white/50 truncate">adb · {chosen}</span>}
      </div>

      <div className="flex-1 min-h-0 flex bg-gray-100 dark:bg-white/[0.02]">
        <div ref={ref} className="flex-1 min-w-0 flex items-center justify-center p-5">
          {frame && chosen && dims.outerW > 0 ? (
            <div className="shrink-0 box-border bg-gray-800 shadow-[0_0_0_2px_rgba(60,64,67,1),0_24px_48px_-20px_rgba(0,0,0,0.45)]"
              style={{ width: dims.outerW, height: dims.outerH, padding: dims.pad, borderRadius: dims.outerRadius }}>
              <img ref={img} alt="" draggable={false} src={`data:image/png;base64,${frame.png}`}
                onPointerDown={(e) => { down.current = point(e); e.currentTarget.setPointerCapture(e.pointerId); }} onPointerUp={onUp}
                className="block h-full w-full object-fill select-none cursor-pointer" style={{ borderRadius: dims.screenRadius }} />
            </div>
          ) : (
            <div className="flex max-w-[280px] flex-col items-center gap-3 text-center">
              <p className="m-0 text-chat-note leading-snug text-gray-500 dark:text-white/45">
                {list && !list.adb ? t("canvas.device.noAdb") : chosen ? problem ?? t("chat.panel.loading") : t("canvas.device.empty")}
              </p>
              {!chosen && avds.map((a) => (
                <button key={a} type="button" onClick={() => startAvd(a)}
                  className="h-8 rounded-lg bg-accent-600 px-4 text-chat-note font-medium text-white hover:bg-accent-700">{t("chat.devices.startAvd", { name: a })}</button>
              ))}
            </div>
          )}
        </div>

        <DeviceNav label={t("chat.devices.controls")}>
          <NavButton label={t("canvas.device.back")} disabled={!chosen} onClick={() => press("back")}><BackTriangleIcon className="w-[17px] h-[17px]" /></NavButton>
          <NavButton label={t("canvas.device.home")} disabled={!chosen} onClick={() => press("home")}><CircleIcon className="w-[17px] h-[17px]" /></NavButton>
          <NavButton label={t("canvas.device.recents")} disabled={!chosen} onClick={() => press("recents")}><SquareIcon className="w-[17px] h-[17px]" /></NavButton>
          <span aria-hidden="true" className="w-5 h-px my-1 bg-gray-200 dark:bg-white/[0.08]" />
          <NavButton label={t("chat.devices.rotate")} disabled={!chosen} onClick={() => chosen && androidRotate(chosen).catch(fail)}><RotateIcon className="w-[17px] h-[17px]" /></NavButton>
          <NavButton label={t("chat.devices.shotToChat")} disabled={!chosen} onClick={() => chosen && androidScreenshot(chosen).then((p) => sendShotToChat(p, t)).catch(fail)}>
            <CameraIcon className="w-[17px] h-[17px]" />
          </NavButton>
          <NavButton label={t("chat.devices.volume")} disabled={!chosen} pop={() => (
            <div className="flex flex-col">
              <PopTitle>{t("chat.devices.volume")}</PopTitle>
              <button type="button" onClick={() => press("volume_up")} className={itemCls}>{t("chat.devices.volumeUp")}</button>
              <button type="button" onClick={() => press("volume_down")} className={itemCls}>{t("chat.devices.volumeDown")}</button>
              <button type="button" onClick={() => press("KEYCODE_VOLUME_MUTE")} className={itemCls}>{t("chat.devices.volumeMute")}</button>
            </div>
          )}>
            <VolumeIcon className="w-[17px] h-[17px]" />
          </NavButton>
          <NavButton label={t("chat.devices.logcat")} disabled={!chosen} wide pop={() => chosen && <LogcatPop serial={chosen} onError={fail} />}>
            <LogIcon className="w-[17px] h-[17px]" />
          </NavButton>
          <span className="flex-1" />
          <NavButton anchor="bottom" label={t("chat.devices.more")} pop={(close) => (
            <div className="flex flex-col">
              {chosen && <button type="button" onClick={() => { press("power"); close(); }} className={itemCls}>{t("chat.devices.power")}</button>}
              {avds.length > 0 && <PopTitle>{t("canvas.device.emulator")}</PopTitle>}
              {avds.map((a) => (
                <button key={a} type="button" onClick={() => { startAvd(a); close(); }} className={itemCls}>{t("chat.devices.startAvd", { name: a })}</button>
              ))}
              {!chosen && avds.length === 0 && <p className="m-0 px-2 py-2 text-chat-note text-gray-500 dark:text-white/50">{t("canvas.device.empty")}</p>}
            </div>
          )}>
            <MoreVerticalIcon className="w-[17px] h-[17px]" />
          </NavButton>
        </DeviceNav>
      </div>
      <AgentControlFooter hint="android" />
    </div>
  );
}

/** As últimas linhas do `logcat`, relidas ao abrir e no "Atualizar". */
function LogcatPop({ serial, onError }: { serial: string; onError: (e: unknown) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState<string | null>(null);
  const load = useCallback(() => { androidLogcat(serial, LOGCAT_LINES).then(setText).catch(onError); }, [serial]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => load(), [load]);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center">
        <PopTitle>{t("chat.devices.logcat")}</PopTitle>
        <span className="flex-1" />
        <button type="button" onClick={load} className={`h-7 px-2 rounded-md text-chat-note text-gray-500 dark:text-white/50 ${ctlCls}`}>{t("chat.panel.refresh")}</button>
      </div>
      <pre className="m-0 h-[340px] overflow-auto cc-scroll rounded-lg bg-gray-50 dark:bg-black/40 p-2 font-mono text-[11px] leading-[1.5] text-gray-700 dark:text-white/70 whitespace-pre-wrap break-all">
        {text ?? t("chat.panel.loading")}
      </pre>
    </div>
  );
}
