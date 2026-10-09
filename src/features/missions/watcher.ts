import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { useCanvasStore } from "@/features/canvas/store";
import { activeTabIds, activitySnapshot, lastInputAt, lastOutputAt, sustainedTabIds as sustainedNow } from "@/features/terminal/activity";
import { onPromptSubmitted, pasteIntoTab, screenOf } from "@/features/terminal/terminalRegistry";
import { useTabsStore } from "@/features/tabs/store";

import { isFinalDelivery, noteDelivery, noteSustained } from "../bot/arcadeSignals";
import { sustainedTabIds } from "@/features/terminal/activity";
import { useMemoryPendingNotice } from "../memory/useMemoryPendingNotice";
import { ACTIVE_FLUSH_MS, ACTIVE_TICK_MS, accumulate, sampleWorking } from "./activeTime";
import { finishedMissionTabs, missionIndex, useMissionIndex } from "./groups";
import { STALL_CHECK_MS, applyMessage, parseStallMs, findStalls, markAlerted, stallMessage, type PeerMessage, type PendingTasks } from "./stalled";
import { useMissionsStore } from "./store";
import { LEAD_NAME } from "./terminals";
import { recordSpan } from "./timings";
import { addAsks, applyLeadMessage, deriveAlerts, findLeadStalls, findScreenAsks, leadStallMessage, leadStallSpan, markLeadAlerted, parseLeadStallMs, type PendingAsks } from "./leadStall";
import { useStallAlerts } from "./stallAlerts";
import { useVigiaDriver } from "./vigia";
import { missionTurns } from "./turns";

/** Lo que avisa el servidor al terminar un `peer ask` (ver `cc-peer-timing` en Rust). */
export interface PeerTimingEvent {
  from: string;
  to: string;
  toTabId: string;
  startedMs: number;
  endedMs: number;
  finished: boolean;
}

/**
 * Lo que las misiones hacen en segundo plano, con la barra lateral abierta o cerrada:
 *
 * - **cronómetro**: cada `peer ask` avisa cuánto esperó; acá se le pone la misión;
 * - **barrido**: una misión terminada cierra sus pestañas (y con ellas los procesos);
 * - **aviso de memoria**: cuando un agente sugiere una memoria, un aviso con la acción de abrirla.
 *
 * Vive aparte de la columna de Misiones a propósito: esa columna solo existe mientras la
 * barra está expandida, y con la barra recogida nadie escuchaba ni barría.
 */
