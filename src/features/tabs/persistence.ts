import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabsStore } from "@/features/tabs/store";
import { ptyAttach, ptyOutputTotal } from "@/features/terminal/ipc";
import { currentVisibleAgentTabIds } from "./layout/layoutStore";
import { saveWindowState } from "./ipc";
import type { Tab } from "./types";

const SAVE_DEBOUNCE_MS = 400;
// 60 s e não 20: cada refresh pode copiar e gravar até 3 MB por aba que mudou. A cada fechamento
// e troca de janela o scrollback já é salvo; isto só protege contra um fim abrupto do app.
const SCROLLBACK_REFRESH_MS = 60_000;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

// El scrollback de cada PTY puede pesar hasta MAX_BUFFER_BYTES (3MB, ver pty_manager.rs).
// Antes, CADA guardado (incluido el debounce de 400ms disparado por renombrar/reordenar/
// activar una tab) volvía a pedir por IPC el scrollback completo de TODAS las tabs y
// reescribía la fila entera en SQLite — con varias tabs de agentes activos eso significa
// megabytes de tráfico IPC + disco en cada click. El scrollback solo hace falta fresco
// para sobrevivir a un crash, no en cada cambio de metadata, así que se cachea por ptyId.
// El ciclo de 20s pide el buffer solo de las pestañas visibles cuyo contador de bytes
// creció. Cerrar o salir de una pestaña sigue leyendo la que se va.
const scrollbackCache = new Map<number, string>();

// El último scrollback que la base ya tiene de cada tab (por id de tab). Con el cache de
// arriba el de un guardado de metadata es el MISMO string que el anterior, así que la
// comparación es por referencia y no cuesta nada: si no cambió, se manda vacío con
// `scrollbackUnchanged` y el backend conserva el suyo, en vez de que viajen y se
// reescriban megabytes por tab al mover la ventana o renombrar una tab.
const savedScrollback = new Map<string, string>();

/** Último `output_total` ya persistido, por PTY. Si no cambió, el ciclo de 20 s no copia. */
const outputTotals = new Map<number, number>();
/** PTYs que acaban de salir de la pantalla y hay que leer en el próximo guardado. */
const pendingRefresh = new Set<number>();
/** Pestañas que se veían en el pase anterior. Sirve para volcar la que acaba de ocultarse. */
let lastVisible = new Set<string>();

/**
 * PTYs cuyo scrollback pide el ciclo periódico: solo pestañas visibles, y solo si el
 * contador de bytes cambió o todavía no se miró. Una pestaña oculta no entra.
 */
export function periodicScrollbackTargets(
  tabs: { id: string; ptyId: number | null }[],
  visibleIds: ReadonlySet<string>,
  totals: ReadonlyMap<number, number | null>,
  savedTotals: ReadonlyMap<number, number>,
): number[] {
  const out: number[] = [];
  for (const tab of tabs) {
    if (tab.ptyId == null || !visibleIds.has(tab.id)) continue;
    const total = totals.get(tab.ptyId);
    const prev = savedTotals.get(tab.ptyId);
    if (total == null || prev === undefined || total !== prev) out.push(tab.ptyId);
  }
  return out;
}

/** Vacía el estado del ciclo. Lo usan los tests para no arrastrar un pase anterior. */
export function resetScrollbackScheduleForTests(): void {
  outputTotals.clear();
  pendingRefresh.clear();
  lastVisible = new Set();
  scrollbackCache.clear();
  savedScrollback.clear();
}

// `saveNow` es async (espera bounds + scrollback de cada PTY vía IPC) y se dispara desde
// dos fuentes independientes (debounce de 400ms y el refresco periódico de 20s) — sin
// serializar, dos llamadas superpuestas pueden llegar a `db_save_window_state` en orden
// distinto al que se dispararon (la más vieja termina después si tiene más tabs/PTYs que
// leer), y como ese comando hace DELETE+INSERT completo, la que llega última pisa a la
// otra — así se perdía un rename de tab reciente bajo un snapshot viejo. Encolar cada
// llamada tras la anterior garantiza que se ejecuten en el mismo orden en que se
// dispararon, y cada una lee el estado más fresco al empezar (no al encolarse).
let saveChain: Promise<void> = Promise.resolve();

/** Después del guardado de cierre no se guarda más: las terminales se matan enseguida, y un
 *  guardado posterior (el periódico de 20 s) leería el scrollback de un PTY que ya no
 *  existe y pisaría con `null` el que se acaba de guardar. */
let frozen = false;

