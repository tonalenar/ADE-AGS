import { readAppearanceMode, resolveAppearanceMode, type ResolvedTheme } from "./appearanceMode";

/** Cores T3 que a ADE consegue mapear aos seus tokens de interface. */
export const THEME_COLOR_ROLES = [
  "canvas", "chrome", "toolbar", "toolbarForeground", "toolbarBorder", "toolbarControl",
  "toolbarControlForeground", "toolbarControlHover", "surface", "surfaceRaised", "surfaceOverlay",
  "text", "textMuted", "border", "input", "focus", "accent", "accentForeground", "secondary",
  "secondaryForeground", "muted", "mutedForeground", "placeholder", "secondaryLabel", "iconMuted",
  "error", "errorForeground", "errorSurface", "warning", "warningForeground", "warningSurface",
  "update", "updateForeground", "updateSurface", "accentSurface", "accentSurfaceForeground",
  "messageSurface", "messageForeground", "messageAction", "messageActionForeground", "messageActionHover",
  "codeBackground", "codeForeground", "searchMatchBackground", "searchMatchForeground",
  "searchMatchActiveBackground", "searchMatchActiveForeground", "sidebar", "sidebarForeground",
  "sidebarMutedForeground", "sidebarControlSurface", "sidebarRowHover", "sidebarRowActive",
  "sidebarRowSelected", "sidebarBorder", "terminalBackground", "terminalForeground", "terminalCursor",
  "terminalSelection", "terminalScrollbar", "terminalScrollbarHover",
] as const;

export type ThemeColorRole = typeof THEME_COLOR_ROLES[number];
export type ThemeColors = Partial<Record<ThemeColorRole, string>>;
export type ThemeAppearance = ResolvedTheme;

export interface CustomTheme {
  id: string;
  name: string;
  appearance: ThemeAppearance;
  colors: ThemeColors;
  variants?: Partial<Record<ThemeAppearance, ThemeColors>>;
}

export interface ThemePreferences {
  activeThemeId: string | null;
  themes: CustomTheme[];
}

export const THEME_PREFERENCES_KEY = "cc-custom-themes-v1";
export const CUSTOM_THEME_CHANGED_EVENT = "cc-custom-theme-changed";
const ROLE_SET = new Set<string>(THEME_COLOR_ROLES);
const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
const CSS_COLOR = /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([\da-z.%+\-/ ,]+\)$/i;
const MAX_THEMES = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Aceita cores literais, sem var()/url() ou outras expressões CSS vindas do arquivo importado. */
export function isThemeColor(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 96) return false;
  const color = value.trim();
  if (HEX_COLOR.test(color)) return true;
  if (!CSS_COLOR.test(color) || /[;{}"'\\]/.test(color)) return false;
  try {
    return typeof CSS !== "undefined" && CSS.supports("color", color);
  } catch {
    return false;
  }
}

function parseColors(value: unknown): ThemeColors {
  if (!isRecord(value)) return {};
  const colors: ThemeColors = {};
  for (const [role, color] of Object.entries(value)) {
    if (ROLE_SET.has(role) && isThemeColor(color)) colors[role as ThemeColorRole] = color.trim();
  }
  return colors;
}

function slug(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "tema";
}

function makeId(name: string): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `ade-${slug(name).slice(0, 30)}-${random}`;
}

function sanitizedTheme(value: unknown): CustomTheme | null {
  if (!isRecord(value) || typeof value.id !== "string" || !/^ade-[a-z0-9-]{1,80}$/.test(value.id)) return null;
  if (typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 48) return null;
  if (value.appearance !== "light" && value.appearance !== "dark") return null;
  const colors = parseColors(value.colors);
  if (Object.keys(colors).length === 0) return null;
  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  if (isRecord(value.variants)) {
    for (const appearance of ["light", "dark"] as const) {
      const candidate = value.variants[appearance];
      if (appearance !== value.appearance && isRecord(candidate)) {
        const variant = parseColors(candidate);
        if (Object.keys(variant).length > 0) variants[appearance] = variant;
      }
    }
  }
  return {
    id: value.id,
    name: value.name.trim(),
    appearance: value.appearance,
    colors,
    ...(Object.keys(variants).length ? { variants } : {}),
  };
}

