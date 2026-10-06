/**
 * O HTML de uma prancheta é NÃO CONFIÁVEL (vem de um agente ou do usuário). Ele só roda num
 * iframe com `sandbox="allow-scripts"` (sem allow-same-origin: origem opaca, sem cookies,
 * sem acesso ao app) e com uma CSP que corta a rede.
 */
export const DESIGN_SANDBOX = "allow-scripts";
export const DESIGN_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline'";
/** Mensagem que o iframe manda ao app quando se escolhe um elemento. */
export const PICK_MESSAGE = "ags-design-pick";

/** Script injetado só no modo EDIT: hover/clique escolhem um elemento e mandam o seletor por postMessage. */
export const PICKER_SCRIPT = `(function(){
var last=null;
function sel(el){
  var parts=[];
  while(el&&el.nodeType===1&&el.tagName!=="HTML"){
    var p=el.tagName.toLowerCase();
    if(el.id){parts.unshift(p+"#"+el.id);break;}
    var i=1,s=el;while((s=s.previousElementSibling)){if(s.tagName===el.tagName)i++;}
    parts.unshift(p+":nth-of-type("+i+")");
    el=el.parentElement;
  }
  return parts.join(" > ");
}
document.addEventListener("mouseover",function(e){
  if(last)last.style.outline="";
  last=e.target;last.style.outline="2px solid #6366f1";
},true);
document.addEventListener("click",function(e){
  e.preventDefault();e.stopPropagation();
  var t=e.target;
  parent.postMessage({type:"${PICK_MESSAGE}",selector:sel(t),text:(t.textContent||"").trim().slice(0,80)},"*");
},true);
})();`;

/** Remove `<meta http-equiv>` e `<base>` do conteúdo: não podem afrouxar a CSP nem redirecionar. */
function stripUnsafeHead(html: string): string {
  return html.replace(/<meta\b[^>]*http-equiv[^>]*>/gi, "").replace(/<base\b[^>]*>/gi, "");
}

export interface SrcdocOptions { picker?: boolean }

/** Monta o `srcdoc` do iframe: CSP primeiro, depois o HTML do agente, e o seletor se for modo EDIT. */
export function buildSrcdoc(html: string, opts: SrcdocOptions = {}): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${DESIGN_CSP}">`;
  const picker = opts.picker ? `<script>${PICKER_SCRIPT}</script>` : "";
  return `<!doctype html><html><head><meta charset="utf-8">${meta}<style>html,body{margin:0}</style></head><body>${stripUnsafeHead(html)}${picker}</body></html>`;
}

export interface PickMessage { selector: string; text: string }

/** Valida o que veio por postMessage: o conteúdo do iframe é hostil, nada se assume. */
export function parsePick(data: unknown): PickMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== PICK_MESSAGE || typeof d.selector !== "string") return null;
  if (d.selector.length === 0 || d.selector.length > 500) return null;
  return { selector: d.selector, text: typeof d.text === "string" ? d.text.slice(0, 80) : "" };
}
