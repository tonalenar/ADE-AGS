import { buildSrcdoc } from "@/features/canvas/design/srcdoc";

/**
 * A conversa entre a tela de Design e o iframe de cada prancheta. O iframe é isolado
 * (`sandbox="allow-scripts"`, sem `allow-same-origin`): a única via é `postMessage`, e o que vem de lá
 * é HOSTIL. Um script nosso, injetado no fim do srcdoc, repassa roda, pinça, teclas e cliques, e
 * responde onde estão os elementos ancorados. O app valida tudo em `parseFrameMessage`.
 */
export const FRAME_MSG = "ags-studio";
export const HOST_MSG = "ags-studio-host";

/** O que o script faz com o mouse: `edit` escolhe elementos, `comment` cria âncora, `play` deixa a página viva, `inert` nada. */
export type FrameMode = "edit" | "comment" | "play" | "inert";

/**
 * O script do iframe. Sem hex nas cores (a regra vale também aqui): acento e âmbar em oklch.
 * - roda: Ctrl/⌘ (e o pinch, que chega como Ctrl) sempre vão ao app; sem modificador, se a página
 *   pode rolar naquela direção ela rola, senão vai ao app; o primeiro evento decide por 200 ms;
 * - gesturestart/gesturechange (WebKit) viram pinça;
 * - teclas fora de campos de texto vão ao app (no modo play, só o Esc);
 * - modo edit: o clique não chega à página, vira "select" com seletor, tipo e rótulo;
 * - modo comment: o clique vira "pick" com seletor, ponto relativo ao elemento e texto;
 * - modo play: links locais viram "nav" (protótipo clicável entre pranchetas);
 * - informa a altura do conteúdo ("size") e responde "locate" com a caixa dos seletores.
 */