export function readThemePreferences(): ThemePreferences {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(THEME_PREFERENCES_KEY) ?? "null");
    if (!isRecord(raw) || !Array.isArray(raw.themes)) return { activeThemeId: null, themes: [] };
    const themes = raw.themes.slice(0, MAX_THEMES).map(sanitizedTheme).filter((theme): theme is CustomTheme => !!theme);
    const ids = new Set<string>();
    const unique = themes.filter((theme) => !ids.has(theme.id) && !!ids.add(theme.id));
    const activeThemeId = typeof raw.activeThemeId === "string" && unique.some((theme) => theme.id === raw.activeThemeId)
      ? raw.activeThemeId
      : null;
    return { activeThemeId, themes: unique };
  } catch {
    return { activeThemeId: null, themes: [] };
  }
}

function writePreferences(preferences: ThemePreferences): ThemePreferences {
  const themes = preferences.themes.slice(0, MAX_THEMES).map(sanitizedTheme).filter((theme): theme is CustomTheme => !!theme);
  const activeThemeId = preferences.activeThemeId && themes.some((theme) => theme.id === preferences.activeThemeId)
    ? preferences.activeThemeId
    : null;
  const safe = { activeThemeId, themes };
  try {
    localStorage.setItem(THEME_PREFERENCES_KEY, JSON.stringify(safe));
  } catch {
    // A paleta ainda se aplica nesta janela quando o armazenamento local está indisponível.
  }
  applyCustomTheme(safe, effectiveAppearance());
  window.dispatchEvent(new Event(CUSTOM_THEME_CHANGED_EVENT));
  return safe;
}

export function addTheme(value: unknown): ThemePreferences {
  const theme = sanitizedTheme(value);
  if (!theme) throw new Error("invalid-theme");
  const current = readThemePreferences();
  const themes = [theme, ...current.themes.filter((item) => item.id !== theme.id)].slice(0, MAX_THEMES);
  return writePreferences({ activeThemeId: theme.id, themes });
}

export function starterColors(appearance: ThemeAppearance): ThemeColors {
  if (appearance === "dark") return {
    canvas: "#0f0f11", chrome: "#151517", toolbar: "#1c1c1e", surface: "#1c1c1e",
    surfaceRaised: "#2c2c2e", surfaceOverlay: "#3a3a3c", text: "#f3f3f4", textMuted: "#a1a1a6",
    border: "#3a3a3c", input: "#151517", focus: "#8cb0ca", accent: "#496e87",
    accentForeground: "#ffffff", sidebar: "#151517", sidebarForeground: "#f3f3f4",
    sidebarBorder: "#303034", terminalBackground: "#101012", terminalForeground: "#e6e7ea",
    terminalCursor: "#8cb0ca", terminalSelection: "#8cb0ca40", codeBackground: "#151517",
    codeForeground: "#e6e7ea", messageSurface: "#252528", messageForeground: "#f3f3f4",
  };
  return {
    canvas: "#f5f5f7", chrome: "#fafafa", toolbar: "#ffffff", surface: "#ffffff",
    surfaceRaised: "#ffffff", surfaceOverlay: "#f0f0f2", text: "#17181b", textMuted: "#65666b",
    border: "#dedee2", input: "#f5f5f7", focus: "#496e87", accent: "#496e87",
    accentForeground: "#ffffff", sidebar: "#f6f6f7", sidebarForeground: "#17181b",
    sidebarBorder: "#dedee2", terminalBackground: "#f3f4f6", terminalForeground: "#17181b",
    terminalCursor: "#496e87", terminalSelection: "#496e8733", codeBackground: "#f3f4f6",
    codeForeground: "#17181b", messageSurface: "#ebebed", messageForeground: "#17181b",
  };
}

