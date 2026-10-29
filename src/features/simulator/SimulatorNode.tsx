import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Position } from "@xyflow/react";

import { CordPort } from "@/features/canvas/cords";
import { isNoteId, isPortalId, neighbors, type CanvasPortal } from "@/features/canvas/board";
import { canvasActions, useActiveBoardKey, useCanvasStore } from "@/features/canvas/store";
import { useTabsStore } from "@/features/tabs/store";
import { AlertaToast } from "@/shared/ui/alerts";

import { clampScale, DEFAULT_SCREEN, nodeSize, phoneOf, scaleOf, SIM_GAP_X, SIM_GAP_Y, stepScale, type SimScreen } from "./geometry";
import { simulatorBoot, simulatorButton, simulatorPriority, simulatorScreenshot, simulatorShutdown, type SimDevice } from "./ipc";
import { SimulatorBar } from "./SimulatorBar";
import { SimulatorChat, type SimAgent } from "./SimulatorChat";
import { SimulatorScreen } from "./SimulatorScreen";
import { addLine, deviceByUdid, listenActivity, refreshDevices, setDeviceState, useSimulatorStore } from "./store";
import { useSimulatorPrefs } from "./prefs";

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
  const board = useCanvasStore((s) => (key ? s.boards[key] : undefined));
  const tabs = useTabsStore((s) => s.tabs);
  const light = useSimulatorPrefs((s) => s.light);
  const [booting, setBooting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closeArmed, setCloseArmed] = useState(false);

  useEffect(() => {
    listenActivity();
    if (!loaded) void refreshDevices();
  }, [loaded]);

  const current = deviceByUdid(devices, portal.udid);
  const screen = screenOf(current);
  const scale = scaleOf(screen, portal.box.h);
  const chat = !!portal.chat;
  const phone = phoneOf(screen, scale);
  const state: SimDevice["state"] | "error" = error ? "error" : booting ? "booting" : current?.state ?? "shutdown";
  const booted = current?.state === "booted";

  const agents: SimAgent[] = useMemo(() => {
    if (!board) return [];
    return neighbors(board, id)
      .filter((other) => !isPortalId(other) && !isNoteId(other))
      .flatMap((other) => {
        const tab = tabs.find((x) => x.id === other);
        return tab ? [{ id: tab.id, name: tab.title, agentId: String(tab.agentId) }] : [];
      });
  }, [board, id, tabs]);

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

  const fail = (e: unknown) => {
    setError(String(e));
    void AlertaToast(portal.name, String(e), "error", 5000);
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
      const next = screenOf(deviceByUdid(devices, udid));
      resize(next, clampScale(next, scale), chat, { udid, name: deviceByUdid(devices, udid)?.name ?? portal.name });
    },
    onOpenPicker: () => void refreshDevices(),
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
    onChat: () => resize(screen, scale, !chat, { chat: !chat }),
    onScale: (direction: 1 | -1) => resize(screen, stepScale(screen, scale, direction), chat),
    onLight: async () => {
      const next = !light;
      useSimulatorPrefs.getState().setLight(next);
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
          agents={agents.length} chatOpen={chat} closeArmed={closeArmed} actions={actions} />
        <div className="flex min-h-0 flex-1" style={{ gap: SIM_GAP_X }}>
          <div className="relative shrink-0 bg-gradient-to-br from-surface-overlay via-surface to-surface-raised"
            style={{
              width: phone.w, height: phone.h, borderRadius: phone.outerRadius, padding: phone.bezel,
              boxShadow: selected
                ? "0 0 0 1px var(--color-accent-400), 0 30px 80px rgba(0,0,0,0.55), inset 0 0 0 2px rgba(0,0,0,0.9)"
                : "0 0 0 1px rgba(255,255,255,0.08), 0 30px 80px rgba(0,0,0,0.55), inset 0 0 0 2px rgba(0,0,0,0.9)",
            }}>
            <div className="nodrag nowheel nopan relative h-full w-full overflow-hidden bg-black" style={{ borderRadius: phone.screenRadius }}>
              {booted && portal.udid && !booting ? (
                <SimulatorScreen screenId={id} udid={portal.udid} radius={phone.screenRadius} onError={fail} />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
                  <span className="text-[13px] font-semibold text-white">{current?.name ?? t("simulator.pick")}</span>
                  <span className="text-[11.5px] leading-snug text-gray-400">
                    {booting ? t("simulator.booting") : current ? `${current.runtime} · ${t("simulator.offHint")}` : t("simulator.pickHint")}
                  </span>
                  {!booting && current && (
                    <button type="button" onClick={() => void boot()}
                      className="cc-t h-8 rounded-lg bg-accent-600 px-4 text-[12.5px] font-medium text-white hover:bg-accent-500">
                      {t("simulator.boot")}
                    </button>
                  )}
                  {!booting && current && <span className="text-[10.5px] text-gray-500">{t("simulator.bootHint")}</span>}
                </div>
              )}
            </div>
          </div>
          {chat && key && (
            <SimulatorChat boardKey={key} node={id} name={portal.name} udid={portal.udid} booted={booted} agents={agents}
              onClose={() => resize(screen, scale, false, { chat: false })} />
          )}
        </div>
      </div>
    </div>
  );
});