export function useMissionWatcher(): void {
  // O Vigia de cada missão é acordado pelo app quando alguém fica sem saída (ver `vigia.ts`).
  useVigiaDriver();
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const tabs = useTabsStore((s) => s.tabs);
  const missions = useMissionsStore((s) => s.missions);
  const load = useMissionsStore((s) => s.load);
  const index = useMissionIndex();

  // Aviso cuando un agente sugiere una memoria; también con la barra lateral recogida.
  useMemoryPendingNotice(workspaceId);

  useEffect(() => {
    const start = (tabId: string, at: number) => {
      const openTabs = useTabsStore.getState().tabs;
      const mission = missionIndex(useCanvasStore.getState().boards, openTabs)[tabId];
      const tab = openTabs.find((t) => t.id === tabId);
      if (mission && tab && tab.agentId !== "bash") missionTurns.start(tabId, mission, tab.title || tab.agentLabel, at);
    };
    const unsubscribe = onPromptSubmitted(start);
    const off = listen<PeerMessage>("cc-peer-message", (e) => {
      if (e.payload.toTabId) start(e.payload.toTabId, e.payload.atMs);
    });
    return () => { unsubscribe(); off.then((fn) => fn()); };
  }, []);

  // Las misiones del workspace, al día.
  useEffect(() => {
    if (!workspaceId) return;
    load(workspaceId).catch(() => undefined);
    const off = listen<string>("cc-mission-changed", () => load(workspaceId).catch(() => undefined));
    return () => {
      off.then((fn) => fn());
    };
  }, [workspaceId, load]);

  // Cronómetro de los `peer ask`.
  useEffect(() => {
    const off = listen<PeerTimingEvent>("cc-peer-timing", (e) => {
      const { tabs: openTabs } = useTabsStore.getState();
      const mission = missionIndex(useCanvasStore.getState().boards, openTabs)[e.payload.toTabId];
      if (!mission) return;
      recordSpan(mission, {
        kind: "peer_ask",
        actor: e.payload.from,
        target: e.payload.to,
        startedMs: e.payload.startedMs,
        endedMs: e.payload.endedMs,
        detail: e.payload.finished ? "" : "timeout",
      });
    });
    return () => {
      off.then((fn) => fn());
    };
  }, []);

  // Ao vivo: sinais reais por terminal (quem já trabalhou, quem fez a entrega final).
  useEffect(() => {
    const isLead = (tabId: string) => useTabsStore.getState().tabs.find((tab) => tab.id === tabId)?.title === LEAD_NAME;
    const off = listen<PeerMessage>("cc-peer-message", (e) => {
      if (isFinalDelivery(e.payload, isLead)) noteDelivery(e.payload.fromTabId, e.payload.atMs);
    });
    const timer = setInterval(() => { if (document.visibilityState === "visible") noteSustained(sustainedTabIds()); }, 2000);
    return () => { clearInterval(timer); off.then((fn) => fn()); };
  }, []);

  // Agente parado: una tarea con `peer tell` que nadie atiende se le avisa al orquestador.
  useEffect(() => {
    let pending: PendingTasks = new Map();
    let asks: PendingAsks = new Map();
    const published = new Set<string>();
    const leadOf = (tabId: string) => useTabsStore.getState().tabs.find((t) => t.id === tabId);
    const isLead = (tabId: string) => leadOf(tabId)?.title === LEAD_NAME;
    const missionOfTab = (tabId: string) => missionIndex(useCanvasStore.getState().boards, useTabsStore.getState().tabs)[tabId];
    const titleOf = (tabId: string) => useTabsStore.getState().tabs.find((t) => t.id === tabId)?.title ?? tabId;
    const leadTabOf = (tabId: string) => {
      const mission = missionOfTab(tabId);
      return mission ? useTabsStore.getState().tabs.find((t) => t.title === LEAD_NAME && missionOfTab(t.id) === mission)?.id ?? null : null;
    };
    const record = (tabId: string, span: ReturnType<typeof leadStallSpan>) => {
      const mission = missionOfTab(tabId);
      if (mission) recordSpan(mission, span);
    };
    // Los avisos visibles (QG y aba da missão) se derivan de lo ya avisado; solo se publica si cambian.
    const publish = (now: number) => {
      const next = deriveAlerts(asks, pending, titleOf, missionOfTab, now);
      const store = useStallAlerts.getState();
      for (const [mission, alerts] of next) store.setAlerts(mission, alerts);
      for (const mission of published) if (!next.has(mission)) store.setAlerts(mission, []);
      published.clear();
      for (const mission of next.keys()) published.add(mission);
    };
    const off = listen<PeerMessage>("cc-peer-message", (e) => {
      pending = applyMessage(pending, e.payload, isLead);
      const applied = applyLeadMessage(asks, e.payload, isLead, leadTabOf(e.payload.fromTabId));
      asks = applied.pending;
      // Una espera que ya se avisó se cierra con su duración total: es la métrica de "tiempo sin respuesta".
      for (const done of applied.answered) {
        if (done.alerted) record(done.memberTabId, leadStallSpan(done, done.answeredAt, "answered", titleOf(done.memberTabId), titleOf(done.leadTabId)));
      }
    });
    const runLeadStall = (now: number) => {
      const openTabs = useTabsStore.getState().tabs;
      const open = new Set(openTabs.map((t) => t.id));
      asks = new Map([...asks].filter(([id, a]) => open.has(id) && open.has(a.leadTabId)));
      const members = new Map(openTabs.flatMap((t) => {
        const lead = t.title === LEAD_NAME || t.agentId === "bash" ? null : leadTabOf(t.id);
        return lead ? [[t.id, lead] as const] : [];
      }));
      let waitMs = parseLeadStallMs(null);
      try {
        waitMs = parseLeadStallMs(localStorage.getItem("ags.leadStallMs"));
      } catch {
        // sin localStorage: queda el plazo por defecto
      }
      const active = new Set(activeTabIds(now));
      const working = new Set(sustainedNow(now));
      const probe = {
        now,
        isActive: (id: string) => active.has(id),
        isWorking: (id: string) => working.has(id),
        lastOutputAt,
        lastInputAt,
        screen: (id: string) => screenOf(id)?.lines ?? null,
      };
      asks = addAsks(asks, findScreenAsks(members, asks, probe));
      const stalls = findLeadStalls(asks, probe, waitMs);
      const sent = stalls.filter((s) => {
        // No se interrumpe al orquestador a mitad de un turno: se reintenta en el próximo tic.
        if (active.has(s.leadTabId)) return false;
        const ok = pasteIntoTab(s.leadTabId, leadStallMessage(titleOf(s.memberTabId), s), true);
        const ask = asks.get(s.memberTabId);
        if (ok && ask) record(s.memberTabId, leadStallSpan(ask, now, "alerted", titleOf(s.memberTabId), titleOf(s.leadTabId)));
        return ok;
      });
      if (sent.length > 0) asks = markLeadAlerted(asks, sent);
    };
    const timer = setInterval(() => {
      const tickNow = Date.now();
      try {
        runLeadStall(tickNow);
      } finally {
        publish(tickNow);
      }
      if (pending.size === 0) return;
      const { tabs: openTabs } = useTabsStore.getState();
      const open = new Set(openTabs.map((t) => t.id));
      // Una pestaña cerrada ya no debe nada.
      const live = new Map([...pending].filter(([id]) => open.has(id)));
      pending = live;
      const active = new Set(activeTabIds());
      let stallMs = parseStallMs(null);
      try {
        stallMs = parseStallMs(localStorage.getItem("ags.stallMs"));
      } catch {
        // sin localStorage: queda el plazo por defecto
      }
      const stalls = findStalls(live, {
        now: Date.now(),
        isActive: (id) => active.has(id),
        lastOutputAt,
        lastInputAt,
        screen: (id) => screenOf(id)?.lines ?? null,
      }, stallMs);
      const sent = stalls.filter((s) => {
        // No se interrumpe al orquestador a mitad de un turno: se reintenta en el próximo tic.
        if (active.has(s.fromTabId)) return false;
        const name = openTabs.find((t) => t.id === s.tabId)?.title ?? s.tabId;
        return pasteIntoTab(s.fromTabId, stallMessage(name, s), true);
      });
      if (sent.length > 0) pending = markAlerted(pending, sent);
    }, STALL_CHECK_MS);
    return () => {
      clearInterval(timer);
      off.then((fn) => fn());
    };
  }, []);

  // Tiempo activo: solo avanza mientras algún agente de la misión trabaja de verdad.
  const live = useRef({ index, missions });
  live.current = { index, missions };
  useEffect(() => {
    let pending = new Map<string, number>();
    const measureTurns = () => {
      const { index: tabToMission, missions: all } = live.current;
      const running = new Set(all.filter((m) => m.status === "running").map((m) => m.id));
      const members = new Map(useTabsStore.getState().tabs.flatMap((tab) => {
        const mission = tabToMission[tab.id];
        return mission && running.has(mission) && tab.agentId !== "bash"
          ? [[tab.id, { mission, actor: tab.title || tab.agentLabel }] as const] : [];
      }));
      for (const completed of missionTurns.sample(activitySnapshot(), members, Date.now())) {
        recordSpan(completed.mission, completed.span);
      }
    };
    let ticks = 0;
    const flush = () => {
      for (const [id, ms] of pending) invoke("mission_active_add", { missionId: id, ms }).catch(() => undefined);
      pending = new Map();
    };
    const timer = setInterval(() => {
      measureTurns();
      const { index: tabToMission, missions: all } = live.current;
      const running = new Set(all.filter((m) => m.status === "running").map((m) => m.id));
      pending = accumulate(pending, sampleWorking(tabToMission, running), ACTIVE_TICK_MS);
      ticks += 1;
      if (ticks * ACTIVE_TICK_MS >= ACTIVE_FLUSH_MS) {
        ticks = 0;
        flush();
      }
    }, ACTIVE_TICK_MS);
    return () => {
      clearInterval(timer);
      flush();
    };
  }, []);

  // Barrido de las pestañas de misiones terminadas.
  useEffect(() => {
    if (missions.length === 0) return;
    const { closeTab } = useTabsStore.getState();
    finishedMissionTabs(missions, index, tabs).forEach((id) => closeTab(id));
  }, [missions, index, tabs]);
}
