const COLOR_TOKENS = [
  "--color-gray-50", "--color-gray-100", "--color-gray-200", "--color-gray-700", "--color-gray-800", "--color-gray-900",
  "--color-accent-400", "--color-accent-500", "--color-accent-600", "--color-surface-deep", "--color-surface", "--color-surface-raised",
];
const FONT_TOKENS = ["--font-sans", "--font-chat", "--font-mono", "--font-chat-mono"];

/**
 * O sandbox de quem exibe o documento isolado: só scripts. Sem `allow-same-origin` (origem opaca, sem acesso à
 * ADE), sem `allow-top-navigation` (a página da ADE não é trocada) e sem `allow-popups` (nenhuma janela nova).
 */
export const ISOLATED_FRAME_SANDBOX = "allow-scripts";

/**
 * CSP do documento isolado (prévia visual, render e app MCP). Sem rede, sem frame aninhado e sem formulário.
 * A navegação para fora não está aqui: a diretiva `navigate-to` nunca foi aplicada por navegador. Quem segura
 * a navegação é o sandbox (`ISOLATED_FRAME_SANDBOX`) e o guarda de links e de `beforeunload` de cada quadro.
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