interface SaveOpts {
  refreshScrollback?: boolean;
  /** Solo estos PTY se leen. El resto conserva lo que ya tiene la base. */
  onlyPtyIds?: ReadonlySet<number>;
  tabs?: Tab[];
  workspaceId?: string;
  authoritative?: boolean;
}

function enqueueSave(opts?: SaveOpts) {
  if (frozen) return;
  const run = () => saveNow(opts);
  saveChain = saveChain.then(run, run);
}

/** Escribe el scrollback de pestañas que están por desaparecer del store, antes de que
 *  el guardado siguiente las archive leyendo la fila vieja. */
function enqueueSnapshot(tabs: Tab[], workspaceId: string, ptyIds: ReadonlySet<number>) {
  if (frozen) return;
  const run = () => saveNow({ tabs, workspaceId, onlyPtyIds: ptyIds, authoritative: false });
  saveChain = saveChain.then(run, run);
}

async function fetchScrollback(ptyId: number | null): Promise<string | null> {
  if (ptyId == null) return null;
  try {
    const data = await ptyAttach(ptyId);
    scrollbackCache.set(ptyId, data);
    return data;
  } catch {
    scrollbackCache.delete(ptyId); // el proceso ya no existe
    return null;
  }
}

/** Usa el scrollback cacheado si hay uno (guardados "rápidos" de metadata); si el PTY
 * todavía no tiene nada cacheado (tab recién creada), lo pide una vez igual. */
async function cachedOrFetchScrollback(ptyId: number | null): Promise<string | null> {
  if (ptyId == null) return null;
  const cached = scrollbackCache.get(ptyId);
  if (cached !== undefined) return cached;
  return fetchScrollback(ptyId);
}

/** Cuánto va de un guardado: pasos hechos de un total que se conoce desde el principio. */
export type SaveProgress = (done: number, total: number, step: SaveStep) => void;

/** Qué se acaba de terminar: la posición de la ventana, una terminal, o la escritura. */
export type SaveStep =
  | { kind: "start" }
  | { kind: "bounds" }
  | { kind: "terminal"; title: string }
  | { kind: "write" };

async function scrollbackFor(
  ptyId: number | null,
  opts: SaveOpts,
  extra: ReadonlySet<number>,
): Promise<{ text: string | null; keep: boolean }> {
  if (ptyId == null) return { text: null, keep: false };
  if (opts.refreshScrollback || extra.has(ptyId) || opts.onlyPtyIds?.has(ptyId)) {
    return { text: await fetchScrollback(ptyId), keep: false };
  }
  if (opts.onlyPtyIds) {
    const cached = scrollbackCache.get(ptyId);
    if (cached !== undefined) return { text: cached, keep: false };
    return { text: null, keep: true };
  }
  return { text: await cachedOrFetchScrollback(ptyId), keep: false };
}

