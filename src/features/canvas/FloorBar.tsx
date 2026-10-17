import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button, CloseIcon } from "neogestify-ui-components";
import { AlertaToast } from "@/shared/ui/alerts";

import { useTabsStore } from "@/features/tabs/store";
import { openNewAgentWith } from "@/features/tabs/tabActions";
import { comparablePath } from "@/features/tabs/viewTabs";
import { ContextMenu } from "@/shared/ui/ContextMenu";

import { floorBadge, type LandPreview, type LandResult } from "./floorsModel";
import { LandFloorDialog } from "./LandFloorDialog";
import { NewFloorDialog } from "./NewFloorDialog";

interface Floor {
  id: string;
  name: string;
  branch: string;
  cwd: string;
}

interface FloorList {
  ground: string;
  floors: Floor[];
}

const inside = (cwd: string, folder: string) => {
  const here = comparablePath(cwd).replace(/\/+$/, "");
  const root = comparablePath(folder).replace(/\/+$/, "");
  return here === root || here.startsWith(`${root}/`);
};

const same = (a: string, b: string) => comparablePath(a).replace(/\/+$/, "") === comparablePath(b).replace(/\/+$/, "");

/** Quanto vale um resumo de andar (commits à frente, sujeira) antes de pedir de novo ao git. */
const BADGE_TTL_MS = 15_000;

/**
 * Los pisos del proyecto del agente activo: la planta baja y cada copia aislada (worktree +
 * rama) con su propio canvas.
 *
 * Cambiar de piso es ir a una tab de esa carpeta —el canvas ya es uno por carpeta—. Si el
 * piso no tiene ninguna, se abre un agente del mismo tipo que el activo: sin tab no hay
 * canvas que mostrar, y un piso vacío sin nada que hacer no sirve.
 *
 * "+ Andar" abre o diálogo de criação (nome, branch nova ou existente, pastas de fora). O botão direito num
 * andar oferece aterrissar (levar o trabalho à branch do projeto), copiar o nome da branch e excluir. Passar o
 * mouse mostra um ponto: commits à frente do projeto, mudanças soltas ou conflito.
 *
 * Borrar un piso (la ×, con confirmación) descarta su worktree con las salvaguardas del
 * backend: se niega si hay cambios sin commitear, y la rama con commits propios se conserva.
 * Con agentes abiertos en el piso no se borra: se les sacaría la carpeta de debajo.
 */
