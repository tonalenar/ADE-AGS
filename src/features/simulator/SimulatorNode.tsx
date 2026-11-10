import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Position } from "@xyflow/react";

import { CordPort } from "@/features/canvas/cords";
import { isNoteId, isPortalId, neighbors, type CanvasPortal } from "@/features/canvas/board";
import { canvasActions, useActiveBoardKey, useCanvasStore, useWorkMode } from "@/features/canvas/store";
import { useTabsStore } from "@/features/tabs/store";
import { AlertaToast } from "@/shared/ui/alerts";

import { clampScale, DEFAULT_SCREEN, isLandscape, nodeSize, orientedScreen, phoneOf, scaleOf, SIM_GAP_X, SIM_GAP_Y, stepScale, type SimScreen } from "./geometry";
import {
  SIMULATOR_ORIENTATION_EVENT, simulatorBoot, simulatorButton, simulatorClipboard, simulatorOrientation, simulatorPriority, simulatorRotate, simulatorScreenshot,
  simulatorShutdown, type SimDevice, type SimOrientationEvent,
} from "./ipc";
import { useChatShell } from "@/app/uiStore";
import { DESKTOP_OS } from "@/app/platform";
import { canvasDeviceEngaged, shouldProbeDevices } from "@/features/chat/deviceDemand";
import { canTouch, frameLayout, isPhysicalId, physicalScreen } from "@/features/iphone/model";
import { iphoneMirrorConnect, iphoneMirrorDisconnect } from "@/features/iphone/ipc";
import { DeviceFrame, screenRadiusOf } from "@/features/iphone/DeviceFrame";
import { PhysicalMirror } from "@/features/iphone/PhysicalParts";
import { refreshPhysical, setMirrorDisconnected, useIphoneStore, useMirrorStatus } from "@/features/iphone/store";

import { SimulatorBar } from "./SimulatorBar";
import { SimulatorChat, type SimAgent } from "./SimulatorChat";
import { SimulatorScreen } from "./SimulatorScreen";
import { addLine, deviceByUdid, listenActivity, refreshDevices, setDeviceState, useSimulatorStore } from "./store";
import { syncSimulatorPrefs, useSimulatorPrefs } from "./prefs";

const handle = "w-2.5! h-2.5! border-2! border-white! dark:border-surface-deep! bg-accent-400! dark:bg-accent-500!";

function screenOf(device: SimDevice | undefined): SimScreen {
  return device && device.width > 0 && device.height > 0 ? { width: device.width, height: device.height, family: device.family } : DEFAULT_SCREEN;
}

/**
 * O simulador iOS solto no canvas: a barra flutuante, o aparelho e (aberta) a conversa com os agentes ligados a
 * ele, alinhados num bloco só (ver `geometry.ts`). A tela é nativa (`SimulatorScreen`); o resto é DOM.
 */
