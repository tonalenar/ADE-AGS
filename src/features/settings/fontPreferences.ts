/** Preferências tipográficas locais do ADE. Fontes personalizadas precisam estar instaladas no sistema. */
export type InterfaceFont = "default" | "system" | "geist" | "inter" | "custom";
export type CodeFont = "default" | "system" | "geist" | "jetbrains" | "custom";

export interface FontPreferences {
  interface: { preset: InterfaceFont; family: string };
  code: { preset: CodeFont; family: string };
}

const STORAGE_KEY = "cc-font-preferences";

export const DEFAULT_FONT_PREFERENCES: FontPreferences = {
  interface: { preset: "default", family: "" },
  code: { preset: "default", family: "" },
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
    };
  } catch {
    return DEFAULT_FONT_PREFERENCES;
  }
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
}

export function saveFontPreferences(preferences: FontPreferences): void {
  const safe: FontPreferences = {
    interface: { preset: isInterfaceFont(preferences.interface.preset) ? preferences.interface.preset : "default", family: cleanFamily(preferences.interface.family) },
    code: { preset: isCodeFont(preferences.code.preset) ? preferences.code.preset : "default", family: cleanFamily(preferences.code.family) },
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