export function FloorBar({ inline = false }: { inline?: boolean }) {
  const { t } = useTranslation();
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const active = tabs.find((tab) => tab.id === activeTabId);
  const cwd = active?.cwd;

  const [list, setList] = useState<FloorList | null>(null);
  const [creating, setCreating] = useState(false);
  const [landing, setLanding] = useState<Floor | null>(null);
  const [menu, setMenu] = useState<{ floor: Floor; x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [badges, setBadges] = useState<Record<string, LandPreview>>({});
  const badgeAt = useRef<Record<string, number>>({});
  /** El piso que espera confirmación de borrado (se desarma solo a los 3 s). */
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(null), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  // La lista se vuelve a pedir al cambiar de carpeta y cuando algo crea un piso (un agente
  // con `ags floor create`, otra ventana).
  useEffect(() => {
    if (!cwd) return;
    let alive = true;
    const load = () => invoke<FloorList>("floor_list", { cwd }).then((l) => alive && setList(l)).catch(() => undefined);
    load();
    const off = listen("cc-floors-changed", () => { badgeAt.current = {}; load(); });
    return () => {
      alive = false;
      off.then((fn) => fn());
    };
  }, [cwd]);

  if (!active || !list) return null;

  /** Lleva a esa carpeta: a su primera tab, o a un agente nuevo del mismo tipo. */
  const enter = (target: string) => {
    const { tabs: all, activateTab, addTab, detectedAgents } = useTabsStore.getState();
    const there = all.find((tab) => same(tab.cwd, target));
    if (there) {
      activateTab(there.id);
      return;
    }
    const agent = detectedAgents.find((a) => a.id === active.agentId);
    if (!agent) {
      AlertaToast(t("canvas.floor.title"), t("canvas.floor.noAgent"), "warning", 5000);
      return;
    }
    addTab({ cwd: target, agent, accountId: active.accountId });
  };

  const refresh = async () => setList(await invoke<FloorList>("floor_list", { cwd: active.cwd }));

  /** O resumo do andar (commits à frente, sujeira, conflito), pedido ao passar o mouse e reaproveitado por 15 s. */
  const loadBadge = (floor: Floor) => {
    const last = badgeAt.current[floor.id] ?? 0;
    if (Date.now() - last < BADGE_TTL_MS) return;
    badgeAt.current[floor.id] = Date.now();
    invoke<LandPreview>("floor_land_preview", { id: floor.id, target: null })
      .then((preview) => setBadges((cur) => ({ ...cur, [floor.id]: preview })))
      .catch(() => { delete badgeAt.current[floor.id]; });
  };

  const drop = async (floor: Floor) => {
    if (armed !== floor.id) {
      setArmed(floor.id);
      return;
    }
    setArmed(null);
    if (useTabsStore.getState().tabs.some((tab) => inside(tab.cwd, floor.cwd))) {
      AlertaToast(t("canvas.floor.title"), t("canvas.floor.inUse"), "warning", 6000);
      return;
    }
    setBusy(true);
    try {
      const dropped = await invoke<{ name: string; branch: string; branchKept: boolean }>("floor_delete", { id: floor.id });
      await refresh();
      AlertaToast(t("canvas.floor.title"), t(dropped.branchKept ? "canvas.floor.deletedKept" : "canvas.floor.deleted", { name: dropped.name, branch: dropped.branch }), "info", 7000);
    } catch (e) {
      AlertaToast(t("canvas.floor.title"), String(e), "error", 9000);
    } finally {
      setBusy(false);
    }
  };

  const landed = async (floor: Floor, result: LandResult) => {
    setLanding(null);
    badgeAt.current = {};
    setBadges({});
    await refresh().catch(() => undefined);
    AlertaToast(
      t("canvas.floor.title"),
      t(result.floorRemoved ? "canvas.floor.land.doneRemoved" : "canvas.floor.land.done", { name: floor.name, count: result.commits }),
      "info", 7000,
    );
  };

  const copyBranch = (floor: Floor) => {
    navigator.clipboard.writeText(floor.branch)
      .then(() => AlertaToast(t("canvas.floor.title"), t("canvas.floor.branchCopied", { branch: floor.branch }), "info", 3500))
      .catch(() => AlertaToast(t("canvas.floor.title"), floor.branch, "info", 6000));
  };

  const dotTone = (floor: Floor) => {
    const badge = floorBadge(badges[floor.id] ?? null);
    switch (badge.kind) {
      case "conflict": return { color: "bg-red-500", label: t("canvas.floor.badge.conflict") };
      case "dirty": return { color: "bg-amber-500", label: t("canvas.floor.badge.dirty") };
      case "ahead": return { color: "bg-accent-500", label: t("canvas.floor.badge.ahead", { count: badge.ahead }) };
      case "clean": return { color: "bg-gray-300 dark:bg-white/25", label: t("canvas.floor.badge.clean") };
      default: return null;
    }
  };

  const pill = (isActive: boolean) =>
    `cc-t h-6 px-2.5 rounded-md text-[11.5px] font-medium max-w-40 truncate
     ${isActive
       ? "bg-white dark:bg-white/12 text-gray-900 dark:text-white shadow-sm"
       : "text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"}`;

  return (
    <div className={`pointer-events-auto flex items-center gap-0.5 p-0.5 rounded-lg
      ${inline
        ? ""
        : "absolute left-3 top-3 border border-gray-200 dark:border-white/10 bg-gray-100/95 dark:bg-surface-raised/95 shadow-sm"}`}>
      <Button variant="custom" className={pill(same(active.cwd, list.ground))}
        onClick={() => enter(list.ground)} title={`${t("canvas.floor.groundHint")}\n${list.ground}`}>
        {t("canvas.floor.ground")}
      </Button>
      {list.floors.map((floor) => {
        const tone = dotTone(floor);
        return (
          <span key={floor.id} className="group/floor relative inline-flex items-center"
            onMouseEnter={() => loadBadge(floor)}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ floor, x: e.clientX, y: e.clientY }); }}>
            <Button variant="custom" className={pill(same(active.cwd, floor.cwd))}
              onClick={() => enter(floor.cwd)} title={`${floor.branch}\n${floor.cwd}${tone ? `\n${tone.label}` : ""}`}>
              {tone && <span aria-hidden className={`inline-block size-1.5 rounded-full mr-1.5 align-middle ${tone.color}`} />}
              {floor.name}
            </Button>
            <Button variant="custom" disabled={busy} onClick={() => void drop(floor)}
              title={armed === floor.id ? t("canvas.floor.deleteConfirm") : t("canvas.floor.delete")}
              aria-label={armed === floor.id ? t("canvas.floor.deleteConfirm") : t("canvas.floor.delete")}
              className={`cc-t h-5 flex items-center justify-center rounded-md
                ${armed === floor.id
                  ? "px-1.5 ml-0.5 text-[10.5px] font-medium text-white bg-red-500 hover:bg-red-600"
                  : "w-0 overflow-hidden opacity-0 group-hover/floor:w-5 group-hover/floor:opacity-100 text-gray-400 hover:text-red-500"}`}>
              {armed === floor.id ? t("canvas.floor.deleteConfirm") : <CloseIcon className="w-2.5 h-2.5" />}
            </Button>
          </span>
        );
      })}
      <Button variant="custom" className={pill(false)} onClick={() => setCreating(true)} title={t("canvas.floor.addHint")}>
        {t("canvas.floor.add")}
      </Button>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          { key: "enter", label: t("canvas.floor.menu.enter"), onSelect: () => enter(menu.floor.cwd) },
          { key: "land", label: t("canvas.floor.menu.land"), onSelect: () => setLanding(menu.floor) },
          { key: "copy", label: t("canvas.floor.menu.copyBranch"), onSelect: () => copyBranch(menu.floor) },
          { key: "delete", label: t("canvas.floor.delete"), danger: true, separator: true, onSelect: () => setArmed(menu.floor.id) },
        ]} />
      )}

      {creating && (
        <NewFloorDialog cwd={active.cwd} onClose={() => setCreating(false)}
          onCreated={(floor) => { setCreating(false); void refresh().then(() => enter(floor.cwd)).catch(() => undefined); }} />
      )}

      {landing && (
        <LandFloorDialog floor={landing} groundCwd={list.ground} onClose={() => setLanding(null)}
          onLanded={(result) => void landed(landing, result)}
          onAskAgent={(prompt) => {
            setLanding(null);
            openNewAgentWith({ cwd: landing.cwd, title: t("canvas.floor.land.askAgentTitle", { name: landing.name }), prompt });
          }} />
      )}
    </div>
  );
}
