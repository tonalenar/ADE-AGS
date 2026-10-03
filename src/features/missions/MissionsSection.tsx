import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { AddIcon, AlertaToast, Button, Tooltip } from "neogestify-ui-components";

import { useSquadsStore } from "@/features/squads/store";
import { useTabsStore } from "@/features/tabs/store";

import { openMission, tabsByMission, useMissionIndex } from "./groups";
import { MissionDialog } from "./MissionDialog";
import { emptyForm } from "./missionView";
import { useMissionsStore } from "./store";
import { startMissionInTerminals } from "./terminals";
import type { MissionStatus, MissionSummary } from "./types";
import * as ipc from "./ipc";

const DOT: Record<MissionStatus, string> = {
  draft: "bg-gray-400 dark:bg-white/30",
  running: "bg-emerald-500",
  done: "bg-sky-500",
  failed: "bg-red-500",
  cancelled: "bg-gray-400 dark:bg-white/25",
};

const isArchived = (m: MissionSummary) => m.status === "done" || m.status === "cancelled" || m.status === "failed";

/**
 * Las misiones en la columna de la izquierda, agrupadas: las vivas (borradores y en curso) y,
 * plegadas, las archivadas (terminadas, canceladas o fallidas). Un clic lleva al canvas de la
 * misión; "iniciar" abre su equipo en terminales.
 */
