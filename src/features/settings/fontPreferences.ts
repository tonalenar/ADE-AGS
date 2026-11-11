/** Preferências tipográficas locais do ADE. Fontes personalizadas precisam estar instaladas no sistema. */
export type InterfaceFont = "default" | "system" | "geist" | "inter" | "custom";
export type CodeFont = "default" | "system" | "geist" | "jetbrains" | "custom";

/**
 * O tamanho base, em px, dos textos da interface e do código. A faixa é a do T3 Code (interface de 12 a
 * 20, código de 10 a 18). O padrão é o tamanho que o ADE já usa (14 e 13): quem não mexe não vê mudança.
 * Os tokens `--text-chat-*` de `App.css` escalam a partir destes valores (ver `fontScaleVars`).
 */
export const FONT_SIZE_RANGE = {
  interface: { min: 12, max: 20, default: 14 },
  code: { min: 10, max: 18, default: 13 },
} as const;

export interface FontPreferences {
  interface: { preset: InterfaceFont; family: string };
  code: { preset: CodeFont; family: string };
  sizes: { interface: number; code: number };
}

const STORAGE_KEY = "cc-font-preferences";

export const DEFAULT_FONT_PREFERENCES: FontPreferences = {
  interface: { preset: "default", family: "" },
  code: { preset: "default", family: "" },
  sizes: { interface: FONT_SIZE_RANGE.interface.default, code: FONT_SIZE_RANGE.code.default },
};

function inputFamily(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFC").replace(/[^\p{L}\p{N} ._-]/gu, "").replace(/\s+/g, " ").slice(0, 64)
    : "";
}

function cleanFamily(value: unknown): string {
  return inputFamily(value).trim();
}

function isInterfaceFont(value: unknown): value is InterfaceFont {
  return value === "default" || value === "system" || value === "geist" || value === "inter" || value === "custom";
}

function isCodeFont(value: unknown): value is CodeFont {
  return value === "default" || value === "system" || value === "geist" || value === "jetbrains" || value === "custom";
}

/** Um tamanho inteiro dentro da faixa da área; o que não é número finito volta ao padrão. Pura. */
function sizeOf(value: unknown, range: { readonly min: number; readonly max: number; readonly default: number }): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return range.default;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

export function readFontPreferences(): FontPreferences {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return DEFAULT_FONT_PREFERENCES;
    const value = raw as Partial<FontPreferences>;
    return {
      interface: {
        preset: isInterfaceFont(value.interface?.preset) ? value.interface.preset : "default",
        family: cleanFamily(value.interface?.family),
      },
      code: {
        preset: isCodeFont(value.code?.preset) ? value.code.preset : "default",
        family: cleanFamily(value.code?.family),
      },
      // Sem o campo (preferência gravada antes dos tamanhos), vale o padrão e as fontes ficam como estão.
      sizes: {
        interface: sizeOf(value.sizes?.interface, FONT_SIZE_RANGE.interface),
        code: sizeOf(value.sizes?.code, FONT_SIZE_RANGE.code),
      },
    };
  } catch {
    return DEFAULT_FONT_PREFERENCES;
  }
}

/**
 * As escalas que os tamanhos gravam na janela. 1 é o padrão do ADE: os tokens `--text-chat-*` de `App.css`
 * são `calc(14px * var(--cc-font-scale-ui))` e similares, então um tamanho de 16 px vira a escala 16/14. Pura.
 */
export function fontScaleVars(sizes: FontPreferences["sizes"]): Record<string, string> {
  return {
    "--cc-font-scale-ui": String(sizes.interface / FONT_SIZE_RANGE.interface.default),
    "--cc-font-scale-code": String(sizes.code / FONT_SIZE_RANGE.code.default),
  };
}

function interfaceStack(preset: InterfaceFont, family: string): string | null {
  switch (preset) {
    case "default": return null;
    case "system": return 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    case "geist": return '"Geist Variable", system-ui, sans-serif';
    case "inter": return '"Inter Variable", "Inter", system-ui, sans-serif';
    case "custom": return family ? `"${family}", system-ui, sans-serif` : null;
  }
}

function codeStack(preset: CodeFont, family: string): string | null {
  switch (preset) {
    case "default": return null;
    case "system": return 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    case "geist": return '"Geist Mono Variable", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
    case "jetbrains": return '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
    case "custom": return family ? `"${family}", ui-monospace, SFMono-Regular, Menlo, monospace` : null;
  }
}

export function applyFontPreferences(preferences: FontPreferences): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement.style;
  const ui = interfaceStack(preferences.interface.preset, cleanFamily(preferences.interface.family));
  const code = codeStack(preferences.code.preset, cleanFamily(preferences.code.family));
  for (const property of ["--font-sans", "--font-chat"]) {
    if (ui) root.setProperty(property, ui);
    else root.removeProperty(property);
  }
  for (const property of ["--font-mono", "--font-chat-mono"]) {
    if (code) root.setProperty(property, code);
    else root.removeProperty(property);
  }
  for (const [property, value] of Object.entries(fontScaleVars(preferences.sizes))) root.setProperty(property, value);
}

export function saveFontPreferences(preferences: FontPreferences): void {
  const safe: FontPreferences = {
    interface: { preset: isInterfaceFont(preferences.interface.preset) ? preferences.interface.preset : "default", family: cleanFamily(preferences.interface.family) },
    code: { preset: isCodeFont(preferences.code.preset) ? preferences.code.preset : "default", family: cleanFamily(preferences.code.family) },
    sizes: {
      interface: sizeOf(preferences.sizes.interface, FONT_SIZE_RANGE.interface),
      code: sizeOf(preferences.sizes.code, FONT_SIZE_RANGE.code),
    },
  };
  applyFontPreferences(safe);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
  } catch {
    /* Preferência em memória continua aplicada se o armazenamento local estiver indisponível. */
  }
}

/** Aplica as preferências antes do primeiro componente React ser montado. */
applyFontPreferences(readFontPreferences());