export const FRAME_SCRIPT = `(function(){
var MSG="${FRAME_MSG}",HOST="${HOST_MSG}";
var mode="inert",active=false,wasActive=false,cur=[],lockUntil=0,lockTo=null,want=[],editing=null;
var ACCENT="oklch(0.63 0.19 255)",AMBER="oklch(0.77 0.16 70)",SKIP=/^(SCRIPT|STYLE|LINK|META|TITLE|TEMPLATE|NOSCRIPT|HEAD)$/;
function post(m){m.type=MSG;try{parent.postMessage(m,"*");}catch(_){}}
function sel(el){
  var parts=[];
  while(el&&el.nodeType===1&&el.tagName!=="HTML"&&el.tagName!=="BODY"){
    var p=el.tagName.toLowerCase();
    if(el.id){parts.unshift(p+"#"+el.id);break;}
    var i=1,s=el;while((s=s.previousElementSibling)){if(s.tagName===el.tagName)i++;}
    parts.unshift(p+":nth-of-type("+i+")");
    el=el.parentElement;
  }
  return parts.slice(-10).join(" > ");
}
function kindOf(el){
  var t=el.tagName.toLowerCase();
  if(t==="img"||t==="picture"||t==="video"||t==="canvas")return "image";
  if(t==="hr")return "line";
  if(t==="svg"||t==="path"||t==="rect"||t==="circle")return "shape";
  for(var i=0;i<el.childNodes.length;i++){var n=el.childNodes[i];if(n.nodeType===3&&n.textContent.trim())return "text";}
  return "other";
}
function textOf(el){return ((el.innerText||el.textContent||"")+"").replace(/\\s+/g," ").trim();}
function labelOf(el){var t=textOf(el);return (el.tagName.toLowerCase()+(t?" “"+t.slice(0,48)+"”":"")).slice(0,60);}
function editable(t){return t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));}
function q(s){try{return document.querySelector(s);}catch(_){return null;}}
function rectOf(el){var r=el.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};}
/* Sobreposição própria (fora do body): o destaque não muda o style dos elementos nem o HTML salvo. */
var layer=document.createElement("div");
layer.setAttribute("data-ags-overlay","");
layer.style.cssText="position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647";
document.documentElement.appendChild(layer);
var hoverBox=document.createElement("div");layer.appendChild(hoverBox);
var selBoxes=[];
function place(box,el,color,width){
  if(!el){box.style.display="none";return;}
  var r=el.getBoundingClientRect();
  box.style.cssText="position:fixed;display:block;box-sizing:border-box;pointer-events:none;left:"+r.left+"px;top:"+r.top+"px;width:"+r.width+"px;height:"+r.height+"px;border:"+width+"px solid "+color;
}
function paint(){
  while(selBoxes.length<cur.length){var b=document.createElement("div");layer.appendChild(b);selBoxes.push(b);}
  for(var i=0;i<selBoxes.length;i++)place(selBoxes[i],cur[i]||null,ACCENT,2);
}
function clearHover(){place(hoverBox,null);}
/* A raiz da seleção: desce pelos invólucros únicos que cobrem a prancheta inteira (o "frame" do layout). */
function rootScope(){
  var s=document.body;
  for(var i=0;i<4&&s;i++){
    var kids=[];for(var k=0;k<s.children.length;k++)if(!SKIP.test(s.children[k].tagName))kids.push(s.children[k]);
    if(kids.length!==1)break;
    var r=kids[0].getBoundingClientRect();
    if(r.width<innerWidth*0.95||r.height<innerHeight*0.95)break;
    s=kids[0];
  }
  return s;
}
function topIn(t,scope){
  for(var n=t;n&&n!==document.body&&n!==document.documentElement;n=n.parentElement){if(n.parentElement===scope)return SKIP.test(n.tagName)?null:n;}
  return null;
}
/* O que um clique escolhe: no nível da seleção atual (irmãos dela); fora dele, o elemento de topo. */
function target(t){
  if(!t||t.nodeType!==1)return null;
  var c=cur[cur.length-1];
  var hit=c&&c.parentElement?topIn(t,c.parentElement):null;
  return hit||topIn(t,rootScope());
}
function postSelect(el,shift){post({kind:"select",selector:sel(el),elKind:kindOf(el),label:labelOf(el),shift:!!shift,rect:rectOf(el)});}
function canScroll(t,dx,dy){
  var se=document.scrollingElement||document.documentElement;
  for(var n=t;n&&n.nodeType===1;n=n.parentElement){
    var cs=getComputedStyle(n),oy=cs.overflowY,ox=cs.overflowX;
    if(n===se){
      /* O viewport rola se html (ou o body, que propaga quando o html é visible) não esconde o overflow. */
      var bs=document.body?getComputedStyle(document.body):cs;
      oy=cs.overflowY==="visible"?bs.overflowY:cs.overflowY;ox=cs.overflowX==="visible"?bs.overflowX:cs.overflowX;
      if(oy==="visible")oy="auto";if(ox==="visible")ox="auto";
    }else if(n===document.body||n===document.documentElement){continue;}
    if(dy&&(oy==="auto"||oy==="scroll")&&n.scrollHeight>n.clientHeight+2){
      if(dy<0?n.scrollTop>0:n.scrollTop+n.clientHeight<n.scrollHeight-1)return true;
    }
    if(dx&&(ox==="auto"||ox==="scroll")&&n.scrollWidth>n.clientWidth+2){
      if(dx<0?n.scrollLeft>0:n.scrollLeft+n.clientWidth<n.scrollWidth-1)return true;
    }
  }
  return false;
}
addEventListener("wheel",function(e){
  if(e.ctrlKey||e.metaKey){e.preventDefault();post({kind:"wheel",dx:e.deltaX,dy:e.deltaY,mode:e.deltaMode,ctrl:e.ctrlKey,meta:e.metaKey,cx:e.clientX,cy:e.clientY});return;}
  var now=Date.now();
  if(now>lockUntil){lockTo=canScroll(e.target,e.deltaX,e.deltaY)?"page":"canvas";}
  lockUntil=now+200;
  if(lockTo==="page")return;
  e.preventDefault();
  post({kind:"wheel",dx:e.deltaX,dy:e.deltaY,mode:e.deltaMode,ctrl:false,meta:false,cx:e.clientX,cy:e.clientY});
},{passive:false,capture:true});
addEventListener("gesturestart",function(e){e.preventDefault();post({kind:"gesture",phase:"start",scale:e.scale||1,cx:e.clientX||0,cy:e.clientY||0});},{passive:false});
addEventListener("gesturechange",function(e){e.preventDefault();post({kind:"gesture",phase:"change",scale:e.scale||1,cx:e.clientX||0,cy:e.clientY||0});},{passive:false});
addEventListener("gestureend",function(e){e.preventDefault();post({kind:"gesture",phase:"end",scale:e.scale||1,cx:0,cy:0});},{passive:false});
function onKey(phase){return function(e){
  if(editing)return;
  if(editable(e.target)&&e.key!=="Escape")return;
  if(mode==="play"&&e.key!=="Escape")return;
  var mod=e.metaKey||e.ctrlKey;
  /* As teclas que o estúdio usa não fazem a ação nativa aqui dentro (rolar, mudar o foco, zoom). */
  if(mode!=="play"&&(e.key===" "||e.key==="Tab"||e.key==="Backspace"||e.key==="Delete"||(mod&&/^[0=+\\-zZdDaA\\\\]$/.test(e.key))))e.preventDefault();
  post({kind:"key",phase:phase,key:e.key,meta:e.metaKey,ctrl:e.ctrlKey,shift:e.shiftKey,alt:e.altKey});
};}
addEventListener("keydown",onKey("down"),true);
addEventListener("keyup",onKey("up"),true);
addEventListener("mousemove",function(e){
  if(editing||!(mode==="comment"||(mode==="edit"&&active))){clearHover();return;}
  var el=mode==="comment"?e.target:target(e.target);
  if(!el||el===document.body||el===document.documentElement){clearHover();return;}
  place(hoverBox,el,mode==="comment"?AMBER:ACCENT,1);
},true);
addEventListener("mouseleave",clearHover);
addEventListener("pointerdown",function(e){
  if(editing&&editing.contains(e.target))return;
  wasActive=active;
  post({kind:"pointer",cx:e.clientX,cy:e.clientY,button:e.button,shift:e.shiftKey});
  if(mode==="edit"||mode==="comment")e.preventDefault();
},true);
addEventListener("contextmenu",function(e){e.preventDefault();post({kind:"context",cx:e.clientX,cy:e.clientY});},true);
addEventListener("click",function(e){
  var t=e.target;
  if(editing&&editing.contains(t))return;
  if(mode==="play"){
    var a=t&&t.closest?t.closest("a[href]"):null;
    if(a){
      var h=a.getAttribute("href")||"";
      /* Âncora (#) segue nativa; link externo não sai da prancheta; local vira navegação entre pranchetas. */
      if(h&&h.charAt(0)!=="#"){e.preventDefault();if(!/^[a-z][a-z0-9+.-]*:/i.test(h)||/^file:/i.test(h))post({kind:"nav",href:h.slice(0,300)});}
    }
    return;
  }
  if(mode==="inert")return;
  e.preventDefault();e.stopPropagation();
  var whole=!t||t===document.body||t===document.documentElement;
  var vw=innerWidth||1,vh=innerHeight||1;
  if(mode==="edit"){
    /* O primeiro clique numa prancheta não selecionada só a seleciona (o app cuida). */
    if(!wasActive)return;
    var hit=whole?null:target(t);
    if(!hit){post({kind:"clearSelect"});return;}
    postSelect(hit,e.shiftKey);
    return;
  }
  var picked=(getSelection&&String(getSelection())||"").trim();
  if(whole){post({kind:"pick",selector:null,fx:e.clientX/vw,fy:e.clientY/vh,rect:null,label:"",text:picked.slice(0,1800),bx:e.clientX,by:e.clientY});return;}
  var r=t.getBoundingClientRect();
  post({kind:"pick",selector:sel(t),fx:r.width?(e.clientX-r.left)/r.width:0.5,fy:r.height?(e.clientY-r.top)/r.height:0.5,
    rect:{x:r.left,y:r.top,w:r.width,h:r.height},label:labelOf(t),text:(picked||textOf(t)).slice(0,1800),bx:e.clientX,by:e.clientY});
},true);
/* Duplo clique entra no filho sob o cursor; numa folha com texto, edita o texto no lugar. */
addEventListener("dblclick",function(e){
  if(mode!=="edit"||!active||editing)return;
  e.preventDefault();e.stopPropagation();
  var c=cur[cur.length-1],t=e.target;
  if(!c){var h=target(t);if(h)postSelect(h,false);return;}
  if(c!==t&&c.contains(t)){var child=topIn(t,c);if(child){postSelect(child,false);return;}}
  if(kindOf(c)==="text")editText(sel(c));
},true);
function tree(){
  var out=[],stack=[];
  for(var i=document.body.children.length-1;i>=0;i--)stack.push([document.body.children[i],0]);
  while(stack.length&&out.length<400){
    var it=stack.pop(),el=it[0],d=it[1];
    if(SKIP.test(el.tagName))continue;
    var t="";for(var j=0;j<el.childNodes.length;j++){var n=el.childNodes[j];if(n.nodeType===3)t+=n.textContent;}
    out.push({selector:sel(el),tag:el.tagName.toLowerCase(),id:el.id||"",cls:(typeof el.className==="string"?el.className:"").slice(0,60),text:t.replace(/\\s+/g," ").trim().slice(0,40),depth:d});
    if(d<12)for(var k=el.children.length-1;k>=0;k--)stack.push([el.children[k],d+1]);
  }
  post({kind:"tree",nodes:out});
}
function editText(s){
  var el=q(s);if(!el||editing)return;
  clearHover();editing=el;var orig=el.innerHTML,done=false;
  el.setAttribute("contenteditable","true");el.focus();
  try{var r=document.createRange();r.selectNodeContents(el);var g=getSelection();g.removeAllRanges();g.addRange(r);}catch(_){}
  function finish(save){
    if(done)return;done=true;editing=null;
    el.removeAttribute("contenteditable");el.removeEventListener("keydown",onk,true);el.removeEventListener("blur",onb);
    if(!save){el.innerHTML=orig;post({kind:"editCancel"});return;}
    if(el.innerHTML===orig){post({kind:"editCancel"});return;}
    post({kind:"textEdited",selector:s,html:el.innerHTML.slice(0,200000)});
  }
  function onk(e){e.stopPropagation();if(e.key==="Escape"){e.preventDefault();finish(false);}else if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();finish(true);}}
  function onb(){finish(true);}
  el.addEventListener("keydown",onk,true);el.addEventListener("blur",onb);
}
function locate(){
  var out=[];
  for(var i=0;i<want.length;i++){
    var el=q(want[i].selector);
    out.push({id:want[i].id,rect:el?rectOf(el):null});
  }
  post({kind:"located",items:out});
}
var raf=0;function later(){if(raf)return;raf=requestAnimationFrame(function(){raf=0;if(want.length)locate();paint();post({kind:"size",h:Math.ceil(document.documentElement.scrollHeight)});});}
addEventListener("scroll",later,true);
addEventListener("resize",later);
addEventListener("load",later);
try{new ResizeObserver(later).observe(document.documentElement);}catch(_){}
addEventListener("message",function(e){
  if(e.source!==parent)return;
  var d=e.data;if(!d||d.type!==HOST)return;
  if(d.kind==="mode"&&typeof d.mode==="string"){mode=d.mode;clearHover();}
  if(d.kind==="selection"){
    active=d.active===true;
    cur=[];var list=Array.isArray(d.selectors)?d.selectors.slice(0,20):[];
    for(var i=0;i<list.length;i++){var el=typeof list[i]==="string"?q(list[i]):null;if(el)cur.push(el);}
    paint();
    var last=cur[cur.length-1];if(last)post({kind:"selRect",rect:rectOf(last)});
  }
  if(d.kind==="tree")tree();
  if(d.kind==="highlight"&&typeof d.selector==="string"){var hl=q(d.selector);if(hl)try{hl.scrollIntoView({block:"nearest",inline:"nearest"});}catch(_){}}
  if(d.kind==="editText"&&typeof d.selector==="string")editText(d.selector);
  if(d.kind==="locate"&&Array.isArray(d.items)){want=d.items.filter(function(x){return x&&typeof x.id==="string"&&typeof x.selector==="string";}).slice(0,200);locate();}
});
later();
})();`;