export function createTheme(name = "Minha paleta"): ThemePreferences {
  const theme: CustomTheme = {
    id: makeId(name), name: name.trim().slice(0, 48) || "Minha paleta", appearance: "dark",
    colors: starterColors("dark"), variants: { light: starterColors("light") },
  };
  return addTheme(theme);
}

export function updateTheme(themeId: string, update: (theme: CustomTheme) => CustomTheme): ThemePreferences {
  const current = readThemePreferences();
  const themes = current.themes.map((theme) => theme.id === themeId ? update(theme) : theme);
  return writePreferences({ ...current, themes });
}

export function selectTheme(activeThemeId: string | null): ThemePreferences {
  return writePreferences({ ...readThemePreferences(), activeThemeId });
}

export function removeTheme(themeId: string): ThemePreferences {
  const current = readThemePreferences();
  const themes = current.themes.filter((theme) => theme.id !== themeId);
  return writePreferences({ activeThemeId: current.activeThemeId === themeId ? null : current.activeThemeId, themes });
}

function mappedVscodeColors(source: Record<string, unknown>): ThemeColors {
  const colors: ThemeColors = {};
  const mappings: Array<[ThemeColorRole, string[]]> = [
    ["canvas", ["editor.background", "sideBar.background"]],
    ["chrome", ["titleBar.activeBackground", "activityBar.background"]],
    ["toolbar", ["activityBar.background", "statusBar.background"]],
    ["surface", ["panel.background", "sideBar.background"]],
    ["surfaceRaised", ["editorWidget.background", "dropdown.background"]],
    ["surfaceOverlay", ["menu.background", "list.hoverBackground"]],
    ["text", ["editor.foreground", "foreground"]],
    ["textMuted", ["descriptionForeground", "editorLineNumber.foreground", "sideBar.foreground"]],
    ["border", ["panel.border", "sideBar.border", "editorGroup.border"]],
    ["input", ["input.background"]],
    ["focus", ["focusBorder"]],
    ["accent", ["button.background", "progressBar.background", "activityBar.activeBorder"]],
    ["accentForeground", ["button.foreground"]],
    ["sidebar", ["sideBar.background"]],
    ["sidebarForeground", ["sideBar.foreground"]],
    ["sidebarBorder", ["sideBar.border"]],
    ["terminalBackground", ["terminal.background", "editor.background"]],
    ["terminalForeground", ["terminal.foreground", "editor.foreground"]],
    ["terminalCursor", ["terminalCursor.foreground"]],
    ["terminalSelection", ["terminal.selectionBackground", "editor.selectionBackground"]],
    ["codeBackground", ["editor.background"]],
    ["codeForeground", ["editor.foreground"]],
  ];
  for (const [role, keys] of mappings) {
    const value = keys.map((key) => source[key]).find(isThemeColor);
    if (value) colors[role] = value;
  }
  return colors;
}

/** Importa o formato T3 v1 ou um tema VS Code (seção `colors`). */
export function parseThemeImport(input: unknown): CustomTheme {
  if (!isRecord(input)) throw new Error("invalid-theme");
  if (input.version === 1 && typeof input.name === "string" && (input.appearance === "light" || input.appearance === "dark")) {
    const colors = parseColors(input.colors);
    if (!Object.keys(colors).length) throw new Error("invalid-theme");
    const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
    if (isRecord(input.variants)) {
      for (const mode of ["light", "dark"] as const) {
        if (mode !== input.appearance) {
          const variant = parseColors(input.variants[mode]);
          if (Object.keys(variant).length) variants[mode] = variant;
        }
      }
    }
    const name = input.name.trim().slice(0, 48) || "Tema importado";
    return { id: makeId(name), name, appearance: input.appearance, colors, ...(Object.keys(variants).length ? { variants } : {}) };
  }
  if (isRecord(input.colors)) {
    const colors = mappedVscodeColors(input.colors);
    if (!Object.keys(colors).length) throw new Error("invalid-theme");
    const type = input.type === "light" || input.type === "hcLight" ? "light" : "dark";
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 48) : "Tema VS Code";
    return { id: makeId(name), name, appearance: type, colors };
  }
  throw new Error("invalid-theme");
}

