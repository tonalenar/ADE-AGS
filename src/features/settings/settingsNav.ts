import type { SettingsSectionId } from "@/app/uiStore";

/**
 * O modelo de navegação das Configurações, sem React: o menu agrupado, o nome de cada página e a
 * lista de ajustes que a busca acha. Segue o menu do T3 Code (Geral, Aparência, Chat… e os grupos
 * Agentes, Código e Conexões); o que não tem par no T3 (memória, decisões, orquestrador, CLI…)
 * fica no grupo "ADE".
 */

/** Uma página da tela. O id é o que a `uiStore` guarda em `settingsSection`. */
export type SettingsPageId = SettingsSectionId;

export interface SettingsNavGroup {
  /** Chave do título do grupo; `null` é um grupo sem título, separado só por espaço. */
  heading: string | null;
  pages: SettingsPageId[];
}

/** A ordem do menu. Cada página aparece num grupo só (o teste de navegação confere). */
export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroup[] = [
  { heading: null, pages: ["general", "appearance", "chat", "threads", "shortcuts"] },
  { heading: "settings.nav.agents", pages: ["accounts", "browser", "devices", "scheduled", "usage"] },
  { heading: "settings.nav.code", pages: ["projects", "worktrees"] },
  { heading: "settings.nav.connections", pages: ["environments", "access"] },
  { heading: null, pages: ["maintenance", "storage", "diagnostics", "licenses", "labs"] },
  { heading: "settings.nav.ade", pages: ["memory", "decisions", "permissions", "terminal", "orchestrator", "skills", "cli"] },
];

/** O nome de cada página (chave i18n). O `Record` obriga a ter todas as páginas. */
export const SETTINGS_PAGE_LABEL_KEYS: Record<SettingsPageId, string> = {
  general: "settings.general",
  appearance: "settings.appearance",
  chat: "settings.chat",
  threads: "settings.threads",
  shortcuts: "settings.shortcuts",
  accounts: "settings.providers",
  browser: "settings.browser",
  devices: "settings.devices",
  scheduled: "settings.scheduled",
  projects: "settings.projects",
  worktrees: "settings.worktrees",
  environments: "settings.environments",
  access: "settings.access",
  maintenance: "settings.maintenance",
  storage: "settings.storage",
  diagnostics: "settings.diagnostics",
  licenses: "settings.licenses",
  usage: "settings.usage",
  labs: "settings.labs",
  memory: "settings.memory",
  decisions: "settings.decisions",
  permissions: "settings.permissions",
  terminal: "settings.terminal",
  orchestrator: "settings.orchestrator",
  skills: "settings.skills",
  cli: "settings.cli",
};

/** As páginas com o selo "Novo" no menu (a marca desta versão). */
export const NEW_SETTINGS: ReadonlySet<SettingsPageId> = new Set(["chat", "devices", "permissions"]);

/** A chave do texto de uma página (a descrição do topo). */
export function settingsPageDescKey(page: SettingsPageId): string {
  return `settings.page.${page}`;
}

/**
 * Um ajuste que a busca encontra. `anchor` é o id do bloco no DOM (`data-settings-anchor`) para onde
 * a busca rola; vários ajustes podem cair no mesmo bloco. `tab` é a aba interna, quando a página tem abas.
 */
export interface SettingsSearchItem {
  readonly id: string;
  readonly page: SettingsPageId;
  readonly tab?: string;
  readonly anchor: string;
  /** Nome do ajuste (chave i18n). */
  readonly titleKey: string;
  /** Palavras extras que também acham o ajuste (chaves i18n com o texto). */
  readonly keywordKeys?: readonly string[];
  /** Só existe em Linux (a composição de GPU). */
  readonly linuxOnly?: boolean;
}