/** O srcdoc de uma prancheta na tela de Design: CSP + HTML do agente + o nosso script. */
export const studioSrcdoc = (html: string) => buildSrcdoc(html, { script: FRAME_SCRIPT });

export interface FrameRect { x: number; y: number; w: number; h: number }
/** Um nó da árvore de camadas (DFS dentro do body, até 400 nós e 12 níveis). */
export interface TreeNode { selector: string; tag: string; id: string; cls: string; text: string; depth: number }
export type FrameMessage =
  | { kind: "wheel"; dx: number; dy: number; mode: number; ctrl: boolean; meta: boolean; cx: number; cy: number }
  | { kind: "gesture"; phase: "start" | "change" | "end"; scale: number; cx: number; cy: number }
  | { kind: "key"; phase: "down" | "up"; key: string; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }
  | { kind: "pointer"; cx: number; cy: number; button: number; shift: boolean }
  | { kind: "context"; cx: number; cy: number }
  | { kind: "select"; selector: string; elKind: "text" | "image" | "shape" | "line" | "other"; label: string; shift: boolean; rect: FrameRect | null }
  | { kind: "tree"; nodes: TreeNode[] }
  | { kind: "textEdited"; selector: string; html: string }
  | { kind: "editCancel" }
  | { kind: "clearSelect" }
  | { kind: "selRect"; rect: FrameRect | null }
  | { kind: "pick"; selector: string | null; fx: number; fy: number; rect: FrameRect | null; label: string; text: string; bx: number; by: number }
  | { kind: "located"; items: Array<{ id: string; rect: FrameRect | null }> }
  | { kind: "size"; h: number }
  | { kind: "nav"; href: string };

