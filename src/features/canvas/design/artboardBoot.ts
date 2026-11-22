/**
 * O que roda no `<head>` de cada prancheta, antes de qualquer script do agente: um shim de
 * `localStorage`/`sessionStorage` (a origem do iframe é opaca, e o nativo lança SecurityError), o tema
 * (`data-theme`, `color-scheme` e `prefers-color-scheme`) e o relato de erros de script.
 * Tudo que a prancheta manda ao app chega por `postMessage` e é validado de novo em `parseBootMessage`.
 * O limite de 1 MiB é contado em bytes UTF-8 das chaves e dos valores das duas áreas, como no backend.
 */

export const STORAGE_LIMIT_BYTES = 1024 * 1024;
export const BOOT_MSG = "ags-design-boot";
export const BOOT_HOST_MSG = "ags-design-boot-host";
/** Erros relatados por documento: depois disso o boot cala (um laço de erro não enche o app). */
export const ERROR_LIMIT = 20;
export const ERROR_TEXT_LIMIT = 300;
const KEY_LIMIT = 1024;
const AREAS: StorageArea[] = ["local", "session"];

export type StorageArea = "local" | "session";
export interface StorageSnapshot { local: Record<string, string>; session: Record<string, string> }
export type StorageDelta =
  | { kind: "storage"; op: "set"; area: StorageArea; key: string; value: string }
  | { kind: "storage"; op: "remove"; area: StorageArea; key: string }
  | { kind: "storage"; op: "clear"; area: StorageArea };
export type BootMessage = StorageDelta | { kind: "error"; message: string; line: number | null };
export type DeltaResult = { ok: true; snapshot: StorageSnapshot } | { ok: false; reason: "quota" };

const encoder = new TextEncoder();
const bytesOf = (s: string) => encoder.encode(s).length;
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Grava como propriedade própria (uma chave `__proto__` não mexe no protótipo). */
const setOwn = (o: Record<string, string>, k: string, v: string) => {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
};

export const emptySnapshot = (): StorageSnapshot => ({ local: {}, session: {} });

export function snapshotBytes(s: StorageSnapshot): number {
  return AREAS.reduce((total, area) => total + Object.entries(s[area]).reduce((n, [k, v]) => n + bytesOf(k) + bytesOf(v), 0), 0);
}

/** O que volta do backend: só texto por chave, e lixo vira vazio. */
export function sanitizeSnapshot(raw: unknown): StorageSnapshot {
  const out = emptySnapshot();
  if (!isPlain(raw)) return out;
  for (const area of AREAS) {
    const src = raw[area];
    if (!isPlain(src)) continue;
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === "string" && k.length <= KEY_LIMIT) setOwn(out[area], k, v);
    }
  }
  return out;
}

/** Aplica uma gravação, remoção ou limpeza. Passar de 1 MiB recusa e não muda nada. */
export function applyStorageDelta(s: StorageSnapshot, d: StorageDelta): DeltaResult {
  const next: StorageSnapshot = { local: { ...s.local }, session: { ...s.session } };
  if (d.op === "clear") {
    next[d.area] = {};
    return { ok: true, snapshot: next };
  }
  if (d.op === "remove") {
    delete next[d.area][d.key];
    return { ok: true, snapshot: next };
  }
  setOwn(next[d.area], d.key, d.value);
  if (snapshotBytes(next) > STORAGE_LIMIT_BYTES) return { ok: false, reason: "quota" };
  return { ok: true, snapshot: next };
}

/** Valida o que veio do iframe. A prancheta é hostil: qualquer coisa fora do formato vira `null`. */
export function parseBootMessage(data: unknown): BootMessage | null {
  if (!isPlain(data) || data.type !== BOOT_MSG) return null;
  if (data.kind === "error") {
    if (typeof data.message !== "string") return null;
    const line = typeof data.line === "number" && Number.isFinite(data.line) ? data.line : null;
    return { kind: "error", message: data.message.slice(0, ERROR_TEXT_LIMIT), line };
  }
  if (data.kind !== "storage") return null;
  const area = data.area === "local" || data.area === "session" ? data.area : null;
  if (!area) return null;
  if (data.op === "clear") return { kind: "storage", op: "clear", area };
  if (typeof data.key !== "string" || data.key.length > KEY_LIMIT) return null;
  if (data.op === "remove") return { kind: "storage", op: "remove", area, key: data.key };
  if (data.op === "set" && typeof data.value === "string" && data.value.length <= STORAGE_LIMIT_BYTES) {
    return { kind: "storage", op: "set", area, key: data.key, value: data.value };
  }
  return null;
}

