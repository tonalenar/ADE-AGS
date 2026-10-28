/**
 * Las tabs que no son agentes: un archivo, un diff o un navegador.
 *
 * Viven en la misma barra que los agentes porque son la misma forma de trabajar —abrir
 * algo al lado de lo que está haciendo el agente y volver con un click—, pero NO son
 * agentes: no tienen proceso, no se archivan como sesión y no pasan por la base. Por eso
 * tienen su propio modelo en vez de estirar `Tab` con campos que la mitad de las veces
 * estarían vacíos.
 *
 * Este archivo es la lógica pura (probada en `tests/viewTabs.test.ts`); el store la usa.
 */

interface ViewBase {
  id: string;
  /** El workspace al que pertenece. La barra solo muestra las del workspace activo. */
  cwd: string;
  title: string;
}

export interface FileView extends ViewBase {
  kind: "file";
  path: string;
  /** Hay cambios sin guardar. No se persiste: al reabrir la app el archivo es el del disco. */
  dirty?: boolean;
  /** Dónde poner el cursor (desde el buscador). `nonce` hace que dos saltos a la misma
   *  línea se vean como dos pedidos distintos. */
  reveal?: { line: number; column: number; nonce: number };
  /** Un Markdown que se está viendo renderizado en vez de como código. Se persiste: volver
   *  a la tab es encontrarla como se dejó. */
  preview?: boolean;
}

export interface DiffView extends ViewBase {
  kind: "diff";
  /** Root del repo; `path` es relativa a él, como la devuelve git. */
  root: string;
  path: string;
  /** Qué diff: lo preparado (HEAD → índice) o lo que falta preparar (índice → disco). */
  staged: boolean;
  /** Si está, el diff es el de ESE commit contra su padre, y `staged` no aplica. */
  commit?: string;
  /** En un commit que renombró el archivo: dónde estaba antes. */
  origPath?: string;
}

/** El agente que abrió un navegador y lo está manejando. */
export interface ViewOwner {
  /** Una tab de agente de esta ventana, o una tarea de la flota. */
  kind: "tab" | "task";
  id: string;
  /** Cómo llamarlo en la interfaz. */
  label: string;
}

export interface BrowserView extends ViewBase {
  kind: "browser";
  url: string;
  /** Quién lo abrió, si lo abrió un agente. Ausente = lo abrió el usuario. */
  owner?: ViewOwner;
  /** El tamaño de pantalla con que se está probando. Ausente = ocupa toda la tab. Se
   *  persiste: volver a la tab es seguir probando en el mismo tamaño. */
  viewport?: { width: number; height: number } | null;
  /** Emulando una pantalla táctil: `(hover: none)`, `(pointer: coarse)` y eventos de dedo.
   *  Se persiste por lo mismo que el tamaño, y se vuelve a aplicar en cada carga —una
   *  página nueva trae sus hojas de estilo sin tocar. */
  touch?: boolean;
  /** O zoom da página (1 = 100%). Ausente = 100%. Não muda o tamanho do navegador, só o da página. */
  zoom?: number;
  /** Mostra um Chrome de verdade (perfil próprio do app) em vez da página pelo proxy: é onde
   *  dá para entrar em sites que recusam navegador embutido, como a conta Google. Protótipo. */
  realChrome?: boolean;
}

export interface DesktopAppView extends ViewBase {
  kind: "desktop";
  app: "gemini";
}

export type ViewTab = FileView | DiffView | BrowserView | DesktopAppView;

/** Qué muestra una tab, sin su identidad. `Omit` a secas no reparte sobre la unión. */
export type ViewTarget = ViewTab extends infer V ? (V extends ViewTab ? Omit<V, "id" | "title"> : never) : never;

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * Una ruta en forma comparable: separadores `/` y la unidad de Windows en minúscula.
 *
 * En Windows el mismo archivo llega escrito de dos formas: el árbol y el buscador lo dan
 * como `C:\proyecto\src\app.ts` y git como `C:/proyecto/src/app.ts`. Comparadas tal cual
 * son dos archivos distintos, y abrir uno desde cada lado dejaba dos tabs del mismo.
 */
export function comparablePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
}

/** `path` relativa a `root` para mostrar, sin importar con qué separador venga cada una. */
export function relativeTo(path: string, root: string): string {
  const p = comparablePath(path);
  const r = comparablePath(root).replace(/\/+$/, "");
  return p.startsWith(`${r}/`) ? path.replace(/\\/g, "/").slice(r.length + 1) : path;
}

/** La tab que ya muestra esto, si hay: abrir dos veces lo mismo enfoca, no duplica. */
export function findExisting(views: ViewTab[], wanted: ViewTarget): ViewTab | undefined {
  return views.find((v) => {
    if (v.kind !== wanted.kind || comparablePath(v.cwd) !== comparablePath(wanted.cwd)) return false;
    if (v.kind === "file" && wanted.kind === "file") return comparablePath(v.path) === comparablePath(wanted.path);
    if (v.kind === "diff" && wanted.kind === "diff") {
      return comparablePath(v.root) === comparablePath(wanted.root)
        && comparablePath(v.path) === comparablePath(wanted.path)
        && v.staged === wanted.staged
        && (v.commit ?? null) === (wanted.commit ?? null);
    }
    // Navegadores puede haber varios a propósito: dos pantallas del mismo proyecto.
    return false;
  });
}

