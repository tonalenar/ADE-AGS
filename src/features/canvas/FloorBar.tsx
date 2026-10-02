import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertaToast, Button, CloseIcon } from "neogestify-ui-components";

import { useTabsStore } from "@/features/tabs/store";
import { comparablePath } from "@/features/tabs/viewTabs";

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

const same = (a: string, b: string) => comparablePath(a).replace(/\/+$/, "") === comparablePath(b).replace(/\/+$/, "");

/**
 * Los pisos del proyecto del agente activo: la planta baja y cada copia aislada (worktree +
 * rama) con su propio canvas.
 *
 * Cambiar de piso es ir a una tab de esa carpeta —el canvas ya es uno por carpeta—. Si el
 * piso no tiene ninguna, se abre un agente del mismo tipo que el activo: sin tab no hay
 * canvas que mostrar, y un piso vacío sin nada que hacer no sirve.
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
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  /** El piso que espera confirmación de borrado (se desarma solo a los 3 s). */
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(null), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  // La lista se vuelve a pedir al cambiar de carpeta y cuando algo crea un piso (un agente
  // con `ccode floor create`, otra ventana).
  useEffect(() => {
    if (!cwd) return;
    let alive = true;
    const load = () => invoke<FloorList>("floor_list", { cwd }).then((l) => alive && setList(l)).catch(() => undefined);
    load();
    const off = listen("cc-floors-changed", load);
    return () => {
      alive = false;
      off.then((fn) => fn());
    };
  }, [cwd]);

  useEffect(() => {
    if (adding) input.current?.focus();
  }, [adding]);

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

  const create = async () => {
    const wanted = name.trim();
    if (!wanted || busy) return;
    setBusy(true);
    try {
      const floor = await invoke<Floor>("floor_create", { cwd: active.cwd, name: wanted });
      setList(await invoke<FloorList>("floor_list", { cwd: active.cwd }));
      setName("");
      setAdding(false);
      enter(floor.cwd);
    } catch (e) {
      AlertaToast(t("canvas.floor.title"), String(e), "error", 7000);
    } finally {
      setBusy(false);
    }
  };

  const drop = async (floor: Floor) => {
    if (armed !== floor.id) {
      setArmed(floor.id);
      return;
    }
    setArmed(null);
    if (useTabsStore.getState().tabs.some((tab) => same(tab.cwd, floor.cwd))) {
      AlertaToast(t("canvas.floor.title"), t("canvas.floor.inUse"), "warning", 6000);
      return;
    }
    setBusy(true);
    try {
      const dropped = await invoke<{ name: string; branch: string; branchKept: boolean }>("floor_delete", { id: floor.id });
      setList(await invoke<FloorList>("floor_list", { cwd: active.cwd }));
      AlertaToast(t("canvas.floor.title"), t(dropped.branchKept ? "canvas.floor.deletedKept" : "canvas.floor.deleted", { name: dropped.name, branch: dropped.branch }), "info", 7000);
    } catch (e) {
      AlertaToast(t("canvas.floor.title"), String(e), "error", 9000);
    } finally {
      setBusy(false);
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
      {list.floors.map((floor) => (
        <span key={floor.id} className="group/floor relative inline-flex items-center">
          <Button variant="custom" className={pill(same(active.cwd, floor.cwd))}
            onClick={() => enter(floor.cwd)} title={`${floor.branch}\n${floor.cwd}`}>
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
      ))}
      {adding ? (
        <input
          ref={input}
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
            if (e.key === "Escape") { setAdding(false); setName(""); }
          }}
          onBlur={() => { if (!busy && !name.trim()) setAdding(false); }}
          placeholder={t("canvas.floor.namePlaceholder")}
          maxLength={40}
          aria-label={t("canvas.floor.name")}
          className="h-6 w-36 px-2 rounded-md text-[11.5px] outline-none bg-white dark:bg-white/8
            border border-accent-400 text-gray-800 dark:text-gray-100"
        />
      ) : (
        <Button variant="custom" className={pill(false)} onClick={() => setAdding(true)} title={t("canvas.floor.addHint")}>
          {t("canvas.floor.add")}
        </Button>
      )}
    </div>
  );
}
