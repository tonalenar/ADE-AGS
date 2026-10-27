import { create } from "zustand";

/** As seções da tela de Configurações (a barra lateral da prancheta 5). */
export type SettingsSectionId = "general" | "appearance" | "accounts" | "agents" | "memory" | "terminal" | "shortcuts" | "decisions" | "advanced";

/** O que a gaveta da direita mostra (abre pelos botões do canto de cima, ver `PanelButtons`). */
export type ExplorerView = "files" | "search" | "scm";

interface UiState {
  /** Panel izquierdo (workspaces) plegado: queda solo el riel de iconos. */
  workspacesCollapsed: boolean;
  /** O painel da sessão (Ambiente, Contexto, Conectores, Alterações, Tarefas) escondido. */
  sidePanelHidden: boolean;
  /** A gaveta aberta por cima do conteúdo (arquivos, busca ou git); `null` = fechada. Não é lembrada:
   *  abre quando se pede e fecha ao clicar fora. */
  drawer: ExplorerView | null;
  /** Columna de repositorios del marketplace plegada, para que las skills se lleven
   *  todo el ancho: gestionar repos es algo que se hace de vez en cuando. */
  marketplaceReposCollapsed: boolean;
  /** Riel con los nombres de cada sección al lado del ícono, en vez de solo íconos. */
  railExpanded: boolean;
  /**
   * PEDIDOS de abrir Configurações / Contas (vêm do atalho, da paleta e de vários botões). Quem os
   * atende é o AppShell: navega para `/settings` e os apaga. Configurações é uma ROTA — antes era um
   * modal solto por cima de tudo e, aberto, ficava preso por cima das outras telas.
   */
  settingsOpen: boolean;
  /** Pedido de abrir Contas: agora é uma seção das Configurações. */
  accountsOpen: boolean;
  /** Pedido de abrir a página de Missões já com esta missão escolhida (a página o consome e limpa). */
  missionRequest: string | null;
  requestMission: (id: string | null) => void;
  /** Qual seção das Configurações está aberta. */
  settingsSection: SettingsSectionId;
  setSettingsSection: (section: SettingsSectionId) => void;
  /** La paleta de comandos (Ctrl+K). */
  paletteOpen: boolean;

  toggleWorkspaces: () => void;
  toggleSidePanel: () => void;
  /** Abre a gaveta NESTA vista; apertar a que já está aberta a fecha, como numa barra de atividades. */
  openDrawer: (view: ExplorerView) => void;
  closeDrawer: () => void;
  toggleMarketplaceRepos: () => void;
  setSettingsOpen: (open: boolean) => void;
  setAccountsOpen: (open: boolean) => void;
  toggleRail: () => void;
  setPaletteOpen: (open: boolean) => void;
}

const KEY = "cc-ui-panels";

/** Se recuerda entre arranques: que un panel que plegaste vuelva abierto cada vez es de
 *  las cosas que más molestan de una app de trabajo. */
function load(): Pick<UiState, "workspacesCollapsed" | "sidePanelHidden" | "marketplaceReposCollapsed" | "railExpanded"> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UiState>;
      return {
        workspacesCollapsed: Boolean(parsed.workspacesCollapsed),
        sidePanelHidden: Boolean(parsed.sidePanelHidden),
        marketplaceReposCollapsed: Boolean(parsed.marketplaceReposCollapsed),
        railExpanded: Boolean(parsed.railExpanded),
      };
    }
  } catch {
    /* localStorage puede fallar o traer basura; los valores por defecto sirven igual */
  }
  return { workspacesCollapsed: false, sidePanelHidden: false, marketplaceReposCollapsed: false, railExpanded: false };
}

function persist(state: UiState) {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      workspacesCollapsed: state.workspacesCollapsed,
      sidePanelHidden: state.sidePanelHidden,
      marketplaceReposCollapsed: state.marketplaceReposCollapsed,
      railExpanded: state.railExpanded,
    }));
  } catch {
    /* no poder recordarlo no es motivo para no plegarlo */
  }
}

export const useUiStore = create<UiState>((set, get) => ({
  ...load(),
  missionRequest: null,
  requestMission: (missionRequest) => set({ missionRequest }),
  settingsOpen: false,
  accountsOpen: false,
  settingsSection: "general",
  paletteOpen: false,

  toggleWorkspaces: () => {
    set({ workspacesCollapsed: !get().workspacesCollapsed });
    persist(get());
  },
  toggleSidePanel: () => {
    set({ sidePanelHidden: !get().sidePanelHidden });
    persist(get());
  },
  drawer: null,
  openDrawer: (view) => set({ drawer: get().drawer === view ? null : view }),
  closeDrawer: () => set({ drawer: null }),
  toggleMarketplaceRepos: () => {
    set({ marketplaceReposCollapsed: !get().marketplaceReposCollapsed });
    persist(get());
  },
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setAccountsOpen: (accountsOpen) => set({ accountsOpen }),
  toggleRail: () => {
    set({ railExpanded: !get().railExpanded });
    persist(get());
  },
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
}));