export function viewsOfWorkspace(views: ViewTab[], cwd: string | null): ViewTab[] {
  if (cwd === null) return [];
  const wanted = comparablePath(cwd);
  return views.filter((v) => comparablePath(v.cwd) === wanted);
}

/**
 * Qué queda activo al cerrar `id`: la vecina de la izquierda dentro del mismo workspace, o
 * la de la derecha, o ninguna — y "ninguna" es volver a la terminal del agente.
 */
export function nextActiveAfterClose(views: ViewTab[], id: string, activeId: string | null): string | null {
  if (activeId !== id) return activeId;
  const closing = views.find((v) => v.id === id);
  if (!closing) return null;
  const siblings = viewsOfWorkspace(views, closing.cwd);
  const idx = siblings.findIndex((v) => v.id === id);
  const rest = siblings.filter((v) => v.id !== id);
  return rest[Math.max(0, idx - 1)]?.id ?? null;
}

/** Lo que se guarda para restaurar. Lo efímero (sin guardar, a dónde saltar) no. */
/** Os tipos de aba que esta versão sabe desenhar. */
const KNOWN_KINDS = new Set<string>(["file", "diff", "browser"]);

/**
 * Das abas salvas, só as de um tipo conhecido. O estado fica no `localStorage` do perfil do WebView2, que
 * outra versão do app (um build de debug, um instalador mais novo ou mais antigo) pode ter escrito com abas de
 * um tipo que esta não conhece: sem componente para elas, a tela inteira caía num erro.
 */
export function knownViews(views: ViewTab[]): ViewTab[] {
  return views.filter((v) => !!v && typeof v === "object" && KNOWN_KINDS.has((v as { kind?: string }).kind ?? ""));
}

export function toPersisted(views: ViewTab[]): ViewTab[] {
  return views.map((v) => {
    if (v.kind !== "file") return v;
    const { dirty: _dirty, reveal: _reveal, ...rest } = v;
    return rest;
  });
}

/**
 * Lo que el usuario escribe en la barra de direcciones, como URL.
 *
 * `localhost:5173` y `:3000` son las formas en que se piensa un servidor de desarrollo;
 * exigir el `http://` es hacer tipear lo obvio. Un host sin puerto ni esquema se asume
 * `https`, salvo que sea local.
 */
/** `about:blank` (ou `about:`): uma página vazia, não um endereço. Um agente cria um portal «vazio» assim. */
export function isBlankUrl(input: string): boolean {
  return /^about:(blank)?\/?$/i.test(input.trim());
}

export function normalizeUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^:\d+/.test(text)) return `http://localhost${text}`;
  if (/^\d+$/.test(text)) return `http://localhost:${text}`;
  const host = text.split(/[/?#]/)[0];
  const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(host) || /\.(localhost|local)(:\d+)?$/i.test(host);
  if (local) return `http://${text}`;
  // Algo que no parece un host (sin punto ni puerto) no es una dirección.
  if (!host.includes(".") && !host.includes(":")) return null;
  return `https://${text}`;
}

/** ¿Es un servidor de esta máquina? Es lo que se abre en una tab en vez del navegador del
 *  sistema al hacer click en un link de la terminal. */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0"
      || host === "::1" || host.startsWith("127.") || host.endsWith(".local");
  } catch {
    return false;
  }
}

/**
 * El texto de cada tab, con una pista de carpeta cuando hay dos iguales.
 *
 * Con tres `index.ts` abiertos, tres tabs que dicen "index.ts" no sirven para elegir; se
 * agrega la carpeta que los diferencia, y solo a ellos.
 */
export function viewLabels(views: ViewTab[]): Map<string, { title: string; hint: string | null }> {
  const out = new Map<string, { title: string; hint: string | null }>();
  // Solo chocan las del mismo tipo: el archivo y el diff del mismo archivo ya se
  // distinguen por el ícono, y agregarles la carpeta a los dos no separa nada.
  const clashKey = (v: ViewTab) => `${v.kind}:${v.title}`;
  const byTitle = new Map<string, ViewTab[]>();
  // Uma aba sem `path` (de um tipo que esta versão não conhece, salva por outra) não tem pasta para
  // diferenciar: fica só com o título, em vez de derrubar a tela.
  const hasPath = (v: ViewTab): v is Exclude<ViewTab, BrowserView | DesktopAppView> => v.kind !== "browser" && typeof (v as { path?: unknown }).path === "string";
  for (const v of views) {
    if (!hasPath(v)) continue;
    const list = byTitle.get(clashKey(v)) ?? [];
    list.push(v);
    byTitle.set(clashKey(v), list);
  }
  for (const v of views) {
    if (!hasPath(v)) {
      out.set(v.id, { title: v.title, hint: null });
      continue;
    }
    const clash = (byTitle.get(clashKey(v))?.length ?? 0) > 1;
    const dirs = v.path.split(/[\\/]/).filter(Boolean);
    out.set(v.id, { title: v.title, hint: clash ? dirs[dirs.length - 2] ?? null : null });
  }
  return out;
}
