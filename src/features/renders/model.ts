import { stripUnsafeHead } from "@/features/canvas/design/srcdoc";
import { ISOLATED_FRAME_CSP } from "@/features/chat/timeline/isolatedFrame";

/** Quem envia a mensagem de link de dentro da página: o script que o `srcdoc` injeta. */
export const RENDER_MESSAGE_SOURCE = "ags-render";

/** Um tema que cabe no documento: as declarações de cor e fonte (ver `appThemeDeclarations`) e se é escuro. */
export interface RenderTheme {
  readonly dark: boolean;
  readonly declarations: string;
}

/**
 * O script do documento: um clique em link `http(s)` não navega dentro do quadro. Ele manda o endereço para a ADE, que
 * abre no navegador do sistema (ou no do app, se a pessoa escolheu). Âncora (`#`) fica, e o `window.open` não faz nada.
 */
const RENDER_GUARD = `(function(){
function offPage(href){
  if(href==null)return false;
  var h=String(href).trim();
  return !!h && h.charAt(0)!=="#";
}
document.addEventListener("click",function(e){
  var el=e.target;
  var a=el&&el.closest?el.closest("a[href]"):null;
  if(!a||!offPage(a.getAttribute("href")))return;
  e.preventDefault();
  e.stopPropagation();
  try{parent.postMessage({source:"${RENDER_MESSAGE_SOURCE}",kind:"open-link",href:String(a.href)},"*");}catch(x){}
},true);
document.addEventListener("submit",function(e){e.preventDefault();e.stopPropagation();},true);
try{window.open=function(){return null;};}catch(x){}
})();`;

/**
 * O `srcdoc` de uma página publicada: a CSP do quadro isolado (sem rede, sem navegação, sem formulário), o tema da
 * ADE e o script de links, antes do HTML do agente. As `<meta http-equiv>` e as `<base>` do HTML são tiradas, para que
 * o agente não afrouxe a CSP. Pura.
 */
export function renderSrcdoc(html: string, theme: RenderTheme = { dark: false, declarations: "" }): string {
  const scheme = theme.dark ? "dark" : "light";
  const declarations = theme.declarations.length > 4000 || /[<>]/.test(theme.declarations) ? "" : theme.declarations;
  const themeCss = `:root{${declarations};color-scheme:${scheme}}`;
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${ISOLATED_FRAME_CSP}"><html data-ade-scheme="${scheme}"><style>${themeCss}</style><script>${RENDER_GUARD}</script>${stripUnsafeHead(html)}`;
}

/**
 * O endereço que a página pediu para abrir, se a mensagem for dela (a fonte e o tipo batem) e o endereço for `http(s)`.
 * O que vem de dentro da página é dado não confiável: qualquer outra coisa vira `null`. Pura.
 */
export function parseRenderMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.source !== RENDER_MESSAGE_SOURCE || message.kind !== "open-link") return null;
  const href = message.href;
  if (typeof href !== "string" || href.length > 2048 || !/^https?:\/\//i.test(href)) return null;
  return href;
}

/** O nome da pasta do projeto, para a lista (a última parte do caminho). Pura. */
export function renderProjectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "";
}
