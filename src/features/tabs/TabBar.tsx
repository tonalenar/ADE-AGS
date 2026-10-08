import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button, AddIcon } from "neogestify-ui-components";

import { WindowLights } from "@/app/WindowLights";
import { GlobeIcon, SplitRightIcon } from "@/app/icons";
import { GroupTabStrip } from "@/features/tabs/GroupTabStrip";
import { splitGroup, useWorkspaceLayout } from "@/features/tabs/layout/layoutStore";
import { agentKey, allGroups, isAgentKey, keyId, viewKey } from "@/features/tabs/layout/layoutTree";
import { useTabsStore } from "@/features/tabs/store";
import { openNewAgentWizard, TabDialogs } from "@/features/tabs/tabActions";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { viewsOfWorkspace } from "@/features/tabs/viewTabs";
import { tabsOfWorkspace } from "@/features/tabs/workspaceTabs";
import { ModeToggle } from "@/features/canvas/ModeToggle";
import { useWorkMode } from "@/features/canvas/store";
import { MissionChips } from "@/features/missions/MissionChips";
import { useActiveGroup, useMissionIndex } from "@/features/missions/groups";

// Botones de la franja: pastillas de 28px centradas en la barra, como los controles de la
// barra de herramientas de macOS.
const BAR_BUTTON = `flex items-center justify-center h-7 self-center shrink-0 rounded-md
  text-gray-400 dark:text-white/35
  hover:text-gray-600 dark:hover:text-white/80
  hover:bg-gray-200/60 dark:hover:bg-white/[0.08]
  transition-colors duration-150`;

/**
 * Las tabs del workspace activo, dentro de la barra de título.
 *
 * Solo las de ESE workspace: el workspace es el tab de orden superior y sus agentes son
 * las tabs de adentro. Mostrar las de todas las carpetas a la vez volvía a mezclar lo que
 * el panel izquierdo separa, y con varios proyectos abiertos la barra no entraba.
 *
 * Con la pantalla dividida, cada grupo lleva su propia tira arriba de su contenido (ver
 * `EditorArea`) y acá quedan solo los botones de abrir, que abren en el grupo enfocado.
 */
/** `showLights`: con el panel izquierdo plegado su encabezado queda en 48px y los tres
 *  botones de ventana no entran, así que se mudan acá, al principio de la tira. */
export function TabBar({ showLights = false }: { showLights?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const views = useViewTabsStore((s) => s.views);
  const activeViewId = useViewTabsStore((s) => s.activeViewId);
  const openBrowser = useViewTabsStore((s) => s.openBrowser);
  const showTerminal = useViewTabsStore((s) => s.showTerminal);
  const layout = useWorkspaceLayout();
  // En el canvas no hay grupos: dividir no aplica.
  const canvas = useWorkMode() === "canvas";

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  // El grupo que se mira: una misión (sus terminales) o lo suelto.
  const missionOf = useMissionIndex();
  const group = useActiveGroup();
  const inGroup = (key: string) => (isAgentKey(key) ? (missionOf[keyId(key)] ?? null) === group : group === null);
  const groups = layout ? allGroups(layout.root) : [];
  const only = groups.length === 1 ? groups[0]! : null;
  const divided = groups.length > 1;

  // Sin árbol todavía (las tabs cargando) se muestran como siempre: agentes y después vistas.
  const fallbackViews = viewsOfWorkspace(views, activeTab?.cwd ?? null);
  const items = (only?.items ?? [
    ...tabsOfWorkspace(tabs, activeTabId).map((tab) => agentKey(tab.id)),
    ...fallbackViews.map((v) => viewKey(v.id)),
  ]).filter(inGroup);
  const fallbackActive = fallbackViews.some((v) => v.id === activeViewId)
    ? viewKey(activeViewId!)
    : activeTab ? agentKey(activeTab.id) : null;

  return (
    <>
      <div
        data-tauri-drag-region
        data-tab-strip={only?.id}
        // Las pestañas van como pastillas dentro de la franja: un poco de aire arriba, abajo y
        // entre ellas (gap-1), y se estiran a la altura interior.
        className="cc-scroll-x flex items-stretch gap-1 px-1.5 py-1.5 flex-1 min-w-0 h-10
          bg-gray-100/80 dark:bg-surface-deep/75 backdrop-blur-xl
          border-b border-gray-200 dark:border-white/[0.08]"
        style={{ position: "relative", zIndex: 0 }}
      >
        {showLights && (
          <div className="flex items-center shrink-0 pl-3.5 pr-2" data-tauri-drag-region>
            <WindowLights />
          </div>
        )}

        <MissionChips />

        {/* Con una misión en el canvas, las terminales ya se ven como nodos y no van en la tira:
            quedan «Canvas» (volver) y las vistas del workspace (navegador, archivos, diffs). */}
        {canvas && group !== null && (
          <>
            <button
              type="button"
              data-tauri-drag-region="false"
              aria-pressed={activeViewId === null}
              aria-label={t("canvas.mode.canvas")}
              onClick={() => { showTerminal(); navigate("/workspace"); }}
              className={`${BAR_BUTTON} shrink-0 px-3 text-xs font-medium ${activeViewId === null ? "text-gray-900 dark:text-white bg-gray-200/70 dark:bg-white/[0.08]" : ""}`}
            >
              {t("canvas.mode.canvas")}
            </button>
            {fallbackViews.length > 0 && (
              <GroupTabStrip
                items={fallbackViews.map((v) => viewKey(v.id))}
                active={fallbackViews.some((v) => v.id === activeViewId) ? viewKey(activeViewId!) : null}
                groupFocused
                draggable={false}
              />
            )}
          </>
        )}

        {!divided && !(canvas && group !== null) && (
          <GroupTabStrip
            items={items}
            active={only ? only.active : fallbackActive}
            groupFocused
            draggable={only !== null}
          />
        )}

        <Button variant="icon"
          // Sin workspace abierto no hay carpeta donde abrir un agente: eso es empezar uno
          // nuevo, y eso vive en Home.
          onClick={() => (activeTab ? openNewAgentWizard() : navigate("/"))}
          title={t("tabs.new")}
          data-tauri-drag-region="false"
          className={`${BAR_BUTTON} w-7 p-0`}
        >
          <AddIcon className="w-5 h-5" />
        </Button>
        {activeTab && (
          <Button variant="icon"
            // Un navegador es del workspace: se abre al lado de sus agentes, para probar lo
            // que están construyendo.
            onClick={() => {
              openBrowser(activeTab.cwd);
              navigate("/workspace");
            }}
            title={t("tabs.newBrowser")}
            data-tauri-drag-region="false"
            className={`${BAR_BUTTON} w-7 p-0`}
          >
            <GlobeIcon className="w-4 h-4" />
          </Button>
        )}
        {only && !canvas && (
          <Button variant="icon"
            onClick={(e) => {
              splitGroup(only.id, e.altKey ? "down" : "right", only.active);
              navigate("/workspace");
            }}
            title={t("tabs.split.button")}
            data-tauri-drag-region="false"
            className={`${BAR_BUTTON} w-7 p-0`}
          >
            <SplitRightIcon className="w-4 h-4" />
          </Button>
        )}

        {/* El resto de la franja es para arrastrar la ventana. */}
        <div className="flex-1 h-full" data-tauri-drag-region />
        {activeTab && <ModeToggle />}
      </div>

      <TabDialogs />
    </>
  );
}