async function saveNow(opts: SaveOpts = {}, progress?: SaveProgress) {
  const win = getCurrentWindow();
  const store = useTabsStore.getState();
  const tabs = opts.tabs ?? store.tabs;
  const workspaceId = opts.workspaceId ?? store.workspaceId;
  const authoritative = opts.authoritative ?? store.hydrated;
  const extra = new Set<number>();
  // El ciclo periódico no se come el refresco de la pestaña que acaba de salir de pantalla.
  if (!opts.onlyPtyIds && !opts.refreshScrollback) {
    for (const id of pendingRefresh) extra.add(id);
    pendingRefresh.clear();
  }
  // Posición + una lectura de scrollback por tab + la escritura en la base. Los pasos son
  // los reales: cada uno avisa cuando TERMINA, no cuando empieza.
  const total = tabs.length + 2;
  let done = 0;
  const step = (s: SaveStep) => progress?.(++done, total, s);
  progress?.(0, total, { kind: "start" });

  let bounds: { x: number | null; y: number | null; width: number | null; height: number | null } = {
    x: null, y: null, width: null, height: null,
  };
  try {
    const pos = await win.outerPosition();
    const size = await win.outerSize();
    bounds = { x: pos.x, y: pos.y, width: size.width, height: size.height };
  } catch {
    // ventana ya cerrándose; se guarda solo el estado de tabs
  }
  step({ kind: "bounds" });

  const fresh = new Map<string, string>();
  const tabsPayload = await Promise.all(
    tabs.map(async (t, i) => {
      const read = await scrollbackFor(t.ptyId, opts, extra).finally(() => step({ kind: "terminal", title: t.title }));
      const unchanged = read.keep || (read.text !== null && savedScrollback.get(t.id) === read.text);
      const scrollback = read.text;
      if (scrollback !== null && !unchanged) fresh.set(t.id, scrollback);
      return {
        id: t.id,
        title: t.title,
        titleIsCustom: t.titleIsCustom ?? false,
        agentId: t.agentId,
        agentLabel: t.agentLabel,
        command: t.command,
        cwd: t.cwd,
        tabOrder: i,
        sessionId: t.sessionId ?? null,
        historyId: t.historyId ?? null,
        accountId: t.accountId ?? null,
        prelaunch: t.prelaunch ?? [],
        scrollback: unchanged ? null : scrollback,
        scrollbackUnchanged: unchanged,
        openedAt: t.openedAt,
      };
    })
  );

  // Podar entradas de PTYs que ya no pertenecen a ninguna tab de esta ventana (cerradas,
  // transferidas a otra ventana) — el Map, si no, crece sin límite durante toda la sesión.
  const liveIds = new Set(tabs.map((t) => t.ptyId).filter((id): id is number => id != null));
  for (const cachedId of scrollbackCache.keys()) {
    if (!liveIds.has(cachedId)) scrollbackCache.delete(cachedId);
  }

  await saveWindowState({
    label: win.label,
    workspaceId,
    posX: bounds.x,
    posY: bounds.y,
    width: bounds.width,
    height: bounds.height,
    monitor: null,
    tabs: tabsPayload,
    // Solo una ventana ya hidratada puede afirmar "estas son TODAS mis tabs", que es lo
    // único que autoriza al backend a dar por cerradas las que falten. Ver
    // `WindowStatePayload::authoritative`.
    authoritative,
  }).then(
    () => {
      // Solo después de que la base lo tiene: si el guardado falló, el próximo lo reintenta.
      const liveTabs = new Set(tabs.map((t) => t.id));
      for (const id of savedScrollback.keys()) if (!liveTabs.has(id)) savedScrollback.delete(id);
      for (const [id, scrollback] of fresh) savedScrollback.set(id, scrollback);
    },
    console.error,
  );
  step({ kind: "write" });
}

function scheduleSave() {
  if (frozen) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(enqueueSave, SAVE_DEBOUNCE_MS);
}

/** Fuerza el guardado inmediato del estado actual y espera a que termine, saltándose el
 * debounce de 400ms. Imprescindible antes de cualquier `getCurrentWindow().close()`
 * disparado por el propio JS (ej. al vaciar la última tab tras un detach/merge): si se
 * cierra la ventana con un guardado pendiente en el debounce, ese guardado nunca llega a
 * ejecutarse y la fila de esta ventana en SQLite queda con la tab que se acaba de mover —
 * duplicada con la copia que ya persistió la ventana destino. Ver bug: dos filas en
 * `windows` con la misma tab, ambas revividas al reabrir la app. */
export async function flushPendingSave(): Promise<void> {
  // Nunca persistir un estado PRE-HIDRATACIÓN. El resto de los disparadores del guardado
  // (la suscripción al store y el ciclo periódico) ya se abstienen mientras `hydrated` sea
  // false; este se los saltaba, y era el único que el usuario podía disparar a mano.
  //
  // El daño no era perder un guardado: `db_save_window_state` trata a las tabs que NO
  // vienen en el payload como tabs cerradas —las archiva y BORRA su fila—, y
  // `project_skills.tab_id` cascadea con `tabs`. O sea que un flush disparado antes de que
  // la ventana terminara de hidratarse mandaba un payload sin sus tabs reales y se llevaba
  // puestas las skills de todas ellas, dejando además entradas de historial con `skills: []`
  // que ya no se podían reanudar con sus skills. Verificado sobre una base real.
  //
  // Se ESPERA a la hidratación en vez de saltear el guardado: quien llama a esto necesita
  // que la tab que acaba de crear exista como fila antes de attachearle nada (`attach_skill`
  // con scope='tab' la busca por id). El tope existe para no colgar la creación de una tab
  // si la hidratación nunca llegara.
  await waitForHydration();

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  enqueueSave();
  await saveChain;
}

/**
 * El guardado de antes de cerrar la ventana, con progreso: el scrollback de cada terminal
 * leído en ese momento (no el de hasta 20 s atrás) y todo escrito en la base.
 *
 * Una ventana que no terminó de hidratarse no guarda nada (ver `flushPendingSave`): su
 * payload no tiene sus tabs reales y borraría las que sí están. Avisa `0 de 0` y sigue.
 */