export function exportThemeFile(theme: CustomTheme): string {
  const { id, name, appearance, colors, variants } = theme;
  return `${JSON.stringify({ version: 1, id: slug(id), name: name.slice(0, 48), appearance, colors, ...(variants ? { variants } : {}) }, null, 2)}\n`;
}

export function colorsForTheme(theme: CustomTheme, appearance: ThemeAppearance): ThemeColors | null {
  if (theme.appearance === appearance) return theme.colors;
  return theme.variants?.[appearance] ?? null;
}

function effectiveAppearance(): ThemeAppearance {
  const systemDark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  return resolveAppearanceMode(readAppearanceMode(), systemDark);
}

const INLINE_PROPERTIES = [
  "--ade-theme-canvas", "--ade-theme-chrome", "--ade-theme-toolbar", "--ade-theme-text", "--ade-theme-text-muted",
  "--ade-theme-border", "--ade-theme-input", "--ade-theme-focus", "--ade-theme-accent", "--ade-theme-accent-foreground",
  "--ade-theme-sidebar", "--ade-theme-sidebar-foreground", "--ade-theme-message-surface", "--ade-theme-message-foreground",
  "--ade-theme-code-background", "--ade-theme-code-foreground", "--ade-terminal-background", "--ade-terminal-foreground",
  "--ade-terminal-cursor", "--ade-terminal-selection", "--color-surface-deep", "--color-surface-sunken", "--color-surface",
  "--color-surface-raised", "--color-surface-overlay", "--color-accent-400", "--color-accent-500", "--color-accent-600",
  "--color-accent-700", "--color-accent-800", "--color-accent-50", "--color-accent-100", "--color-accent-200", "--color-accent-300",
  "--color-accent-900", "--color-accent-950", "--nui-accent", "--nui-accent-hover", "--nui-accent-text", "--nui-ring",
  "--nui-accent-fg", "--nui-accent-fg-dark", "--nui-accent-dark", "--nui-accent-hover-dark", "--nui-accent-text-dark",
  "--nui-accent-text-hover", "--nui-accent-text-hover-dark", "--nui-ring-dark", "--nui-surface", "--nui-surface-dark",
  "--nui-surface-muted", "--nui-surface-muted-dark", "--nui-surface-sunken-dark", "--nui-surface-band-dark",
  "--nui-accent-soft", "--nui-accent-soft-dark", "--nui-surface-hover-dark",
  "--nui-border", "--nui-border-dark", "--nui-text", "--nui-text-dark", "--nui-text-muted", "--nui-text-muted-dark",
  "--color-gray-50", "--color-gray-100", "--color-gray-200", "--color-gray-300", "--color-gray-400", "--color-gray-500",
  "--color-gray-600", "--color-gray-700", "--color-gray-800", "--color-gray-900", "--color-gray-950",
];

