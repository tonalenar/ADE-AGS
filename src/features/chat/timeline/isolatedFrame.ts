const COLOR_TOKENS = [
  "--color-gray-50", "--color-gray-100", "--color-gray-200", "--color-gray-700", "--color-gray-800", "--color-gray-900",
  "--color-accent-400", "--color-accent-500", "--color-accent-600", "--color-surface-deep", "--color-surface", "--color-surface-raised",
];
const FONT_TOKENS = ["--font-sans", "--font-chat", "--font-mono", "--font-chat-mono"];

/**
 * CSP do documento isolado (prévia visual e app MCP). Sem rede, sem navegação,
 * sem frame aninhado e sem formulário. O sandbox do iframe continua sem `allow-same-origin`.
 */
export const ISOLATED_FRAME_CSP = [
  "default-src 'none'",
  "connect-src 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline' data:",
  "script-src 'unsafe-inline'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "navigate-to 'none'",
].join("; ");

/** Só leva cores/fontes validadas para o documento isolado; tokens não viram marcação HTML. */
export function appThemeDeclarations(): { dark: boolean; declarations: string } {
  if (typeof document === "undefined") return { dark: false, declarations: "" };
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const dark = root.classList.contains("dark") || root.getAttribute("data-theme") === "dark";
  const declarations = [...COLOR_TOKENS, ...FONT_TOKENS].flatMap((token) => {
    const value = computed.getPropertyValue(token).trim();
    if (!value || value.length > 160 || /[<>;{}]/.test(value)) return [];
    if (token.startsWith("--color-") && (typeof CSS === "undefined" || !CSS.supports("color", value))) return [];
    if (token.startsWith("--font-") && (typeof CSS === "undefined" || !CSS.supports("font-family", value))) return [];
    return [`${token}:${value}`];
  }).join(";");
  return { dark, declarations };
}
