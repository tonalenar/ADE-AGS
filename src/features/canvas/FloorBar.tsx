import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertaToast, Button } from "neogestify-ui-components";

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
 * No se borran desde acá: descartar un worktree con trabajo adentro no tiene vuelta atrás.
 * La ruta se ve al pasar el mouse, para quien quiera quitarlo con `git worktree remove`.
 */
export function FloorBar() {
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

  const pill = (isActive: boolean) =>
    `cc-t h-6 px-2.5 rounded-md text-[11.5px] font-medium max-w-40 truncate
     ${isActive
       ? "bg-white dark:bg-white/12 text-gray-900 dark:text-white shadow-sm"
       : "text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"}`;

  return (
    <div className="pointer-events-auto absolute left-3 top-3 flex items-center gap-0.5 p-0.5 rounded-lg
      border border-gray-200 dark:border-white/10 bg-gray-100/95 dark:bg-surface-raised/95 shadow-sm">
      <Button variant="custom" className={pill(same(active.cwd, list.ground))}
        onClick={() => enter(list.ground)} title={`${t("canvas.floor.groundHint")}\n${list.ground}`}>
        {t("canvas.floor.ground")}
      </Button>
      {list.floors.map((floor) => (
        <Button key={floor.id} variant="custom" className={pill(same(active.cwd, floor.cwd))}
          onClick={() => enter(floor.cwd)} title={`${floor.branch}\n${floor.cwd}`}>
          {floor.name}
        </Button>
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