export async function saveForClose(progress: SaveProgress): Promise<void> {
  if (!useTabsStore.getState().hydrated) {
    progress(0, 0, { kind: "write" });
    return;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  // Primero lo que ya estaba en cola: si no, un guardado viejo podría terminar después
  // y pisar a este.
  await saveChain;
  frozen = true;
  const run = () => saveNow({ refreshScrollback: true }, progress);
  saveChain = saveChain.then(run, run);
  await saveChain;
}

const HYDRATION_TIMEOUT_MS = 5_000;

function waitForHydration(): Promise<void> {
  if (useTabsStore.getState().hydrated) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, HYDRATION_TIMEOUT_MS);
    const unsubscribe = useTabsStore.subscribe((state) => {
      if (state.hydrated) done();
    });
  });
}

/**
 * El ciclo de 20 s. Con la página oculta no pide nada. De las pestañas visibles, solo
 * copia el scrollback si el contador de bytes creció. La que acaba de dejar de verse se
 * vuelca una vez y después queda fuera.
 */
export async function runPeriodicScrollbackSave(): Promise<void> {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  const state = useTabsStore.getState();
  if (!state.hydrated) return;
  const visible = currentVisibleAgentTabIds();
  const totals = new Map<number, number | null>();
  for (const tab of state.tabs) {
    if (tab.ptyId == null || !visible.has(tab.id)) continue;
    try {
      totals.set(tab.ptyId, await ptyOutputTotal(tab.ptyId));
    } catch {
      totals.set(tab.ptyId, null);
    }
  }
  const targets = new Set(periodicScrollbackTargets(state.tabs, visible, totals, outputTotals));
  for (const tab of state.tabs) {
    if (tab.ptyId != null && lastVisible.has(tab.id) && !visible.has(tab.id)) targets.add(tab.ptyId);
  }
  lastVisible = visible;
  for (const [id, total] of totals) if (total != null) outputTotals.set(id, total);
  if (targets.size === 0) return;
  enqueueSave({ onlyPtyIds: targets });
}

/** La cola de guardados. Los tests esperan a que el ciclo periódico termine de escribir. */
export function waitForSaves(): Promise<void> {
  return saveChain;
}

/** Centraliza el guardado automático del estado de tabs/ventana hacia SQLite. */
export function initTabsPersistence() {
  if (initialized) return;
  initialized = true;

  useTabsStore.subscribe((state, prevState) => {
    if (!state.hydrated) return;
    const visible = currentVisibleAgentTabIds();
    for (const tab of prevState.tabs) {
      if (
        tab.ptyId != null
        && lastVisible.has(tab.id)
        && !visible.has(tab.id)
        && state.tabs.some((next) => next.id === tab.id)
      ) {
        pendingRefresh.add(tab.ptyId);
      }
    }
    const removed = prevState.tabs.filter((tab) => !state.tabs.some((next) => next.id === tab.id));
    if (removed.length > 0) {
      const ids = new Set(removed.flatMap((tab) => (tab.ptyId == null ? [] : [tab.ptyId])));
      enqueueSnapshot(prevState.tabs, prevState.workspaceId, ids);
    }
    lastVisible = visible;
    if (
      state.tabs === prevState.tabs
      && state.workspaceId === prevState.workspaceId
      && state.activeTabId === prevState.activeTabId
    ) return;
    scheduleSave();
  });

  listen("cc-window-bounds-changed", () => {
    if (useTabsStore.getState().hydrated) scheduleSave();
  });

  // "Guardar workspace" mueve en la DB todas las ventanas abiertas del workspace de
  // origen. Esta ventana puede ser una de las movidas sin haber sido la que disparó el
  // guardado, así que adopta el id nuevo en vez de seguir autosalvando contra el viejo.
  listen<string>("cc-workspace-reassigned", (event) => {
    try {
      const { from, to } = JSON.parse(event.payload) as { from: string; to: string };
      const store = useTabsStore.getState();
      if (store.workspaceId === from && from !== to) store.setWorkspaceId(to);
    } catch {
      // payload malformado: no hay nada seguro que hacer, se ignora
    }
  });

  // Refresco periódico del scrollback de lo que se está viendo. Una pestaña oculta no
  // entra: se vuelca al salir de pantalla, al cerrarla o al cerrar la ventana.
  setInterval(() => void runPeriodicScrollbackSave(), SCROLLBACK_REFRESH_MS);

  // Sin listener de onCloseRequested a propósito: en Tauri 2, registrar uno
  // intercepta el cierre nativo de la ventana hasta que el JS responda, y eso
  // es justo lo que rompía el botón de cerrar. El cierre lo frena Rust y lo guarda
  // `saveForClose` con su barra de progreso (ver `app/closeWithSave.ts`).
}