export const SimulatorNode = memo(function SimulatorNode({ id, portal, selected }: { id: string; portal: CanvasPortal; selected: boolean }) {
  const { t } = useTranslation();
  const key = useActiveBoardKey();
  const devices = useSimulatorStore((s) => s.devices);
  const loaded = useSimulatorStore((s) => s.loaded);
  // Só o que o nó usa, como texto estável: assinar o board ou as abas inteiras re-renderizava o simulador a cada
  // arrasto de outro nó do canvas e a cada mudança de status de aba.
  const linked = useCanvasStore((s) => {
    const board = key ? s.boards[key] : undefined;
    return board ? neighbors(board, id).filter((other) => !isPortalId(other) && !isNoteId(other)).join("\n") : "";
  });
  const agentsKey = useTabsStore((s) => linked.split("\n").filter(Boolean).flatMap((tabId) => {
    const tab = s.tabs.find((x) => x.id === tabId);
    return tab ? [`${tab.id}\t${tab.title}\t${String(tab.agentId)}`] : [];
  }).join("\n"));
  const light = useSimulatorPrefs((s) => s.light);
  const hibernateMin = useSimulatorPrefs((s) => s.hibernateMin);
  const single = useSimulatorPrefs((s) => s.single);
  const paused = useSimulatorStore((s) => (portal.udid ? s.paused[portal.udid] : undefined));
  const [booting, setBooting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closeArmed, setCloseArmed] = useState(false);
  const [landscape, setLandscape] = useState(false);
  const [physicalSearching, setPhysicalSearching] = useState(false);
  const [physicalSessionBusy, setPhysicalSessionBusy] = useState(false);
  const surfaceOpen = canvasDeviceEngaged(useWorkMode(), useChatShell());
  const probeSimulator = shouldProbeDevices(surfaceOpen, DESKTOP_OS, "ios-simulator");
  const probePhysical = shouldProbeDevices(surfaceOpen, DESKTOP_OS, "ios-physical");

  useEffect(() => {
    if (!probeSimulator) return;
    listenActivity();
    if (!loaded) {
      syncSimulatorPrefs();
      void refreshDevices();
    }
  }, [loaded, probeSimulator]);

  // O nó pode mostrar um iPhone ou iPad físico (`device:<id>`): só ver, sem os controles do simulador.
  const physicalId = isPhysicalId(portal.udid) ? portal.udid : null;
  const physical = useIphoneStore((s) => (physicalId ? s.devices.find((d) => d.id === physicalId) : undefined));
  const mirror = useMirrorStatus(probePhysical ? physicalId : null);
  const disconnected = useIphoneStore((s) => (physicalId ? s.disconnectedDevices.includes(physicalId) : false));
  const physicalLoaded = useIphoneStore((s) => s.loaded);
  useEffect(() => { if (probePhysical && physicalId) void refreshPhysical(); }, [physicalId, probePhysical]);
  const current = physicalId ? undefined : deviceByUdid(devices, portal.udid);
  const booted = current?.state === "booted";
  // A moldura deita com o iOS: a orientação vem do backend ao ligar e a cada giro (de qualquer tela ou agente).
  const screen = physicalId
    ? physicalScreen(mirror?.display ?? null, physical?.family ?? "iphone")
    : orientedScreen(screenOf(current), landscape && booted);

  useEffect(() => {
    const udid = portal.udid;
    if (!udid || !booted) {
      setLandscape(false);
      return;
    }
    if (!probeSimulator) return;
    let alive = true;
    simulatorOrientation(udid).then((o) => alive && turnRef.current(isLandscape(o))).catch(() => undefined);
    const off = listen<SimOrientationEvent>(SIMULATOR_ORIENTATION_EVENT, (e) => {
      if (alive && e.payload.udid === udid) turnRef.current(isLandscape(e.payload.orientation));
    });
    return () => {
      alive = false;
      void off.then((f) => f());
    };
  }, [portal.udid, booted, probeSimulator]);
  const previousPhysicalLayout = useRef<{ id: string; width: number; height: number; scale: number } | null>(null);
  const priorLayout = previousPhysicalLayout.current;
  const physicalQuarterTurn = !!physicalId && priorLayout?.id === physicalId
    && priorLayout.width === screen.height && priorLayout.height === screen.width;
  const scale = physicalQuarterTurn ? priorLayout!.scale : scaleOf(screen, portal.box.h);
  useLayoutEffect(() => {
    if (physicalId) previousPhysicalLayout.current = { id: physicalId, width: screen.width, height: screen.height, scale };
    else previousPhysicalLayout.current = null;
  }, [physicalId, screen.width, screen.height, scale]);
  // A conversa com os agentes é do simulador: o aparelho físico ainda não é pilotado por eles.
  const chat = !!portal.chat && !physicalId;
  const phone = phoneOf(screen, scale);
  const state: SimDevice["state"] | "error" = error ? "error" : booting ? "booting" : current?.state ?? "shutdown";

  const agents: SimAgent[] = useMemo(() => agentsKey.split("\n").filter(Boolean).map((row) => {
    const [tabId, name, agentId] = row.split("\t");
    return { id: tabId, name, agentId };
  }), [agentsKey]);

  // O box gravado acompanha o bloco: trocar de aparelho, abrir a conversa ou mudar o zoom muda o tamanho do nó.
  const resize = (nextScreen: SimScreen, nextScale: number, nextChat: boolean, patch: Partial<CanvasPortal> = {}) => {
    if (!key) return;
    const size = nodeSize(nextScreen, nextScale, nextChat);
    canvasActions.updatePortal(key, id, patch);
    canvasActions.moveNode(key, id, { ...portal.box, w: size.w, h: size.h });
  };

  useEffect(() => {
    const size = nodeSize(screen, scale, chat);
    if (key && (Math.abs(size.w - portal.box.w) > 1 || Math.abs(size.h - portal.box.h) > 1)) {
      canvasActions.moveNode(key, id, { ...portal.box, w: size.w, h: size.h });
    }
  }, [key, id, screen.width, screen.height, scale, chat]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deitar ou levantar a moldura mantém a escala: o box troca de largura e altura na mesma passada (sem isso,
  // a escala relida do box antigo pularia). Pela ref, o ouvinte do evento usa sempre a versão atual.
  const turn = (next: boolean) => {
    if (next === landscape) return;
    resize(orientedScreen(screenOf(current), next && booted), scale, chat);
    setLandscape(next);
  };
  const turnRef = useRef(turn);
  turnRef.current = turn;

  const fail = (e: unknown) => {
    setError(String(e));
    void AlertaToast(portal.name, String(e), "error", 5000);
  };

  const searchPhysical = async () => {
    setPhysicalSearching(true);
    try {
      await refreshPhysical(true);
    } catch (e) {
      fail(e);
    } finally {
      setPhysicalSearching(false);
    }
  };

  const togglePhysicalSession = async () => {
    if (!physicalId) return;
    setPhysicalSessionBusy(true);
    try {
      if (disconnected) {
        await iphoneMirrorConnect(physicalId);
        setMirrorDisconnected(physicalId, false);
      } else {
        await iphoneMirrorDisconnect(physicalId);
        setMirrorDisconnected(physicalId, true);
      }
    } catch (e) {
      fail(e);
    } finally {
      setPhysicalSessionBusy(false);
    }
  };

  const boot = async () => {
    if (!portal.udid || booting) return;
    setBooting(true);
    setError(null);
    try {
      await simulatorBoot(portal.udid, light);
      setDeviceState(portal.udid, "booted");
    } catch (e) {
      fail(e);
    } finally {
      setBooting(false);
    }
  };

  const actions = {
    onPick: (udid: string) => {
      setError(null);
      if (isPhysicalId(udid)) {
        const device = useIphoneStore.getState().devices.find((d) => d.id === udid);
        const next = physicalScreen(useIphoneStore.getState().statuses[udid]?.display ?? null, device?.family ?? "iphone");
        resize(next, clampScale(next, scale), false, { udid, name: device?.name ?? portal.name, chat: false });
        return;
      }
      const next = screenOf(deviceByUdid(devices, udid));
      resize(next, clampScale(next, scale), chat, { udid, name: deviceByUdid(devices, udid)?.name ?? portal.name });
    },
    onOpenPicker: () => { if (shouldProbeDevices(true, DESKTOP_OS, "ios-simulator")) void refreshDevices(); },
    onSearchPhysical: () => { void searchPhysical(); },
    onTogglePhysicalSession: () => { void togglePhysicalSession(); },
    onButton: (name: "home" | "lock") => { if (portal.udid) simulatorButton(portal.udid, name).catch(fail); },
    onShot: async () => {
      if (!portal.udid) return;
      try {
        const path = await simulatorScreenshot(portal.udid);
        void AlertaToast(portal.name, t("simulator.shotSaved", { path }), "success", 4000);
      } catch (e) {
        fail(e);
      }
    },
    onRotate: () => {
      if (portal.udid) simulatorRotate(portal.udid, landscape ? "right" : "left").then((o) => turnRef.current(isLandscape(o))).catch(fail);
    },
    onChat: () => resize(screen, scale, !chat, { chat: !chat }),
    onScale: (direction: 1 | -1) => resize(screen, stepScale(screen, scale, direction), chat),
    onLight: async () => {
      const next = !light;
      useSimulatorPrefs.getState().set({ light: next });
      if (!booted || !portal.udid) {
        void AlertaToast(portal.name, t(next ? "simulator.lightOnNext" : "simulator.lightOffNext"), "info", 3500);
        return;
      }
      try {
        const count = await simulatorPriority(portal.udid, next);
        void AlertaToast(portal.name, t(next ? "simulator.lightOn" : "simulator.lightOff", { count }), "success", 3500);
      } catch (e) {
        fail(e);
      }
    },
    onClipboard: async (direction: "toDevice" | "toMac") => {
      if (!portal.udid) return;
      try {
        await simulatorClipboard(portal.udid, direction);
        void AlertaToast(portal.name, t(direction === "toDevice" ? "simulator.clipboardSentToDevice" : "simulator.clipboardSentToMac"), "success", 3000);
      } catch (e) {
        fail(e);
      }
    },
    onShutdown: async () => {
      if (!portal.udid) return;
      try {
        await simulatorShutdown(portal.udid);
        setDeviceState(portal.udid, "shutdown");
        addLine(id, { kind: "system", agent: "", text: t("simulator.shutDownLine"), at: Date.now() });
      } catch (e) {
        fail(e);
      }
    },
    onHibernate: (minutes: number) => useSimulatorPrefs.getState().set({ hibernateMin: minutes }),
    onSingle: () => useSimulatorPrefs.getState().set({ single: !single }),
    onClose: () => {
      if (!closeArmed) {
        setCloseArmed(true);
        window.setTimeout(() => setCloseArmed(false), 3000);
        return;
      }
      if (key) canvasActions.removePortal(key, id);
    },
  };

  return (
    <div className="relative h-full w-full">
      <CordPort id="l" type="source" position={Position.Left} className={handle} />
      <CordPort id="r" type="source" position={Position.Right} className={handle} />
      <CordPort id="t" type="source" position={Position.Top} className={handle} />
      <CordPort id="b" type="source" position={Position.Bottom} className={handle} />
      <div className="flex h-full w-full flex-col" style={{ gap: SIM_GAP_Y }}>
        <SimulatorBar full={chat} devices={devices} current={current} state={state} scale={scale} light={light}
          physical={physicalId ? { id: physicalId, device: physical, status: mirror, disconnected, searching: physicalSearching, sessionBusy: physicalSessionBusy } : undefined}
          hibernateMin={hibernateMin} single={single}
          agents={agents.length} chatOpen={chat} closeArmed={closeArmed} actions={actions} />
        <div className="flex min-h-0 flex-1" style={{ gap: SIM_GAP_X }}>
          {physicalId ? (
            // O aparelho físico: a moldura do modelo, com os botões da lateral funcionando (ver `iphone/DeviceFrame`).
            <div className="nodrag nowheel nopan flex shrink-0 items-center justify-center" style={{ width: phone.w, height: phone.h }}>
              <DeviceFrame device={physicalId} name={portal.name} layout={frameLayout(physical?.model ?? "", physical?.family ?? "iphone")}
                screen={{ width: Math.round(phone.screenW), height: Math.round(phone.screenH) }} enabled={!disconnected && canTouch(mirror)}>
                <PhysicalMirror screenId={id} device={physicalId} known={!physicalLoaded || !!physical} status={mirror}
                  radius={screenRadiusOf(frameLayout(physical?.model ?? "", physical?.family ?? "iphone"), Math.round(phone.screenW))} onError={fail} engaged={probePhysical} />
              </DeviceFrame>
            </div>
          ) : (
          <div className="relative shrink-0 bg-gradient-to-br from-surface-overlay via-surface to-surface-raised"
            style={{
              width: phone.w, height: phone.h, borderRadius: phone.outerRadius, padding: phone.bezel,
              boxShadow: selected
                ? "0 0 0 1px var(--color-accent-400), 0 30px 80px rgba(0,0,0,0.55), inset 0 0 0 2px rgba(0,0,0,0.9)"
                : "0 0 0 1px rgba(255,255,255,0.08), 0 30px 80px rgba(0,0,0,0.55), inset 0 0 0 2px rgba(0,0,0,0.9)",
            }}>
            <div className="nodrag nowheel nopan relative h-full w-full overflow-hidden bg-black" style={{ borderRadius: phone.screenRadius }}>
              {booted && portal.udid && !booting ? (
                <SimulatorScreen screenId={id} udid={portal.udid} radius={phone.screenRadius} onError={fail} engaged={probeSimulator} />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
                  {paused && !booting && <span aria-hidden className="text-[22px] text-accent-300">☾</span>}
                  <span className="text-[13px] font-semibold text-white">{paused && !booting ? t("simulator.paused.title") : current?.name ?? t("simulator.pick")}</span>
                  <span className="text-[11.5px] leading-snug text-gray-400">
                    {booting ? t("simulator.booting")
                      : paused ? t(paused === "single" ? "simulator.paused.single" : "simulator.paused.hint")
                      : current ? `${current.runtime} · ${t("simulator.offHint")}` : t("simulator.pickHint")}
                  </span>
                  {!booting && current && (
                    <button type="button" onClick={() => void boot()}
                      className="cc-t h-8 rounded-lg bg-accent-600 px-4 text-[12.5px] font-medium text-white hover:bg-accent-500">
                      {paused ? t("simulator.paused.resume") : t("simulator.boot")}
                    </button>
                  )}
                  {!booting && current && <span className="text-[10.5px] text-gray-500">{t("simulator.bootHint")}</span>}
                </div>
              )}
            </div>
          </div>
          )}
          {chat && key && (
            <SimulatorChat boardKey={key} node={id} name={portal.name} udid={portal.udid} booted={booted} agents={agents}
              onClose={() => resize(screen, scale, false, { chat: false })} />
          )}
        </div>
      </div>
    </div>
  );
});