export const SETTINGS_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  { id: "general.language", page: "general", anchor: "general-language", titleKey: "settings.language" },
  { id: "general.notifications", page: "general", anchor: "general-notifications", titleKey: "settings.notifications.label" },
  { id: "general.inAppNotifications", page: "general", anchor: "general-in-app-notifications", titleKey: "settings.inAppNotifications.label" },
  { id: "general.sidebar.working", page: "general", anchor: "general-sidebar", titleKey: "settings.sidebar.working.label" },
  { id: "general.confirm.unpin", page: "general", anchor: "general-confirmations", titleKey: "settings.confirm.unpin.label" },
  { id: "general.confirm.archive", page: "general", anchor: "general-confirmations", titleKey: "settings.confirm.archive.label" },
  { id: "general.confirm.delete", page: "general", anchor: "general-confirmations", titleKey: "settings.confirm.delete.label" },

  { id: "appearance.mode", page: "appearance", anchor: "appearance-mode", titleKey: "settings.item.theme" },
  // A composição de GPU não tem bloco próprio (só existe em Linux e some em outros sistemas): a busca rola até o grupo.
  { id: "appearance.rendering", page: "appearance", anchor: "appearance-mode", titleKey: "settings.rendering.gpu", linuxOnly: true },
  { id: "appearance.motion", page: "appearance", anchor: "appearance-motion", titleKey: "settings.motion.duration" },
  { id: "appearance.themes", page: "appearance", anchor: "appearance-themes", titleKey: "settings.themeCustom.title" },
  { id: "appearance.fonts", page: "appearance", anchor: "appearance-fonts", titleKey: "settings.typography" },

  { id: "chat.open", page: "chat", anchor: "chat-mode", titleKey: "chat.settings.onOpen" },
  { id: "chat.startMode", page: "chat", anchor: "chat-mode", titleKey: "chat.settings.startMode" },
  { id: "chat.newConversations", page: "chat", anchor: "chat-mode", titleKey: "chat.settings.newConversations" },
  { id: "chat.followUp", page: "chat", anchor: "chat-mode", titleKey: "chat.settings.followUpBehavior" },
  { id: "chat.width", page: "chat", anchor: "chat-mode", titleKey: "chat.settings.width" },
  { id: "chat.skills", page: "chat", anchor: "chat-mode", titleKey: "chat.settings.showSkillsInSlashMenu" },
  { id: "chat.compact", page: "chat", anchor: "chat-compact", titleKey: "chat.settings.claudeCompact.title" },

  { id: "threads.autoSettle", page: "threads", anchor: "threads-auto-settle", titleKey: "settings.threads.autoSettle.title", keywordKeys: ["settings.threads.autoSettle.desc"] },
  { id: "chat.snooze", page: "chat", anchor: "chat-snooze", titleKey: "chat.settings.snooze.title" },

  { id: "shortcuts", page: "shortcuts", anchor: "shortcuts-main", titleKey: "settings.shortcuts" },

  { id: "providers.accounts", page: "accounts", tab: "contas", anchor: "providers-accounts", titleKey: "settings.accounts" },
  { id: "providers.tuis", page: "accounts", tab: "tuis", anchor: "providers-tuis", titleKey: "settings.tuis" },
  { id: "providers.autoUpdate", page: "accounts", tab: "tuis", anchor: "providers-tuis", titleKey: "settings.agentUpdates.label" },
  { id: "providers.acp", page: "accounts", tab: "acp", anchor: "providers-acp", titleKey: "settings.agents.acp.tab" },

  { id: "browser.search", page: "browser", anchor: "browser-search", titleKey: "settings.browserSearch.title" },
  { id: "browser.import", page: "browser", anchor: "browser-import", titleKey: "settings.browserImport.title" },

  { id: "devices.ios", page: "devices", anchor: "devices-main", titleKey: "settings.devices.ios" },
  { id: "devices.android", page: "devices", anchor: "devices-main", titleKey: "settings.devices.android" },

  { id: "scheduled", page: "scheduled", anchor: "scheduled-main", titleKey: "settings.scheduled" },
  { id: "scheduled.tasks", page: "scheduled", anchor: "scheduled-main", titleKey: "settings.scheduled.title", keywordKeys: ["settings.scheduled.desc"] },

  { id: "projects", page: "projects", anchor: "projects-list", titleKey: "settings.projects.list.title" },
  { id: "projects.order", page: "projects", anchor: "projects-order", titleKey: "settings.projects.order.title", keywordKeys: ["settings.projects.order.desc"] },
  { id: "projects.name", page: "projects", anchor: "projects-detail", titleKey: "settings.projects.name", keywordKeys: ["settings.projects.name.hint"] },
  { id: "projects.icon", page: "projects", anchor: "projects-detail", titleKey: "settings.projects.icon", keywordKeys: ["settings.projects.icon.hint"] },
  { id: "projects.agents", page: "projects", anchor: "projects-detail", titleKey: "settings.projects.agents", keywordKeys: ["settings.projects.agents.desc"] },
  { id: "projects.remove", page: "projects", anchor: "projects-detail", titleKey: "settings.projects.remove" },

  { id: "worktrees", page: "worktrees", anchor: "worktrees-main", titleKey: "settings.worktrees.where" },

  { id: "environments.sync", page: "environments", anchor: "environments-sync", titleKey: "settings.sync" },
  { id: "environments.local", page: "environments", anchor: "environments-local", titleKey: "settings.environments.local.title" },

  { id: "access.local", page: "access", anchor: "access-local", titleKey: "settings.access.local.title" },
  { id: "access.network", page: "access", anchor: "access-network", titleKey: "settings.access.network.title" },

  { id: "maintenance.updates", page: "maintenance", anchor: "maintenance-updates", titleKey: "settings.updates" },
  { id: "usage.prices", page: "usage", anchor: "usage-prices", titleKey: "settings.usage.prices.title", keywordKeys: ["settings.usage.prices.desc"] },
  { id: "storage", page: "storage", anchor: "storage-main", titleKey: "settings.storage.title", keywordKeys: ["settings.storage.desc"] },
  { id: "storage.clean", page: "storage", anchor: "storage-main", titleKey: "settings.storage.clean.title", keywordKeys: ["settings.storage.clean.note"] },
  { id: "diagnostics", page: "diagnostics", anchor: "diagnostics-main", titleKey: "settings.diagnostics.title", keywordKeys: ["settings.diagnostics.desc"] },
  { id: "licenses", page: "licenses", anchor: "licenses-main", titleKey: "settings.licenses.title", keywordKeys: ["settings.licenses.desc"] },

  { id: "labs.graphify", page: "labs", anchor: "labs-graphify", titleKey: "settings.graphify" },

  { id: "memory.tabs", page: "memory", anchor: "memory-tabs", titleKey: "settings.aiMemoryTabs.label" },

  { id: "decisions", page: "decisions", anchor: "decisions-main", titleKey: "settings.decisions" },
  { id: "decisions.provider", page: "decisions", anchor: "decisions-main", titleKey: "settings.decisions.provider" },

  { id: "permissions", page: "permissions", anchor: "permissions-main", titleKey: "settings.permissions" },
  { id: "permissions.sandbox", page: "permissions", anchor: "permissions-sandbox", titleKey: "settings.sandbox.label" },

  { id: "terminal.zoom", page: "terminal", anchor: "terminal-main", titleKey: "settings.terminal.zoom" },
  { id: "terminal.marks", page: "terminal", anchor: "terminal-main", titleKey: "settings.terminal.marks" },

  { id: "orchestrator.mode", page: "orchestrator", tab: "orquestrador", anchor: "orchestrator-main", titleKey: "settings.orchestrator" },
  { id: "orchestrator.routing", page: "orchestrator", tab: "roteamento", anchor: "orchestrator-routing", titleKey: "settings.routing" },
  { id: "orchestrator.fixRounds", page: "orchestrator", tab: "orquestrador", anchor: "orchestrator-main", titleKey: "settings.fixRounds.label", keywordKeys: ["settings.fixRounds.desc"] },
  { id: "orchestrator.prelaunch", page: "orchestrator", tab: "prelaunch", anchor: "orchestrator-prelaunch", titleKey: "settings.prelaunch" },

  { id: "skills.dir", page: "skills", anchor: "skills-dir", titleKey: "settings.skillsDir" },
  { id: "skills.sh", page: "skills", anchor: "skills-sh", titleKey: "settings.skillssh" },

  { id: "cli", page: "cli", anchor: "cli-main", titleKey: "settings.cli" },
];