const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown) => v === true;
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const unit = (v: unknown) => Math.min(1, Math.max(0, num(v, 0.5)));
function rect(v: unknown): FrameRect | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const out = { x: num(r.x), y: num(r.y), w: Math.max(0, num(r.w)), h: Math.max(0, num(r.h)) };
  return out;
}
const KINDS = new Set(["text", "image", "shape", "line", "other"]);

/** Valida uma mensagem vinda do iframe. Qualquer coisa fora do formato vira `null`. */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== FRAME_MSG || typeof d.kind !== "string") return null;
  switch (d.kind) {
    case "wheel":
      return { kind: "wheel", dx: num(d.dx), dy: num(d.dy), mode: num(d.mode), ctrl: bool(d.ctrl), meta: bool(d.meta), cx: num(d.cx), cy: num(d.cy) };
    case "gesture": {
      const phase = d.phase === "start" || d.phase === "change" || d.phase === "end" ? d.phase : null;
      const scale = num(d.scale, 1);
      if (!phase || scale <= 0) return null;
      return { kind: "gesture", phase, scale, cx: num(d.cx), cy: num(d.cy) };
    }
    case "key":
      if (typeof d.key !== "string" || d.key.length > 20) return null;
      return { kind: "key", phase: d.phase === "up" ? "up" : "down", key: d.key, meta: bool(d.meta), ctrl: bool(d.ctrl), shift: bool(d.shift), alt: bool(d.alt) };
    case "pointer":
      return { kind: "pointer", cx: num(d.cx), cy: num(d.cy), button: num(d.button), shift: bool(d.shift) };
    case "context":
      return { kind: "context", cx: num(d.cx), cy: num(d.cy) };
    case "select": {
      const selector = text(d.selector, 1024);
      if (!selector) return null;
      const elKind = typeof d.elKind === "string" && KINDS.has(d.elKind) ? (d.elKind as "text") : "other";
      return { kind: "select", selector, elKind, label: text(d.label, 60), shift: bool(d.shift), rect: rect(d.rect) };
    }
    case "pick": {
      const selector = d.selector === null ? null : text(d.selector, 1024) || null;
      return { kind: "pick", selector, fx: unit(d.fx), fy: unit(d.fy), rect: selector ? rect(d.rect) : null, label: text(d.label, 120), text: text(d.text, 1800), bx: num(d.bx), by: num(d.by) };
    }
    case "located": {
      if (!Array.isArray(d.items)) return null;
      const items = d.items.slice(0, 200).flatMap((it) => {
        if (!it || typeof it !== "object" || typeof (it as { id?: unknown }).id !== "string") return [];
        const r = it as { id: string; rect?: unknown };
        return [{ id: r.id.slice(0, 100), rect: rect(r.rect) }];
      });
      return { kind: "located", items };
    }
    case "tree": {
      if (!Array.isArray(d.nodes)) return null;
      const nodes = d.nodes.slice(0, 400).flatMap((n) => {
        if (!n || typeof n !== "object") return [];
        const r = n as Record<string, unknown>;
        const selector = text(r.selector, 1024);
        if (!selector) return [];
        return [{ selector, tag: text(r.tag, 20), id: text(r.id, 60), cls: text(r.cls, 60), text: text(r.text, 40), depth: Math.min(12, Math.max(0, Math.round(num(r.depth)))) }];
      });
      return { kind: "tree", nodes };
    }
    case "textEdited": {
      const selector = text(d.selector, 1024);
      if (!selector || typeof d.html !== "string") return null;
      return { kind: "textEdited", selector, html: d.html.slice(0, 200000) };
    }
    case "editCancel":
      return { kind: "editCancel" };
    case "clearSelect":
      return { kind: "clearSelect" };
    case "selRect":
      return { kind: "selRect", rect: rect(d.rect) };
    case "size": {
      const h = num(d.h);
      return h > 0 ? { kind: "size", h } : null;
    }
    case "nav": {
      const href = text(d.href, 300);
      return href ? { kind: "nav", href } : null;
    }
    default:
      return null;
  }
}

