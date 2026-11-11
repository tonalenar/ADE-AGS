import { isTimeFormat, type TimeFormat } from "@/shared/timeFormat";
import { createPrefStore } from "@/features/settings/prefStore";

/**
 * As preferências de exibição deste aparelho: o contraste, a opacidade do vidro, a suavização e a
 * quebra de linha e a matemática do texto, o esforço no composer, a identificação do ambiente, o contexto do composer
 * e o formato de hora. Vão ao `localStorage` (um JSON só), como as outras do aparelho. Cada uma tem um
 * efeito real: as variáveis e atributos abaixo são lidos pelo CSS de `App.css`, e o resto pelas telas.
 */

export type EffortDisplay = "label" | "bars";
/** `auto` mostra o selo só numa instalação de desenvolvimento; `pill` mostra sempre; `none` nunca. */
export type EnvironmentIdentification = "auto" | "pill" | "none";

export interface DisplayPrefs {
  /** Contraste das cores e das bordas, de 50 a 200 (100 = o padrão). */
  contrast: number;
  /** Opacidade dos menus e dos diálogos de vidro, de 40 a 100 (80 = o padrão). */
  glassOpacity: number;
  /** Texto mais fino e em tons de cinza (o padrão). Desligado, volta ao antialiasing do macOS. */
  fontSmoothing: boolean;
  /** Quebra as linhas longas dos blocos de código e dos diffs. */
  codeWrap: boolean;
  /** Renderiza fórmulas LaTeX (`$…$`, `$$…$$`) no Markdown das conversas. Desligado é o padrão do T3. */
  renderMath: boolean;
  /** O esforço no composer: o nome do nível (Alto) ou barras crescentes. */
  effortDisplay: EffortDisplay;
  environmentIdentification: EnvironmentIdentification;
  /** Mantém a branch e o worktree abaixo do composer depois que a conversa começa. */
  composerContext: boolean;
  timeFormat: TimeFormat;
}

export const CONTRAST_RANGE = { min: 50, max: 200, default: 100 } as const;
export const GLASS_RANGE = { min: 40, max: 100, default: 80 } as const;

export const DISPLAY_PREFS_KEY = "cc-display-prefs";

export const DEFAULT_DISPLAY_PREFS: DisplayPrefs = {
  contrast: CONTRAST_RANGE.default,
  glassOpacity: GLASS_RANGE.default,
  fontSmoothing: true,
  codeWrap: false,
  renderMath: false,
  effortDisplay: "label",
  environmentIdentification: "auto",
  composerContext: false,
  timeFormat: "locale",
};

/** Um inteiro dentro da faixa; o que não é número finito volta ao padrão. Pura. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Lê o que veio do armazenamento e devolve só o que serve; o resto volta ao padrão. Pura. */
export function parseDisplayPrefs(raw: unknown): DisplayPrefs {
  const o: Record<string, unknown> = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    contrast: clampInt(o.contrast, CONTRAST_RANGE.min, CONTRAST_RANGE.max, CONTRAST_RANGE.default),
    glassOpacity: clampInt(o.glassOpacity, GLASS_RANGE.min, GLASS_RANGE.max, GLASS_RANGE.default),
    fontSmoothing: o.fontSmoothing !== false,
    codeWrap: o.codeWrap === true,
    renderMath: o.renderMath === true,
    effortDisplay: o.effortDisplay === "bars" ? "bars" : "label",
    environmentIdentification: o.environmentIdentification === "pill" || o.environmentIdentification === "none"
      ? o.environmentIdentification
      : "auto",
    composerContext: o.composerContext === true,
    timeFormat: isTimeFormat(o.timeFormat) ? o.timeFormat : "locale",
  };
}

/**
 * As variáveis CSS que o contraste e o vidro escrevem na janela. O contraste é dividido em duas partes
 * (`App.css` mistura o tom de base e o reforço): até 100% só esmaece, acima disso só reforça. Pura.
 */
export function displayCssVars(prefs: DisplayPrefs): Record<string, string> {
  return {
    "--cc-contrast-base": `${Math.min(prefs.contrast, 100)}%`,
    "--cc-contrast-boost": `${Math.max(prefs.contrast - 100, 0)}%`,
    "--cc-glass-alpha": `${prefs.glassOpacity}%`,
  };
}

/** Os atributos do `<html>` que o CSS lê para a suavização, a quebra de linha e o vidro sólido. Pura. */
export function displayAttributes(prefs: DisplayPrefs): Record<string, string> {
  return {
    "data-font-smoothing": prefs.fontSmoothing ? "on" : "off",
    "data-code-wrap": prefs.codeWrap ? "on" : "off",
    // Vidro a 100% é sólido: sem o desfoque atrás dele.
    "data-glass-solid": prefs.glassOpacity === GLASS_RANGE.max ? "on" : "off",
  };
}

function applyDisplayPrefs(prefs: DisplayPrefs): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(displayCssVars(prefs))) root.style.setProperty(name, value);
  for (const [name, value] of Object.entries(displayAttributes(prefs))) root.setAttribute(name, value);
}

const store = createPrefStore<DisplayPrefs>({
  key: DISPLAY_PREFS_KEY,
  defaults: DEFAULT_DISPLAY_PREFS,
  parse: parseDisplayPrefs,
  apply: applyDisplayPrefs,
});

export const readDisplayPrefs = store.read;
export const saveDisplayPrefs = store.save;
export const useDisplayPrefs = store.use;