/** Minúsculas, sem acento e com um espaço só: a busca não depende de caixa nem de acento. */
export function normalizeSettingsSearch(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

/** A página casa com o texto da busca (pelo nome dela)? Vazio casa com tudo. */
export function settingsPageMatches(page: SettingsPageId, query: string, t: (key: string) => string): boolean {
  const q = normalizeSettingsSearch(query);
  if (!q) return true;
  return normalizeSettingsSearch(t(SETTINGS_PAGE_LABEL_KEYS[page])).includes(q);
}

export interface SettingsSearchResult {
  readonly item: SettingsSearchItem;
  /** 5 = o nome é igual à busca; 4 = começa com ela; 3 = contém; 2 = tem todas as palavras no nome; 1 = acha em outro campo. */
  readonly rank: number;
}

/**
 * Acha os ajustes pelo nome, pelo nome da página e pelas palavras extras. Cada palavra da busca tem
 * de aparecer em algum campo (tudo junto, em qualquer ordem). Pura: recebe o `t` e a lista.
 */
export function searchSettingsItems(
  query: string,
  t: (key: string) => string,
  options: { linux?: boolean } = {},
  items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS,
): SettingsSearchResult[] {
  const q = normalizeSettingsSearch(query);
  if (!q) return [];
  const tokens = q.split(" ");
  const linux = options.linux ?? false;
  const results: SettingsSearchResult[] = [];
  for (const item of items) {
    if (item.linuxOnly && !linux) continue;
    const title = normalizeSettingsSearch(t(item.titleKey));
    const fields = [
      title,
      normalizeSettingsSearch(t(SETTINGS_PAGE_LABEL_KEYS[item.page])),
      ...(item.keywordKeys ?? []).map((key) => normalizeSettingsSearch(t(key))),
    ];
    if (!tokens.every((token) => fields.some((field) => field.includes(token)))) continue;
    const rank = title === q ? 5
      : title.startsWith(q) ? 4
        : title.includes(q) ? 3
          : tokens.every((token) => title.includes(token)) ? 2
            : fields.some((field) => field.includes(q)) ? 1
              : 0;
    results.push({ item, rank });
  }
  // Empate de posição: a ordem da lista (que já é a do menu) vale. `sort` é estável.
  return results.sort((a, b) => b.rank - a.rank);
}