/** Manda uma ordem ao script do iframe (modo, ou os seletores a localizar). */
export type HostMessage =
  | { kind: "mode"; mode: FrameMode }
  | { kind: "locate"; items: Array<{ id: string; selector: string }> }
  | { kind: "tree" }
  | { kind: "highlight"; selector: string | null }
  | { kind: "editText"; selector: string }
  /** A seleção desta prancheta: `active` = a prancheta está selecionada (clicar escolhe elementos). */
  | { kind: "selection"; active: boolean; selectors: string[] };

export function postToFrame(frame: HTMLIFrameElement | null, msg: HostMessage): void {
  // A origem do iframe é opaca: "*" é o único alvo possível; o script confere `e.source === parent`.
  frame?.contentWindow?.postMessage({ ...msg, type: HOST_MSG }, "*");
}

/** Minúsculas, sem acento e só letras/números (para comparar nomes de arquivo com títulos). */
export const normName = (v: string) => v.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
/** Palavras de um nome: separa camelCase, números e separadores ("ThreadDiff_2" → thread, diff, 2). */
export function nameTokens(v: string): string[] {
  return v.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([a-zA-Z])(\d)/g, "$1 $2").replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
/** O título sem a numeração da frente ("1 · Nova conversa" → "Nova conversa"). */
export const stripOrdinal = (title: string) => title.replace(/^\s*\d+\s*[·.\-–—:)]\s*/, "");
/** O número da frente do título, se houver ("2 · Conversa…" → 2). */
const ordinalOf = (title: string) => { const m = /^\s*(\d+)\s*[·.\-–—:)]/.exec(title); return m ? Number(m[1]) : null; };
/** O `<title>` do HTML da prancheta, se houver. */
export function htmlTitle(html: string | undefined): string | null {
  const m = html ? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) : null;
  return m ? m[1].replace(/\s+/g, " ").trim() || null : null;
}

