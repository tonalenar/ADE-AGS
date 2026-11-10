import { DESIGN_SANDBOX, stripUnsafeHead } from "@/features/canvas/design/srcdoc";
import { ISOLATED_FRAME_CSP } from "@/features/chat/timeline/isolatedFrame";

/** O mesmo sandbox das pranchetas: scripts sim, origem opaca, sem `allow-same-origin`. */
export const MCP_APP_SANDBOX = DESIGN_SANDBOX;

/**
 * O app avisa o host quando a pessoa clica nele (`user-gesture`, só clique de verdade: `isTrusted`), para a
 * regra da tela cheia. O host ainda confere que o quadro está em foco, porque o app pode postar essa mensagem.
 *
 * O app avisa o host antes de sair da própria página. Link âncora (`#`) fica;
 * o resto (outro URL, formulário, `window.open`) é cancelado. A CSP
 * (`navigate-to 'none'`) é a segunda trava.
 */
const MCP_APP_GUARD = `(function(){
var sent=false;
function leave(){
  if(sent)return;
  sent=true;
  try{parent.postMessage({source:"ags-mcp-app",kind:"navigate-away"},"*");}catch(e){}
}
function offPage(href){
  if(href==null)return false;
  var h=String(href).trim();
  if(!h||h.charAt(0)==="#")return false;
  return true;
}
document.addEventListener("click",function(e){
  var el=e.target;
  var a=el&&el.closest?el.closest("a[href]"):null;
  if(!a||!offPage(a.getAttribute("href")))return;
  e.preventDefault();
  e.stopPropagation();
  leave();
},true);
document.addEventListener("click",function(e){
  if(!e.isTrusted)return;
  try{parent.postMessage({source:"ags-mcp-app",kind:"user-gesture"},"*");}catch(x){}
},true);
document.addEventListener("submit",function(e){
  e.preventDefault();
  e.stopPropagation();
  leave();
},true);
try{window.open=function(){leave();return null;};}catch(e){}
})();`;

export function mcpAppSrcdoc(html: string, theme: { dark: boolean; declarations: string } = { dark: false, declarations: "" }): string {
  const scheme = theme.dark ? "dark" : "light";
  const declarations = theme.declarations.length > 4000 || /[<>]/.test(theme.declarations) ? "" : theme.declarations;
  const themeCss = `:root{${declarations};color-scheme:${scheme}}`;
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${ISOLATED_FRAME_CSP}"><html data-ade-scheme="${scheme}"><style>${themeCss}</style><script>${MCP_APP_GUARD}</script>${stripUnsafeHead(html)}`;
}