function applyCustomTheme(preferences: ThemePreferences, appearance: ThemeAppearance): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const theme = preferences.themes.find((item) => item.id === preferences.activeThemeId);
  const colors = theme ? colorsForTheme(theme, appearance) : null;
  if (!colors) {
    delete root.dataset.adeCustomTheme;
    for (const role of THEME_COLOR_ROLES) {
      root.style.removeProperty(`--ade-theme-${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
    }
    for (const property of INLINE_PROPERTIES) root.style.removeProperty(property);
    return;
  }
  for (const property of INLINE_PROPERTIES) root.style.removeProperty(property);
  for (const role of THEME_COLOR_ROLES) {
    root.style.removeProperty(`--ade-theme-${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  root.dataset.adeCustomTheme = theme!.id;
  for (const [role, value] of Object.entries(colors)) {
    if (isThemeColor(value)) root.style.setProperty(`--ade-theme-${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value);
  }
  const set = (property: string, value: string | undefined) => { if (value) root.style.setProperty(property, value); };
  set("--color-surface-deep", colors.canvas);
  set("--color-surface-sunken", colors.sidebar ?? colors.chrome ?? colors.surface);
  set("--color-surface", colors.surface ?? colors.canvas);
  set("--color-surface-raised", colors.surfaceRaised ?? colors.surface);
  set("--color-surface-overlay", colors.surfaceOverlay ?? colors.surfaceRaised ?? colors.surface);
  set("--color-gray-50", appearance === "dark" ? colors.text : colors.canvas);
  set("--color-gray-100", appearance === "dark" ? colors.surface : colors.canvas);
  set("--color-gray-200", appearance === "dark" ? colors.surfaceRaised ?? colors.border : colors.border);
  set("--color-gray-300", colors.border);
  set("--color-gray-400", colors.textMuted);
  set("--color-gray-500", colors.textMuted);
  set("--color-gray-600", colors.textMuted ?? colors.text);
  set("--color-gray-700", colors.text);
  set("--color-gray-800", colors.text);
  set("--color-gray-900", colors.text);
  set("--color-gray-950", appearance === "dark" ? colors.canvas : colors.text);
  set("--color-accent-50", colors.accentSurface);
  set("--color-accent-100", colors.accentSurface);
  set("--color-accent-200", colors.accentSurface);
  set("--color-accent-300", colors.accent);
  set("--color-accent-400", colors.accent);
  set("--color-accent-500", colors.accent);
  set("--color-accent-600", colors.accent);
  set("--color-accent-700", colors.accent);
  set("--color-accent-800", colors.accentSurfaceForeground ?? colors.accent);
  set("--color-accent-900", colors.accentSurfaceForeground ?? colors.accent);
  set("--color-accent-950", colors.accentSurfaceForeground ?? colors.accent);
  set("--nui-accent", colors.accent);
  set("--nui-accent-hover", colors.accent);
  set("--nui-accent-text", colors.accent);
  set("--nui-accent-text-hover", colors.accent);
  set("--nui-accent-dark", colors.accent);
  set("--nui-accent-hover-dark", colors.accent);
  set("--nui-accent-text-dark", colors.accent);
  set("--nui-accent-text-hover-dark", colors.accent);
  set("--nui-accent-soft", colors.accentSurface);
  set("--nui-accent-soft-dark", colors.accentSurface);
  set("--nui-surface-hover-dark", colors.sidebarRowHover);
  set("--nui-accent-fg", colors.accentForeground);
  set("--nui-accent-fg-dark", colors.accentForeground);
  set("--nui-ring", colors.focus ?? colors.accent);
  set("--nui-ring-dark", colors.focus ?? colors.accent);
  set("--nui-surface", colors.surface);
  set("--nui-surface-dark", colors.surface);
  set("--nui-surface-muted", colors.chrome ?? colors.surface);
  set("--nui-surface-muted-dark", colors.chrome ?? colors.surface);
  set("--nui-surface-sunken-dark", colors.canvas);
  set("--nui-surface-band-dark", colors.chrome ?? colors.surface);
  set("--nui-border", colors.border);
  set("--nui-border-dark", colors.border);
  set("--nui-text", colors.text);
  set("--nui-text-dark", colors.text);
  set("--nui-text-muted", colors.textMuted);
  set("--nui-text-muted-dark", colors.textMuted);
  set("--ade-terminal-background", colors.terminalBackground ?? colors.canvas);
  set("--ade-terminal-foreground", colors.terminalForeground ?? colors.text);
  set("--ade-terminal-cursor", colors.terminalCursor ?? colors.focus ?? colors.accent);
  set("--ade-terminal-selection", colors.terminalSelection);
}

export function applyThemePreferencesForCurrentAppearance(): void {
  applyCustomTheme(readThemePreferences(), effectiveAppearance());
}

/** Tema acompanha modo claro/escuro e alterações feitas por outra janela do app. */
if (typeof window !== "undefined") {
  applyThemePreferencesForCurrentAppearance();
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_PREFERENCES_KEY || event.key === "ade-appearance-mode" || event.key === "theme") {
      applyThemePreferencesForCurrentAppearance();
    }
  });
  window.addEventListener("ade-appearance-mode-changed", applyThemePreferencesForCurrentAppearance);
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", applyThemePreferencesForCurrentAppearance);
}