/**
 * Um link do protótipo (`<a href="Thread.dc.html">`) aponta para qual prancheta? Pega o nome do arquivo
 * (sem caminho, query, hash, `.html` e `.dc`) e tenta, nesta ordem, parando no primeiro resultado ÚNICO:
 * 1. o id da prancheta;
 * 2. o nome igual (sem acento, caixa e separadores) ao título, ao título sem a numeração ou ao `<title>` do HTML;
 * 3. o número: "2", "02" ou "tela-2" → a prancheta cujo título começa com "2 ·";
 * 4. todas as palavras do nome (camelCase separado) estão no título ou no `<title>`;
 * 5. o título (sem numeração) contém o nome inteiro.
 * Empate em qualquer passo vale a primeira da ordem do canvas; nada encontrado = `null`. Puro.
 */
export function resolveNavTarget(href: string, boards: Array<{ id: string; title: string; html?: string }>): string | null {
  const file = decodeURIComponentSafe(href.split(/[?#]/)[0].split(/[\\/]/).pop() ?? "").replace(/\.html?$/i, "").replace(/\.dc$/i, "");
  const want = normName(file);
  if (!want) return null;
  const byId = boards.find((b) => b.id === file);
  if (byId) return byId.id;
  const names = boards.map((b) => {
    const inner = htmlTitle(b.html);
    return { id: b.id, title: b.title, full: normName(b.title), bare: normName(stripOrdinal(b.title)), inner: inner ? normName(inner) : "", tokens: new Set([...nameTokens(b.title), ...nameTokens(inner ?? "")]) };
  });
  const first = (hit: (n: (typeof names)[number]) => boolean) => names.find(hit)?.id ?? null;
  const exact = first((n) => n.full === want || n.bare === want || (!!n.inner && n.inner === want));
  if (exact) return exact;
  const num = /^\D*?0*(\d+)$/.exec(file);
  if (num) {
    const hit = boards.find((b) => ordinalOf(b.title) === Number(num[1]));
    if (hit) return hit.id;
  }
  const words = nameTokens(file).filter((w) => !/^\d+$/.test(w) || nameTokens(file).length === 1);
  if (words.length) {
    const all = first((n) => words.every((w) => [...n.tokens].some((t) => t === w || (w.length >= 4 && t.startsWith(w)))));
    if (all) return all;
  }
  return want.length >= 3 ? first((n) => n.bare.includes(want) || (!!n.inner && n.inner.includes(want))) : null;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