/** JSON dentro de um `<script>`: `<`, `>`, `&` e os separadores de linha não podem fechar a tag. */
const embed = (v: unknown) => JSON.stringify(v).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** O script do boot. Sem regex de tema nem nome de tecla: só o que a prancheta precisa. */
export function artboardBootScript({ storage, dark }: { storage: StorageSnapshot; dark: boolean }): string {
  return `(function(){
var LIMIT=${STORAGE_LIMIT_BYTES},MSG="${BOOT_MSG}",HOST="${BOOT_HOST_MSG}",ERRS=${ERROR_LIMIT},TEXT=${ERROR_TEXT_LIMIT};
var root=document.documentElement,dark=${dark ? "true" : "false"},errors=0,mqls=[],nativeMM=window.matchMedia?window.matchMedia.bind(window):null;
var init=${embed(sanitizeSnapshot(storage))};
function clean(s){return s.replace(/[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[\\uD800-\\uDFFF]/g,function(m){return m.length===2?m:"\\uFFFD";});}
function bytes(s){var n=0;for(var i=0;i<s.length;i++){var c=s.charCodeAt(i);if(c<128)n+=1;else if(c<2048)n+=2;else if(c>=55296&&c<56320&&i+1<s.length&&s.charCodeAt(i+1)>=56320&&s.charCodeAt(i+1)<57344){n+=4;i++;}else n+=3;}return n;}
var data={local:Object.create(null),session:Object.create(null)};
["local","session"].forEach(function(a){var src=init[a]||{};Object.keys(src).forEach(function(k){if(typeof src[k]==="string")data[a][k]=src[k];});});
function used(){var t=0;["local","session"].forEach(function(a){var o=data[a];Object.keys(o).forEach(function(k){t+=bytes(k)+bytes(o[k]);});});return t;}
function post(m){m.type=MSG;try{parent.postMessage(m,"*");}catch(_){}}
function area(name){
  var api={
    getItem:function(k){var v=data[name][clean(String(k))];return v===undefined?null:v;},
    setItem:function(k,v){k=clean(String(k));v=clean(String(v));var prev=data[name][k];var delta=bytes(k)+bytes(v)-(prev===undefined?0:bytes(k)+bytes(prev));if(used()+delta>LIMIT)throw new DOMException("The quota has been exceeded.","QuotaExceededError");data[name][k]=v;post({kind:"storage",op:"set",area:name,key:k,value:v});},
    removeItem:function(k){k=clean(String(k));if(!(k in data[name]))return;delete data[name][k];post({kind:"storage",op:"remove",area:name,key:k});},
    clear:function(){if(Object.keys(data[name]).length===0)return;data[name]=Object.create(null);post({kind:"storage",op:"clear",area:name});},
    key:function(i){var ks=Object.keys(data[name]);return i>=0&&i<ks.length?ks[i]:null;}
  };
  return new Proxy(api,{
    get:function(t,p){if(p==="length")return Object.keys(data[name]).length;if(typeof p==="string"&&!(p in t)){var v=data[name][p];return v===undefined?undefined:v;}return t[p];},
    set:function(t,p,v){if(typeof p==="string"&&!(p in t)){t.setItem(p,v);return true;}return false;},
    deleteProperty:function(t,p){if(typeof p==="string"&&!(p in t))t.removeItem(p);return true;},
    has:function(t,p){return (typeof p==="string"&&Object.prototype.hasOwnProperty.call(data[name],p))||p in t;},
    ownKeys:function(t){return Array.from(new Set(Object.keys(data[name]).concat(Reflect.ownKeys(t))));},
    getOwnPropertyDescriptor:function(t,p){if(typeof p==="string"&&!(p in t)&&Object.prototype.hasOwnProperty.call(data[name],p))return {value:data[name][p],writable:true,enumerable:true,configurable:true};return Reflect.getOwnPropertyDescriptor(t,p);}
  });
}
try{Object.defineProperty(window,"localStorage",{value:area("local"),configurable:true});}catch(_){}
try{Object.defineProperty(window,"sessionStorage",{value:area("session"),configurable:true});}catch(_){}
function scheme(){return dark?"dark":"light";}
function mql(q,want){
  var listeners=[],last=scheme()===want;
  var m={media:q,onchange:null,
    get matches(){return scheme()===want;},
    addListener:function(f){m.addEventListener("change",f);},
    removeListener:function(f){m.removeEventListener("change",f);},
    addEventListener:function(t,f){if(t!=="change"||typeof f!=="function"||listeners.indexOf(f)>=0)return;listeners.push(f);if(mqls.indexOf(m)<0)mqls.push(m);},
    removeEventListener:function(t,f){if(t==="change")listeners=listeners.filter(function(x){return x!==f;});},
    dispatchEvent:function(){return true;},
    sync:function(){var now=m.matches;if(now===last)return;last=now;var ev={type:"change",matches:now,media:q};if(typeof m.onchange==="function")m.onchange(ev);listeners.slice().forEach(function(f){try{f.call(m,ev);}catch(_){}});}
  };
  return m;
}
window.matchMedia=function(q){
  var s=String(q).replace(/\\s+/g,"").toLowerCase(),i=s.indexOf("prefers-color-scheme:");
  if(i>=0){var want=s.slice(i+21).split(")")[0];if(want==="dark"||want==="light")return mql(String(q),want);}
  if(nativeMM)return nativeMM(q);
  return {media:String(q),matches:false,onchange:null,addListener:function(){},removeListener:function(){},addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return true;}};
};
function applyTheme(d){dark=!!d;root.setAttribute("data-theme",scheme());root.style.colorScheme=scheme();mqls.forEach(function(m){m.sync();});}
applyTheme(dark);
window.addEventListener("message",function(e){if(e.source!==parent)return;var d=e.data;if(d&&d.type===HOST&&d.kind==="theme"&&typeof d.dark==="boolean")applyTheme(d.dark);});
function text(a){if(a&&typeof a==="object"&&typeof a.message==="string")return a.message;try{return String(a);}catch(_){return "?";}}
function report(msg,line){if(errors>=ERRS)return;errors++;post({kind:"error",message:clean(String(msg)).slice(0,TEXT),line:typeof line==="number"?line:null});}
window.addEventListener("error",function(e){report(e.message||(e.error&&e.error.message)||"Erro",e.lineno);});
window.addEventListener("unhandledrejection",function(e){report(text(e.reason),null);});
var nativeErr=console.error;
console.error=function(){var parts=[];for(var i=0;i<arguments.length;i++)parts.push(text(arguments[i]));report(parts.join(" "),null);return nativeErr.apply(console,arguments);};
})();`;
}