export function MissionsSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const tabs = useTabsStore((s) => s.tabs);
  const cwd = useTabsStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.cwd ?? "");
  const missions = useMissionsStore((s) => s.missions);
  const load = useMissionsStore((s) => s.load);
  const squads = useSquadsStore((s) => s.squads);
  const roles = useSquadsStore((s) => s.roles);
  const loadSquads = useSquadsStore((s) => s.load);
  const loadRoles = useSquadsStore((s) => s.loadRoles);
  const index = useMissionIndex();
  const open = useMemo(() => tabsByMission(index, tabs), [index, tabs]);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activateTab = useTabsStore((s) => s.activateTab);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    load(workspaceId).catch(() => undefined);
    const off = listen<string>("cc-mission-changed", () => load(workspaceId).catch(() => undefined));
    return () => {
      off.then((fn) => fn());
    };
  }, [workspaceId, load]);
  useEffect(() => {
    loadSquads().catch(() => undefined);
    loadRoles().catch(() => undefined);
  }, [loadSquads, loadRoles]);

  const live = missions.filter((m) => !isArchived(m));
  const archived = missions.filter(isArchived);

  const go = (m: MissionSummary) => {
    if (openMission(m.id)) navigate("/workspace");
  };

  const start = async (m: MissionSummary) => {
    setBusy(m.id);
    try {
      const squad = squads.find((s) => s.id === m.squadId) ?? null;
      await startMissionInTerminals(m, squad, roles);
      load(workspaceId).catch(() => undefined);
      navigate("/workspace");
    } catch (e) {
      AlertaToast(t("missions.title"), String(e), "error", 7000);
    } finally {
      setBusy(null);
    }
  };

  const close = async (m: MissionSummary, how: "finish" | "cancel") => {
    try {
      await (how === "finish" ? ipc.finishMissionTerminals(m.id) : ipc.cancelMission(m.id));
      load(workspaceId).catch(() => undefined);
    } catch (e) {
      AlertaToast(t("missions.title"), String(e), "error", 6000);
    }
  };

  const row = (m: MissionSummary) => {
    const mine = open[m.id]?.length ?? 0;
    const active = !!activeTabId && open[m.id]?.includes(activeTabId);
    const runless = m.status === "running" && m.activeRunId === null;
    const terminals = (open[m.id] ?? []).map((id) => tabs.find((tab) => tab.id === id)).filter((tab) => !!tab);
    return (
      <div key={m.id}>
      <div
        className={`group/mission flex items-center gap-2 pl-3 pr-1.5 h-7 cursor-pointer
          ${active ? "bg-accent-500/10" : "hover:bg-gray-100 dark:hover:bg-white/5"}`}
        onClick={() => (m.status === "draft" ? undefined : go(m))}
        title={m.objective}>
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT[m.status]}`} />
        <span className={`flex-1 min-w-0 truncate text-[12px] ${active ? "font-semibold text-gray-900 dark:text-white" : "text-gray-700 dark:text-gray-300"}`}>
          {m.title}
        </span>
        {mine > 0 && <span className="text-[10px] tabular-nums text-gray-400 dark:text-white/35">{mine}</span>}
        {m.status === "draft" && (
          <Button variant="custom" disabled={busy === m.id}
            onClick={(e) => { e.stopPropagation(); void start(m); }}
            className="cc-t h-5 px-1.5 rounded text-[10px] font-medium text-accent-600 dark:text-accent-300 hover:bg-accent-500/15">
            {busy === m.id ? "…" : t("missions.sidebar.start")}
          </Button>
        )}
        {runless && (
          <span className="hidden group-hover/mission:flex items-center gap-0.5">
            <Button variant="custom" onClick={(e) => { e.stopPropagation(); void close(m, "finish"); }}
              title={t("missions.sidebar.finishHint")}
              className="cc-t h-5 px-1.5 rounded text-[10px] text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
              {t("missions.sidebar.finish")}
            </Button>
          </span>
        )}
      </div>
      {/* Sus terminales, agrupadas debajo: cada una con lo que hace. */}
      {terminals.map((tab) => (
        <button key={tab!.id} type="button"
          onClick={() => { activateTab(tab!.id); navigate("/workspace"); }}
          className={`flex items-center gap-2 w-full h-6 pl-7 pr-2 text-left text-[11.5px] ${tab!.id === activeTabId
            ? "text-gray-900 dark:text-white bg-accent-500/10"
            : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5"}`}>
          <span className="w-1 h-1 rounded-full bg-gray-400 dark:bg-white/30 shrink-0" />
          <span className="truncate">{tab!.title}</span>
        </button>
      ))}
      </div>
    );
  };

  return (
    <div className="shrink-0 border-b border-gray-200 dark:border-white/7">
      <div className="flex items-center gap-2 h-7 pl-3 pr-1.5">
        <span className="flex-1 text-[10.5px] font-bold uppercase tracking-[0.09em] text-gray-500 dark:text-gray-400">
          {t("missions.title")}
        </span>
        <Tooltip content={t("missions.new")} placement="bottom">
          <Button variant="icon" onClick={() => setCreating(true)} disabled={!cwd}
            className="cc-t flex items-center justify-center w-5.5 h-5.5 rounded-md shrink-0 text-gray-400 dark:text-white/35
              hover:text-gray-700 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10 p-0 disabled:opacity-40">
            <AddIcon className="w-3.5 h-3.5" />
          </Button>
        </Tooltip>
      </div>

      {live.length === 0 ? (
        <p className="px-3 pb-2 text-[11px] leading-relaxed text-gray-400 dark:text-white/30">{t("missions.sidebar.empty")}</p>
      ) : live.map(row)}

      {archived.length > 0 && (
        <>
          <button type="button" onClick={() => setShowArchived((v) => !v)}
            className="flex items-center gap-1.5 w-full h-6 pl-3 text-[10px] font-bold uppercase tracking-[0.09em] text-gray-400 dark:text-white/30 hover:text-gray-600 dark:hover:text-white/60">
            <span>{showArchived ? "▾" : "▸"}</span>
            {t("missions.sidebar.archived")}
            <span className="tabular-nums font-normal">{archived.length}</span>
          </button>
          {showArchived && archived.map(row)}
        </>
      )}

      {creating && (
        <MissionDialog
          initial={emptyForm(cwd)}
          editing={false}
          onClose={() => setCreating(false)}
          onSave={async (input) => {
            await useMissionsStore.getState().create(workspaceId, input);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}
