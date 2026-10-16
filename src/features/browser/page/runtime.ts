/**
 * El runtime de la página: lo que deja a un agente usar la página como la usaría una
 * persona, y lo que alimenta el panel de debug. NO es parte del bundle de la app: se
 * compila a un script suelto (`import runtimeScript from "./page/runtime.ts?script"`) y
 * el proxy lo sirve junto con el selector, justo después de `<head>`.
 *
 * Eso último importa: corre ANTES que cualquier script de la página, así que los errores,
 * logs y pedidos de red de la carga inicial —los que más interesan cuando algo no
 * arranca— quedan capturados desde el primero.
 *
 * Dos mitades que no se tocan:
 *
 * - **Captura**, siempre prendida: consola, errores sin atrapar, recursos que no cargaron
 *   y pedidos de red a otros orígenes. Se juntan y se mandan en tandas.
 * - **Órdenes**, solo cuando la app las pide: snapshot, click, tipear, leer el storage…
 *   Cada una contesta con el mismo `id` con que llegó.
 *
 * Todo lo que sale de acá es contenido de la página, y para un agente es DATO: un texto
 * de la página que diga "ignorá tus instrucciones" es texto de la página.
 */
import type {
  AppMessage, ConsoleEntry, ConsoleLevel, DebugBatch, PageCommand, PageMessage, PageNetworkEntry, StorageArea,
} from "../protocol";
import { createCursor } from "./cursor";
import { componentChain, describeElement, selectorOf } from "./dom";
import {
  errorKindOf, headerList, headerValue, parseRawHeaders, readResponseBody, requestBodyPreview, MAX_PAGE_BODY,
} from "./netCapture";
import { createActivity, describeWait, type SettleReport } from "./activity";
import { diffFingerprint, scopeSignature, staleMessage, type Fingerprint } from "./guard";
import { callerOf, clip, displayPath, formatConsoleArgs, formatValue, toTransferable } from "./serialize";
import {
  installCookieJar, installScrollbars, installStorageSync, JAR_HEADER, OWN_HEADER, takeNatives,
} from "./siteState";
import { findSponsoredBlocks, inSponsored } from "./sponsored";
import { isTouch, sendTouch, setTouch } from "./touch";
import { CORS_HEADER, CRED_HEADER, HEADERS_HEADER, corsMessage, routeRequest, type Routed } from "./route";
import {
  displayHref, distanceToBox, farFromWindow, formatSnapshot, normalizeName, humanizeId, parseKeyCombo, parseTarget, probePoints, snapToNearest, type Box4, type SnapshotNode,
} from "./snapshotFormat";

declare global {
  interface Window {
    __agsPage?: boolean;
    /** Lo último que marcó la persona; lo deja el selector (`picker.ts`). */
    __agsLastPick?: Element;
  }
}

(() => {
  if (window.__agsPage || window.parent === window) return;
  window.__agsPage = true;

  // Lo primero: la página no puede leer una cookie ni su storage antes de que estén en su
  // lugar (ver `siteState.ts`).
  const siteNatives = takeNatives();
  const cookieJar = installCookieJar(siteNatives);
  installStorageSync(siteNatives);
  installScrollbars();

  // Las referencias nativas se toman ahora, antes de que la página pueda envolverlas: un
  // `setTimeout` o un `fetch` parcheados por la página (mocks, polyfills) no pueden
  // romper la captura.
  const setTimer = window.setTimeout.bind(window);
  const clearTimer = window.clearTimeout.bind(window);
  const nativeFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  const reportError = console.error.bind(console);
  /** El origen real de la página (`http://localhost:5173`): lo antepone el proxy al servir
   *  este script. Sin él (una versión vieja del proxy) no se reescribe nada. */
  const targetOrigin: string | null = (self as { __ags_target?: string }).__ags_target ?? null;
  const route = (raw: string): Routed | null => routeRequest(raw, location.href, targetOrigin);

  const doc = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let parentOrigin: string | null = null;

  /** `false` si no se pudo mandar: todavía sin conectar, o algo que no se puede clonar. */
  function post(message: Omit<PageMessage, "source">, beforeConnect = false): boolean {
    if (!parentOrigin && !beforeConnect) return false;
    const full = { source: "ags-preview", ...message } as PageMessage;
    // El origen de la app se aprende del primer mensaje que manda; si el motor lo
    // serializa como "null" no hay a quién apuntar con precisión.
    const target = parentOrigin && parentOrigin !== "null" ? parentOrigin : "*";
    try {
      window.parent.postMessage(full, target);
      return true;
    } catch {
      return false;
    }
  }

  // ── Captura ───────────────────────────────────────────────────

  const MAX_QUEUE = 500;
  const pending: { console: ConsoleEntry[]; network: PageNetworkEntry[] } = { console: [], network: [] };
  let flushTimer: number | null = null;

  function flush(): void {
    if (flushTimer !== null) {
      clearTimer(flushTimer);
      flushTimer = null;
    }
    // Hasta conectar se acumula: lo que pasó durante la carga es justo lo que se quiere ver.
    if (!parentOrigin || (pending.console.length === 0 && pending.network.length === 0)) return;
    const batch: DebugBatch = {
      doc,
      url: location.href,
      console: pending.console.splice(0),
      network: pending.network.splice(0),
    };
    post({ type: "debug:batch", payload: batch });
  }

  function schedule(): void {
    if (flushTimer === null) flushTimer = setTimer(flush, 150);
  }

  function pushConsole(entry: ConsoleEntry): void {
    if (pending.console.length >= MAX_QUEUE) pending.console.shift();
    pending.console.push(entry);
    schedule();
  }

  function pushNetwork(entry: PageNetworkEntry): void {
    if (!recordingNet) return;
    if (pending.network.length >= MAX_QUEUE) pending.network.shift();
    pending.network.push(entry);
    schedule();
  }

  const LEVELS: ConsoleLevel[] = ["log", "info", "warn", "error", "debug"];
  const con = console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const level of LEVELS) {
    const original = con[level];
    if (typeof original !== "function") continue;
    con[level] = function (this: unknown, ...args: unknown[]) {
      try {
        pushConsole({ at: Date.now(), level, kind: "console", text: formatConsoleArgs(args), source: callerOf(new Error().stack) });
      } catch {
        /* capturar nunca puede impedir que la página loguee */
      }
      return original.apply(this, args);
    };
  }
  const originalAssert = con.assert;
  if (typeof originalAssert === "function") {
    con.assert = function (this: unknown, condition?: unknown, ...args: unknown[]) {
      if (!condition) {
        pushConsole({
          at: Date.now(), level: "error", kind: "console",
          text: `Assertion failed${args.length ? `: ${formatConsoleArgs(args)}` : ""}`,
          source: callerOf(new Error().stack),
        });
      }
      return originalAssert.call(this, condition, ...args);
    };
  }

  window.addEventListener("error", (event) => {
    const target = event.target as (Element & { src?: string; href?: string; currentSrc?: string }) | null;
    // En fase de captura también llegan los `<img>`/`<script>`/`<link>` que no cargaron:
    // esos no burbujean, y son la mitad de los "la página se ve rota".
    if (target && (target as unknown) !== window && target.nodeType === 1) {
      const url = target.currentSrc || target.src || target.href || "";
      pushConsole({
        at: Date.now(), level: "error", kind: "resource",
        text: `No cargó <${target.tagName.toLowerCase()}> ${url}`,
      });
      return;
    }
    const e = event as ErrorEvent;
    const error = e.error as { stack?: string } | undefined;
    pushConsole({
      at: Date.now(),
      level: "error",
      kind: "exception",
      text: clip(e.error ? formatValue(e.error) : e.message || "Error", 4000),
      source: e.filename ? `${displayPath(e.filename)}:${e.lineno}:${e.colno}` : callerOf(error?.stack),
      stack: error?.stack ? clip(String(error.stack), 3000) : undefined,
    });
  }, true);

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as { stack?: string } | undefined;
    pushConsole({
      at: Date.now(),
      level: "error",
      kind: "rejection",
      text: `Promesa rechazada sin catch: ${formatValue(event.reason)}`,
      source: callerOf(reason?.stack),
      stack: reason?.stack ? clip(String(reason.stack), 3000) : undefined,
    });
  });

  // Red. Los pedidos al propio servidor pasan por el proxy, que los registra mejor que
  // cualquier cosa que se pueda ver desde acá; la página solo cuenta los que van a OTRO
  // origen (una API en otro puerto, un CDN), que el proxy no ve.
  const isForeign = (url: string): boolean => {
    try {
      return new URL(url, location.href).origin !== location.origin;
    } catch {
      return false;
    }
  };
  const absolute = (url: string): string => {
    try {
      return new URL(url, location.href).href;
    } catch {
      return url;
    }
  };
  /** Pedidos sin terminar (fetch y XHR, de cualquier origen), la navegación en curso y la espera por estado
   *  (`activity.ts`): es lo que mira `wait { idle }` y lo que hace que una acción espere a una búsqueda lenta. Se cuenta
   *  siempre, con o sin panel de debug. */
  const activity = createActivity({
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimer(fn, ms),
    clearTimer: (handle) => clearTimer(handle as number),
    readyState: () => document.readyState,
    watchDom: (onChange) => {
      const observer = new MutationObserver(onChange);
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      return () => observer.disconnect();
    },
  });
  /** El panel de debug está abierto: solo ahí se anotan los pedidos (y se leen sus
   *  cuerpos), que es lo que cuesta. Arranca apagado en cada documento; la app lo prende. */
  let recordingNet = false;

  const sizeFrom = (header: string | null): number | null => {
    const n = header ? Number.parseInt(header, 10) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  };

  /**
   * Un `fetch` que va a otro origen (o al propio por URL absoluta), mandado por el proxy
   * (ver `route.ts`). Se arma un pedido nuevo con todo lo que pidió la página; lo que
   * cambia es adónde va y que las cookies y el CORS los resuelve el proxy.
   */
  async function routedFetch(routed: Routed, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    if (routed.forwarded) {
      headers.set(HEADERS_HEADER, [...request.headers.keys()].join(","));
      headers.set(OWN_HEADER, "1");
      headers.set(CRED_HEADER, request.credentials);
    }
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.blob();
    const endRequest = activity.begin();
    try {
      const response = await nativeFetch!(routed.url, {
        method: request.method,
        headers,
        body,
        credentials: "same-origin",
        redirect: request.redirect,
        signal: request.signal,
        cache: request.cache,
        referrerPolicy: request.referrerPolicy,
        keepalive: request.keepalive,
      });
      const blocked = routed.forwarded ? response.headers.get(CORS_HEADER) : null;
      if (blocked) {
        reportError(corsMessage(routed.original, targetOrigin, blocked));
        // En `no-cors` un navegador no falla: da una respuesta que no se puede leer.
        if (request.mode === "no-cors") return Response.error();
        throw new TypeError("Failed to fetch");
      }
      if (!routed.forwarded) cookieJar?.seen(response.headers.get(JAR_HEADER));
      return response;
    } finally {
      endRequest();
    }
  }

  if (nativeFetch) {
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      try {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const routed = route(raw);
        // Lo registra el proxy, con cookies y todo: acá no se anota.
        if (routed) return routedFetch(routed, input, init);
      } catch {
        /* un input raro: fetch decide */
      }
      let url = "";
      let method = "GET";
      try {
        url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
      } catch {
        /* un input raro: fetch decide */
      }
      const endRequest = activity.begin();
      let pendingFetch: Promise<Response>;
      try {
        pendingFetch = nativeFetch(input, init);
      } catch (e) {
        endRequest();
        throw e;
      }
      const result = pendingFetch.finally(endRequest);
      // Una respuesta del propio servidor puede haber puesto cookies: la página las tiene
      // que encontrar en `document.cookie` apenas la recibe.
      if (!url || !isForeign(url)) {
        return result.then((response) => {
          cookieJar?.seen(response.headers.get(JAR_HEADER));
          return response;
        });
      }
      if (!recordingNet) return result;
      const at = Date.now();
      const started = performance.now();
      let detail: Pick<PageNetworkEntry, "requestHeaders" | "requestBody"> = {};
      try {
        const requestHeaders = headerList(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        detail = {
          requestHeaders,
          requestBody: requestBodyPreview(init?.body ?? null, headerValue(requestHeaders, "content-type")),
        };
      } catch {
        /* capturar nunca puede romper el pedido */
      }
      const base = { at, method, url: absolute(url), type: "fetch", ...detail };
      return result.then(
        (response) => {
          const ttfbMs = Math.round(performance.now() - started);
          // El cuerpo se lee de un clon y sin demorar a la página: ella recibe su respuesta ya.
          readResponseBody(response, { timer: setTimer as typeof setTimeout })
            .catch(() => null)
            .then((responseBody) => {
              pushNetwork({
                ...base,
                status: response.status || null,
                statusText: response.statusText || null,
                ttfbMs,
                durationMs: Math.round(performance.now() - started),
                size: responseBody?.size ?? sizeFrom(response.headers.get("content-length")),
                responseHeaders: headerList(response.headers),
                responseBody,
                responseType: response.type,
                redirected: response.redirected,
                finalUrl: response.redirected ? response.url : null,
              });
            });
          return response;
        },
        (error: unknown) => {
          pushNetwork({
            ...base, status: null, durationMs: Math.round(performance.now() - started), size: null,
            error: formatValue(error), errorKind: errorKindOf(error),
          });
          throw error;
        }
      );
    };
  }

  const xhrInfo = new WeakMap<
    XMLHttpRequest,
    { method: string; url: string; headers: { name: string; value: string }[]; routed: Routed | null }
  >();
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  const xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    let routed: Routed | null = null;
    try { routed = route(String(url)); } catch { /* una URL rara: el XHR decide */ }
    xhrInfo.set(this, { method: String(method).toUpperCase(), url: String(url), headers: [], routed });
    return (xhrOpen as (...args: unknown[]) => void).call(this, method, routed ? routed.url : url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    xhrInfo.get(this)?.headers.push({ name: String(name).toLowerCase(), value: String(value) });
    return xhrSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const info = xhrInfo.get(this);
    const routed = info?.routed ?? null;
    if (routed?.forwarded) {
      xhrSetHeader.call(this, HEADERS_HEADER, [...new Set((info?.headers ?? []).map((h) => h.name))].join(","));
      xhrSetHeader.call(this, OWN_HEADER, "1");
      xhrSetHeader.call(this, CRED_HEADER, this.withCredentials ? "include" : "same-origin");
      let checked = false;
      this.addEventListener("readystatechange", () => {
        if (checked || this.readyState < XMLHttpRequest.HEADERS_RECEIVED) return;
        checked = true;
        const blocked = this.getResponseHeader(CORS_HEADER);
        if (blocked) reportError(corsMessage(routed.original, targetOrigin, blocked));
      });
    }
    if (info && (!isForeign(info.url) || (routed && !routed.forwarded)) && cookieJar) {
      let seen = false;
      this.addEventListener("readystatechange", () => {
        if (seen || this.readyState < XMLHttpRequest.HEADERS_RECEIVED) return;
        seen = true;
        cookieJar.seen(this.getResponseHeader(JAR_HEADER));
      });
    }
    // Todo XHR conta, do propio servidor o de otro origen: una búsqueda lenta casi siempre es del propio.
    const endRequest = activity.begin();
    this.addEventListener("loadend", endRequest);
    // Los que pasan por el proxy los registra él.
    if (info && isForeign(info.url) && !routed && recordingNet) {
      const at = Date.now();
      const started = performance.now();
      let ttfbMs: number | null = null;
      let ended: "abort" | "timeout" | null = null;
      this.addEventListener("readystatechange", () => {
        if (this.readyState === XMLHttpRequest.HEADERS_RECEIVED && ttfbMs === null) ttfbMs = Math.round(performance.now() - started);
      });
      this.addEventListener("abort", () => { ended = "abort"; });
      this.addEventListener("timeout", () => { ended = "timeout"; });
      this.addEventListener("loadend", () => {
        try {
          const responseHeaders = parseRawHeaders(this.getAllResponseHeaders());
          const contentType = headerValue(responseHeaders, "content-type");
          const failed = this.status === 0;
          pushNetwork({
            at, method: info.method, url: absolute(info.url), type: "xhr",
            status: this.status || null,
            statusText: this.statusText || null,
            ttfbMs,
            durationMs: Math.round(performance.now() - started),
            size: sizeFrom(this.getResponseHeader("content-length")),
            requestHeaders: info.headers,
            requestBody: requestBodyPreview(body ?? null, headerValue(info.headers, "content-type")),
            responseHeaders,
            responseBody: failed ? null : xhrBody(this, contentType),
            error: failed
              ? ended === "abort" ? "cancelado" : ended === "timeout" ? "se venció el tiempo de espera" : "sin respuesta (red caída o bloqueado por CORS)"
              : undefined,
            errorKind: failed ? (ended === "abort" ? "aborted" : ended === "timeout" ? "timeout" : "network") : undefined,
          });
        } catch {
          /* capturar nunca puede romper el pedido */
        }
      });
    }
    try {
      return xhrSend.call(this, body);
    } catch (e) {
      endRequest();
      throw e;
    }
  };

  /** El cuerpo de un XHR ya terminado, según cómo pidió la página leerlo. */
  function xhrBody(xhr: XMLHttpRequest, contentType: string | null): PageNetworkEntry["responseBody"] {
    if (xhr.responseType === "" || xhr.responseType === "text") {
      const text = xhr.responseText ?? "";
      return { size: text.length, text: text.slice(0, MAX_PAGE_BODY), truncated: text.length > MAX_PAGE_BODY, contentType };
    }
    if (xhr.responseType === "json") {
      const text = JSON.stringify(xhr.response) ?? "";
      return { size: null, text: text.slice(0, MAX_PAGE_BODY), truncated: text.length > MAX_PAGE_BODY, contentType };
    }
    return { size: null, truncated: false, contentType, summary: `responseType "${xhr.responseType}"` };
  }

  const vitals: { lcp: number | null; cls: number | null; longTasks: { count: number; totalMs: number } | null } = {
    lcp: null, cls: null, longTasks: null,
  };

  if (typeof PerformanceObserver === "function") {
    try {
      // El buffer por defecto es de 250 entradas: un servidor de desarrollo sirve más
      // módulos que eso en una sola carga.
      performance.setResourceTimingBufferSize?.(2000);
    } catch {
      /* no disponible */
    }
    const observe = (type: string, onEntries: (entries: PerformanceEntry[]) => void): boolean => {
      try {
        new PerformanceObserver((list) => onEntries(list.getEntries())).observe({ type, buffered: true });
        return true;
      } catch {
        return false;
      }
    };
    observe("resource", (entries) => {
      for (const entry of entries as PerformanceResourceTiming[]) {
        // fetch y XHR ya los cuentan sus envoltorios, con el status.
        if (entry.initiatorType === "fetch" || entry.initiatorType === "xmlhttprequest") continue;
        if (!isForeign(entry.name)) continue;
        const status = (entry as PerformanceResourceTiming & { responseStatus?: number }).responseStatus;
        pushNetwork({
          at: Math.round(performance.timeOrigin + entry.startTime),
          method: "GET",
          url: entry.name,
          status: status && status > 0 ? status : null,
          type: entry.initiatorType || "other",
          durationMs: Math.round(entry.duration),
          size: entry.transferSize > 0 ? entry.transferSize : null,
        });
      }
    });
    observe("largest-contentful-paint", (entries) => {
      const last = entries[entries.length - 1];
      if (last) vitals.lcp = Math.round(last.startTime);
    });
    if (observe("layout-shift", (entries) => {
      for (const entry of entries as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
        if (!entry.hadRecentInput) vitals.cls = (vitals.cls ?? 0) + entry.value;
      }
    })) vitals.cls = vitals.cls ?? 0;
    if (observe("longtask", (entries) => {
      const current = vitals.longTasks ?? { count: 0, totalMs: 0 };
      for (const entry of entries) {
        current.count += 1;
        current.totalMs += Math.round(entry.duration);
      }
      vitals.longTasks = current;
    })) vitals.longTasks = vitals.longTasks ?? { count: 0, totalMs: 0 };
  }

  // Los diálogos nativos (`alert`, `confirm`, `prompt`) frenan el motor hasta que alguien
  // contesta, y adentro de un iframe eso deja esperando a la app entera. Mientras maneja un
  // agente se contestan solos —si no, su acción quedaría colgada hasta que pase una
  // persona— y quedan anotados. Cuando la página la usa el usuario, el diálogo sale como
  // siempre: contestarle por él podría borrarle algo sin preguntar.
  const dialogs: { type: string; message: string; answer: string; at: number }[] = [];
  const dialogPolicy = { accept: true, text: "" };
  const nativeAlert = window.alert.bind(window);
  const nativeConfirm = window.confirm.bind(window);
  const nativePrompt = window.prompt.bind(window);
  /** Hay una orden de un agente en curso. */
  let driving = false;

  function recordDialog(type: string, message: string, answer: string): void {
    const entry = { type, message: clip(message, 1000), answer, at: Date.now() };
    dialogs.push(entry);
    if (dialogs.length > 50) dialogs.shift();
    pushConsole({
      at: entry.at, level: "info", kind: "dialog",
      text: `${type}(${entry.message}) → ${answer}`,
    });
  }

  window.alert = (message?: unknown) => {
    if (!driving) {
      recordDialog("alert", String(message ?? ""), "lo contestó el usuario");
      nativeAlert(message as string);
      return;
    }
    recordDialog("alert", String(message ?? ""), "aceptado por el agente");
  };
  window.confirm = (message?: string) => {
    if (!driving) {
      const answer = nativeConfirm(message);
      recordDialog("confirm", String(message ?? ""), answer ? "aceptado por el usuario" : "cancelado por el usuario");
      return answer;
    }
    recordDialog("confirm", String(message ?? ""), dialogPolicy.accept ? "aceptado por el agente" : "cancelado por el agente");
    return dialogPolicy.accept;
  };
  window.prompt = (message?: string, fallback?: string) => {
    if (!driving) {
      const answer = nativePrompt(message, fallback);
      recordDialog("prompt", String(message ?? ""), answer === null ? "cancelado por el usuario" : `"${answer}" (el usuario)`);
      return answer;
    }
    const answer = dialogPolicy.accept ? (dialogPolicy.text || fallback || "") : null;
    recordDialog("prompt", String(message ?? ""), answer === null ? "cancelado por el agente" : `"${answer}" (el agente)`);
    return answer;
  };

  window.addEventListener("pagehide", flush);

  // La navegación que empezó y todavía no cambió el documento (una búsqueda que el servidor tarda 8 s en contestar): la
  // acción que la provocó tiene que esperarla. `beforeunload` salta cuando el navegador va a salir de la página; la API
  // `navigation` (Chromium/WebView2) avisa también de un envío de formulario y dice si lo cancelaron.
  window.addEventListener("beforeunload", () => activity.markNavigation());
  const navigationApi = (window as unknown as { navigation?: EventTarget }).navigation;
  if (navigationApi) {
    navigationApi.addEventListener("navigate", (event) => {
      const nav = event as Event & { hashChange?: boolean; downloadRequest?: string | null; destination?: { sameDocument?: boolean } };
      if (nav.hashChange || nav.downloadRequest || nav.destination?.sameDocument !== false) return;
      activity.markNavigation();
      // Si la página la cancela (un router de SPA que maneja el envío), no hay navegación que esperar.
      queueMicrotask(() => { if (event.defaultPrevented) activity.clearNavigation(); });
    });
    navigationApi.addEventListener("navigateerror", () => activity.clearNavigation());
    navigationApi.addEventListener("navigatesuccess", () => activity.clearNavigation());
  }

  // ── Órdenes ───────────────────────────────────────────────────

  /** El puntero que muestra lo que está haciendo el agente. */
  const cursor = createCursor();
  const clipLabel = (text: string) => (text.length > 24 ? `${text.slice(0, 24)}…` : text);

  /** Los refs del último snapshot. Se reemplazan enteros con cada uno: un ref viejo que
   *  apunte a otra cosa sería peor que un ref que no existe. */
  let refs = new Map<string, Element>();

  /** Los refs de lo que marcó el usuario (`u1`, `u2`). Estos NO se borran con el snapshot
   *  siguiente: el agente los recibe cuando la persona señala algo y tiene que poder
   *  usarlos aunque mientras tanto haya vuelto a leer la página. */
  const marked = new Map<string, Element>();
  let markedSeq = 1;

  /** A impressão de cada ref no momento em que foi lido (ver `guard.ts`): antes de agir sobre um ref, o runtime tira
   *  outra e, se mudou, devolve `stale` sem tocar. Mesmo ciclo de vida dos refs: um snapshot novo substitui tudo. */
  let prints = new Map<string, Fingerprint>();
  const markedPrints = new Map<string, Fingerprint>();

  const INTERACTIVE_ROLES = new Set([
    "link", "button", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "slider",
    "spinbutton", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem",
  ]);
  /** Roles cuyo nombre es su propio texto: adentro no hay nada más que listar. */
  const NAME_FROM_CONTENT = new Set([...INTERACTIVE_ROLES, "heading", "listitem", "cell", "columnheader", "rowheader"]);
  const HAS_STRUCTURE = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary", "[role]", "[tabindex]",
    "[contenteditable]", "img[alt]:not([alt=''])", "h1", "h2", "h3", "h4", "h5", "h6", "iframe", "video", "ul", "ol", "table",
  ].join(",");
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "svg"]);
  const INPUT_ROLES: Record<string, string> = {
    checkbox: "checkbox", radio: "radio", range: "slider", button: "button", submit: "button",
    reset: "button", image: "button", file: "button", search: "searchbox", number: "spinbutton",
  };
  const TAG_ROLES: Record<string, string> = {
    BUTTON: "button", TEXTAREA: "textbox", SUMMARY: "button", H1: "heading", H2: "heading", H3: "heading",
    H4: "heading", H5: "heading", H6: "heading", NAV: "navigation", MAIN: "main", HEADER: "banner",
    FOOTER: "contentinfo", ASIDE: "complementary", FORM: "form", DIALOG: "dialog", UL: "list", OL: "list",
    LI: "listitem", TABLE: "table", TR: "row", TH: "columnheader", TD: "cell", IFRAME: "iframe", VIDEO: "video",
  };

  function roleOf(el: Element): string | null {
    const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
    if (explicit && explicit !== "presentation" && explicit !== "none") return explicit;
    switch (el.tagName) {
      case "A": return el.hasAttribute("href") ? "link" : null;
      case "INPUT": {
        const type = (el as HTMLInputElement).type;
        return type === "hidden" ? null : (INPUT_ROLES[type] ?? "textbox");
      }
      case "SELECT": {
        const select = el as HTMLSelectElement;
        return select.multiple || select.size > 1 ? "listbox" : "combobox";
      }
      case "IMG": return el.getAttribute("alt") === "" ? null : "img";
    }
    if (TAG_ROLES[el.tagName]) return TAG_ROLES[el.tagName];
    if ((el as HTMLElement).isContentEditable && !(el.parentElement as HTMLElement | null)?.isContentEditable) return "textbox";
    return null;
  }

  const isFormControl = (el: Element): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
    el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA";

  function textOf(el: Element): string {
    return (el as HTMLElement).innerText ?? el.textContent ?? "";
  }

  /** El texto de un `<label>` sin el del control que envuelve: el de un `<select>` son todas
   *  sus opciones, y "País Argentina Chile Uruguay" no es un nombre. */
  function labelText(label: Element): string {
    let text = "";
    for (const node of Array.from(label.childNodes)) {
      if (node.nodeType === 3) text += node.textContent ?? "";
      else if (node.nodeType === 1 && !isFormControl(node as Element)) {
        text += (node as Element).querySelector("input,select,textarea") ? labelText(node as Element) : textOf(node as Element);
      }
    }
    return text;
  }

  function nameOf(el: Element, role: string): string {
    const aria = el.getAttribute("aria-label");
    if (aria?.trim()) return normalizeName(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      if (text.trim()) return normalizeName(text);
    }
    if (isFormControl(el)) {
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length) return normalizeName(Array.from(labels).map(labelText).join(" "));
      const input = el as HTMLInputElement;
      if (["button", "submit", "reset"].includes(input.type)) return normalizeName(input.value || input.type);
      return normalizeName(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "");
    }
    if (el.tagName === "IMG") return normalizeName(el.getAttribute("alt") || el.getAttribute("title") || "");
    if (NAME_FROM_CONTENT.has(role)) {
      const text = normalizeName(textOf(el));
      if (text) return text;
      // Un botón que es solo un icono: el nombre está en el `alt` o en el `<title>` del SVG.
      const img = el.querySelector("img[alt], svg title");
      const inner = img?.getAttribute("alt") || img?.textContent || "";
      return normalizeName(inner || el.getAttribute("title") || idHint(el));
    }
    return normalizeName(el.getAttribute("title") || idHint(el));
  }

  /** Sem nome nenhum, o `id` ou o `data-testid` costuma dizer o que é ("nav-search-submit-button"). */
  function idHint(el: Element): string {
    for (const attribute of ["data-testid", "data-test", "data-qa", "data-cy", "id", "name"]) {
      const hint = humanizeId(el.getAttribute(attribute));
      if (hint) return hint;
    }
    // Sem id, as classes de uma loja costumam dizer o que é ("nav-search-submit"): a de mais palavras.
    let best = "";
    let bestWords = 0;
    for (const token of Array.from(el.classList)) {
      const hint = humanizeId(token);
      const count = hint ? hint.split(" ").length : 0;
      if (count > bestWords) { best = hint; bestWords = count; }
    }
    return best;
  }

  /** Os controles que são ligados/desligados: a ausência de `checked` neles é um estado (`unchecked`), não um detalhe. */
  const CHECKABLE_ROLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);

  function isDisabled(el: Element): boolean {
    if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return true;
    // Um campo dentro de `<fieldset disabled>` não tem o atributo, mas está desabilitado do mesmo jeito.
    if (isFormControl(el) || el.tagName === "BUTTON") {
      if (el.closest("fieldset[disabled]") && !el.closest("legend")) return true;
      try { return el.matches(":disabled"); } catch { return false; }
    }
    return false;
  }

  function statesOf(el: Element, role: string): string[] {
    const states: string[] = [];
    const attr = (name: string) => el.getAttribute(name);
    if (isDisabled(el)) states.push("disabled");
    const checked = (el as HTMLInputElement).checked || attr("aria-checked") === "true";
    if (checked) states.push("checked");
    else if (CHECKABLE_ROLES.has(role) && attr("aria-checked") !== "mixed" && !(el as HTMLInputElement).indeterminate) states.push("unchecked");
    if (attr("aria-checked") === "mixed" || attr("aria-pressed") === "mixed" || (el as HTMLInputElement).indeterminate) states.push("mixed");
    // `<summary>` abre e fecha o `<details>` que o contém: o estado está no pai.
    const details = el.tagName === "SUMMARY" ? el.parentElement : null;
    if (attr("aria-expanded") === "true" || (details?.tagName === "DETAILS" && (details as HTMLDetailsElement).open)) states.push("expanded");
    if (attr("aria-expanded") === "false" || (details?.tagName === "DETAILS" && !(details as HTMLDetailsElement).open)) states.push("collapsed");
    if (attr("aria-selected") === "true" || (el as HTMLOptionElement).selected) states.push("selected");
    const current = attr("aria-current");
    if (current && current !== "false") states.push("current");
    if (attr("aria-busy") === "true") states.push("busy");
    if (attr("aria-pressed") === "true") states.push("pressed");
    if ((el as HTMLInputElement).required || attr("aria-required") === "true") states.push("required");
    if ((el as HTMLInputElement).readOnly) states.push("readonly");
    if (attr("aria-invalid") === "true") states.push("invalid");
    if (role === "heading") states.push(`level=${attr("aria-level") ?? el.tagName.slice(1)}`);
    if (document.activeElement === el) states.push("focused");
    if (el.tagName === "DIALOG" && (el as HTMLDialogElement).open) states.push("open");
    return states;
  }

  function valueOf(el: Element): string | undefined {
    if (el.tagName === "SELECT") {
      const select = el as HTMLSelectElement;
      return normalizeName(Array.from(select.selectedOptions).map((o) => o.text).join(", "), 100);
    }
    if (el.tagName === "TEXTAREA") {
      const v = (el as HTMLTextAreaElement).value;
      return v ? normalizeName(v, 100) : undefined;
    }
    if (el.tagName === "INPUT") {
      const input = el as HTMLInputElement;
      if (["checkbox", "radio", "button", "submit", "reset", "image", "file"].includes(input.type) || !input.value) return undefined;
      // La contraseña no sale de la página: alcanza con saber que hay algo escrito.
      return input.type === "password" ? "•".repeat(Math.min(input.value.length, 8)) : normalizeName(input.value, 100);
    }
    if ((el as HTMLElement).isContentEditable) return normalizeName(textOf(el), 100) || undefined;
    return undefined;
  }

  const SCOPE_SELECTOR = "form,dialog,[role=dialog],li,tr,[role=listitem],[role=row]";

  /** A impressão de um elemento (`guard.ts`). `scopes` guarda o texto de cada escopo já lido: dezenas de botões do mesmo
   *  `<li>`/`<form>` não releem o texto a cada um. */
  function fingerprintOf(el: Element, scopes?: Map<Element, string>): Fingerprint {
    const role = roleOf(el) ?? "clickable";
    const scopeEl = el.closest(SCOPE_SELECTOR);
    let scope = "";
    if (scopeEl) {
      const cached = scopes?.get(scopeEl);
      if (cached !== undefined) scope = cached;
      else {
        scope = scopeSignature(scopeEl.textContent);
        scopes?.set(scopeEl, scope);
      }
    }
    return {
      role,
      name: nameOf(el, role),
      value: valueOf(el) ?? "",
      checked: !!(el as HTMLInputElement).checked || el.getAttribute("aria-checked") === "true",
      disabled: !!(el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true",
      href: el.getAttribute("href") ?? "",
      scope,
    };
  }

  /** Algo que la página hizo clickeable sin decirlo (`<div onClick>`): se delata por el
   *  cursor, que es lo mismo que mira una persona para saber si algo se toca. */
  function looksClickable(el: Element, style: CSSStyleDeclaration): boolean {
    if ((el as HTMLElement).tabIndex >= 0 && el.hasAttribute("tabindex")) return true;
    if (style.cursor !== "pointer") return false;
    const parent = el.parentElement;
    return !parent || getComputedStyle(parent).cursor !== "pointer";
  }

  function snapshot(all: boolean, inView = false): string {
    refs = new Map();
    prints = new Map();
    const scopes = new Map<Element, string>();
    // Os blocos de anúncio da página (`sponsored.ts`): tudo o que está dentro ganha `[patrocinado]`.
    const adBlocks = findSponsoredBlocks(document);
    const adMemo = new Map<Element, boolean>();
    const nodes: SnapshotNode[] = [];
    const limit = all ? 3000 : 600;
    /** Fora da janela (rolar traz) e além do limite de nós, separados: dizem coisas diferentes ao agente. */
    let outOfView = 0;
    let overLimit = 0;
    let outOfViewControls = 0;
    let overLimitControls = 0;
    let nextRef = 1;

    // `inView` (o piloto): só o que está na janela e perto dela (meia tela acima, uma abaixo). Numa página longa os 600
    // primeiros nós, em ordem de página, são o menu e o rodapé: o que importa (os resultados) ficava de fora.
    const viewHeight = window.innerHeight;
    const farFromView = (el: Element | null): boolean => {
      if (!inView || !el) return false;
      const r = el.getBoundingClientRect();
      // O estilo só se lê quando o elemento já está longe (é o caso raro).
      return farFromWindow(r, viewHeight, farFromWindow(r, viewHeight, "static") ? getComputedStyle(el).position : "static");
    };

    const add = (node: SnapshotNode): void => {
      if (nodes.length >= limit) {
        overLimit += 1;
        if (node.ref) overLimitControls += 1;
      } else nodes.push(node);
    };

    const walkChildren = (parent: Node, depth: number): void => {
      const host = parent as Element;
      const children: Node[] = host.shadowRoot ? Array.from(host.shadowRoot.childNodes) : Array.from(parent.childNodes);
      // El texto de un label que envuelve su control ya es el nombre del control: listarlo
      // aparte lo repetiría en la línea de arriba.
      const labelsControl = host.tagName === "LABEL" && !!(host as HTMLLabelElement).control;
      for (const child of children) {
        if (labelsControl && child.nodeType === 3) continue;
        walk(child, depth);
      }
    };

    const walk = (node: Node, depth: number): void => {
      if (node.nodeType === 3) {
        const text = normalizeName(node.textContent ?? "", 200);
        if (text && farFromView(node.parentElement)) outOfView += 1;
        else if (text) add({ depth, role: "text", name: text, states: [] });
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node as Element;
      if (SKIP_TAGS.has(el.tagName) || el.getAttribute("aria-hidden") === "true") return;
      if (el.tagName === "SLOT") {
        for (const assigned of (el as HTMLSlotElement).assignedNodes({ flatten: true })) walk(assigned, depth);
        return;
      }
      const style = getComputedStyle(el);
      if (style.display === "none") return;
      const visible = style.visibility !== "hidden" && (style.display === "contents" || el.getClientRects().length > 0);

      let role = roleOf(el);
      if (!role && visible && looksClickable(el, style)) role = "clickable";
      if (!role || !visible) {
        // Un contenedor sin rol no se lista, pero lo que tiene adentro sí. Si adentro no hay
        // nada más que texto, va entero en una línea en vez de un renglón por nodo de texto.
        if (visible && !el.shadowRoot && !el.querySelector(HAS_STRUCTURE) && el.childElementCount > 0) {
          const text = normalizeName(textOf(el), 200);
          if (text && farFromView(el)) outOfView += 1;
          else if (text) add({ depth, role: "text", name: text, states: [] });
          return;
        }
        walkChildren(el, depth);
        return;
      }

      // Uma lista ARIA própria (`ul role=listbox` de um autocomplete) não se toca: o que se toca são as opções dela, que têm de
      // aparecer uma a uma. (A lista nativa `<select>` segue sendo um controle só, com as opções em `options=`.)
      const customListbox = role === "listbox" && el.tagName !== "SELECT";
      const interactive = (INTERACTIVE_ROLES.has(role) && !customListbox) || role === "clickable";
      const leaf = interactive || (NAME_FROM_CONTENT.has(role) && !el.querySelector(HAS_STRUCTURE));
      // Longe da janela e sem filhos a listar: nem ref nem linha (`omitted` diz que há mais, e rolar traz).
      if (leaf && farFromView(el)) {
        outOfView += 1;
        if (interactive) outOfViewControls += 1;
        return;
      }
      const entry: SnapshotNode = {
        depth,
        role,
        name: leaf || !NAME_FROM_CONTENT.has(role) ? nameOf(el, role) : normalizeName(el.getAttribute("aria-label") ?? ""),
        states: statesOf(el, role),
        value: valueOf(el),
      };
      if (adBlocks.size > 0 && inSponsored(el, adBlocks, adMemo)) entry.states.push("patrocinado");
      if (interactive) {
        entry.ref = `e${nextRef++}`;
        refs.set(entry.ref, el);
        prints.set(entry.ref, fingerprintOf(el, scopes));
      }
      if (el.tagName === "A") {
        const href = (el as HTMLAnchorElement).href;
        if (href) entry.href = displayHref(href, location.origin);
      }
      if (el.tagName === "SELECT") {
        // As opções de uma lista nativa: é o que um agente (ou o piloto) escolhe ("Preço: do menor ao maior").
        const options = Array.from((el as HTMLSelectElement).options).slice(0, 40).map((o) => normalizeName(o.text, 60)).filter(Boolean);
        if (options.length > 0) entry.options = options;
      }
      add(entry);
      if (!leaf) walkChildren(el, depth + 1);
    };

    if (document.body) walkChildren(document.body, 0);
    const root = document.documentElement;
    return formatSnapshot(nodes, {
      url: location.href,
      title: document.title,
      viewport: { width: root.clientWidth, height: window.innerHeight },
      scrollY: window.scrollY,
      documentHeight: root.scrollHeight,
      omitted: outOfView + overLimit,
      outOfView,
      overLimit,
      outOfViewControls,
      overLimitControls,
      limit,
    });
  }

  function isVisible(el: Element): boolean {
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
  }

  /** Os controles clicáveis da janela, com a caixa de cada um. */
  function collectClickables(): { el: Element; box: Box4 }[] {
    const area = window.innerWidth * window.innerHeight;
    const found: { el: Element; box: Box4 }[] = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const role = roleOf(el);
      if (!(role && INTERACTIVE_ROLES.has(role)) && !looksClickable(el, style)) continue;
      const r = el.getBoundingClientRect();
      // Um contêiner enorme que só tem `cursor: pointer` não é o alvo de um toque.
      if (r.width < 2 || r.height < 2 || r.width * r.height > area * 0.4) continue;
      found.push({ el, box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
    }
    return found;
  }

  /** Um controle sem nome (um ícone): só a imagem diz o que é. */
  function isUnnamed(el: Element): boolean {
    return nameOf(el, roleOf(el) || "clickable") === "";
  }

  /** O último ponto tocado por foto (o controle que ficou com ele) e quantos controles SEM NOME havia perto dele. */
  let lastPoint: { el: Element; unnamed: boolean } | null = null;
  let pointNeighbors = 0;

  /** O controle clicável que fica com um ponto: ver `snapToNearest`. `null` = nenhum perto. */
  function clickableNear(x: number, y: number): Element | null {
    const found = collectClickables();
    const hit = snapToNearest(found.map((f) => f.box), x, y);
    if (hit && "ambiguous" in hit) throw new Error(`Há mais de um controle perto do ponto (${Math.round(x)}, ${Math.round(y)}): não sei qual tocar.`);
    return hit ? found[hit.index].el : null;
  }

  /** `act`: vai agir sobre o elemento (tocar, digitar, escolher…). Um ref que já não é o que foi lido não é usado: ver `guard.ts`. */
  function resolve(target: string, act = false): Element {
    // Lo último que la persona marcó con el selector: se resuelve por identidad y no por
    // su selector, que podría no volver a encontrarlo.
    if (target === "pick") {
      const picked = window.__agsLastPick;
      if (!picked) throw new Error("A pessoa ainda não marcou nada.");
      if (!picked.isConnected) throw new Error("O que a pessoa marcou não está mais na página.");
      return picked;
    }
    const spec = parseTarget(target);
    if (spec.kind === "ref") {
      const el = refs.get(spec.ref) ?? marked.get(spec.ref);
      if (!el) throw new Error(`Não há nenhum elemento ${spec.ref}: tire um novo snapshot (os refs mudam a cada um).`);
      if (!el.isConnected) throw new Error(`${spec.ref} não está mais na página (mudou desde o último snapshot): tire um novo.`);
      const printed = prints.get(spec.ref) ?? markedPrints.get(spec.ref);
      if (act && printed) {
        const diff = diffFingerprint(printed, fingerprintOf(el));
        if (diff) throw new Error(staleMessage(spec.ref, diff));
      }
      return el;
    }
    if (spec.kind === "point") {
      pointNeighbors = 0;
      // O segundo toque: a foto apontou entre dois ícones sem nome, o primeiro não era o certo; o vizinho sem nome mais perto do ponto.
      if (spec.second) {
        const previous = lastPoint;
        if (!previous || !previous.unnamed) throw new Error("O toque anterior não foi num controle sem nome: não há vizinho a tentar.");
        const others = collectClickables()
          .filter((f) => f.el !== previous.el && !previous.el.contains(f.el) && !f.el.contains(previous.el) && isUnnamed(f.el))
          .map((f) => ({ el: f.el, d: distanceToBox(f.box, spec.x, spec.y) }))
          .filter((c) => c.d <= 80)
          .sort((a, b) => a.d - b.d);
        if (others.length === 0) throw new Error("Não há outro controle sem nome perto do ponto.");
        if (act) lastPoint = { el: others[0].el, unnamed: true };
        return others[0].el;
      }
      // O que há sob o ponto; se está dentro de algo clicável (um ícone dentro de um link), o clicável.
      const under = document.elementFromPoint(spec.x, spec.y);
      if (!under) throw new Error(`Não há nada no ponto (${Math.round(spec.x)}, ${Math.round(spec.y)}): fora da janela da página.`);
      const direct = under.closest("a[href],button,[role=button],[role=link],input,select,textarea,label,summary,[role=tab],[role=menuitem],[role=option],[onclick]");
      // Um ponto que caiu no vazio ao lado de um controle (a foto erra alguns pixels): vai para o clicável mais perto.
      const chosen = direct ?? clickableNear(spec.x, spec.y);
      if (!chosen) throw new Error(`Não há nada clicável perto do ponto (${Math.round(spec.x)}, ${Math.round(spec.y)}).`);
      if (act) {
        const unnamed = isUnnamed(chosen);
        lastPoint = { el: chosen, unnamed };
        // Quantos outros controles sem nome há até 60 px do ponto: com algum, o piloto pode tentar o vizinho se este não era o certo.
        if (unnamed) {
          pointNeighbors = collectClickables()
            .filter((f) => f.el !== chosen && !chosen.contains(f.el) && !f.el.contains(chosen) && isUnnamed(f.el) && distanceToBox(f.box, spec.x, spec.y) <= 60).length;
        }
      }
      return chosen;
    }
    if (spec.kind === "text") {
      const wanted = spec.text.toLowerCase();
      const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
      let partial: Element | null = null;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const parent = n.parentElement;
        if (!parent || !isVisible(parent)) continue;
        const text = normalizeName(n.textContent ?? "", 10_000).toLowerCase();
        const hit = parent.closest("a[href],button,[role=button],[role=link],label,summary,[role=tab],[role=menuitem],[role=option]") ?? parent;
        if (text === wanted) return hit;
        if (!partial && text.includes(wanted)) partial = hit;
      }
      if (partial) return partial;
      throw new Error(`Não há nenhum elemento visível com o texto "${spec.text}".`);
    }
    let el: Element | null;
    try {
      el = document.querySelector(spec.selector);
    } catch {
      throw new Error(`"${spec.selector}" não é um ref (e12), um texto (text=Entrar) nem um seletor CSS válido.`);
    }
    if (!el) throw new Error(`Ningún elemento coincide con "${spec.selector}".`);
    return el;
  }

  /** Espera a que la página termine de reaccionar: sin cambios en el DOM por un rato, o el
   *  tope. Con timers y no con frames: un iframe que no se está mostrando no pinta. */
  /** O comando em curso é do piloto do Jev: esperas curtas (a página que mudou depois é lida de novo, é barato). */
  let fastCommand = false;
  /** Os pedidos que já estavam em voo quando o comando começou: não são «da ação» (ver `SettleOptions.baseline`). */
  let commandBaseline: ReadonlySet<number> | undefined;

  /** Até quando esperar algo pendente (navegação, pedidos, documento carregando), por tipo de ação. Uma busca é a que
   *  mais demora (a Amazon leva ~8 s); digitar só espera uma sugestão; o resto, o que uma página costuma levar. */
  const PENDING_MS = { navigate: 12_000, select: 10_000, drag: 6_000, scroll: 4_000, type: 3_000, hover: 2_000 } as const;

  /**
   * Espera a página reagir à ação, por ESTADO (`activity.ts`): sem navegação em curso, rede ociosa e DOM quieto. `maxMs` é o
   * teto quando nada ficou pendente; `pendingMs`, o teto quando algo ficou. Com timers e não com frames: um iframe que não
   * se está mostrando não pinta. Devolve o relatório do que esperou.
   */
  function settle(maxMs = 1500, quietMs = 150, pendingMs: number = PENDING_MS.navigate): Promise<SettleReport> {
    if (fastCommand) {
      // O repositório jev-ultrafast espera 2 quadros ou 50 ms. Aqui, quieto por 60 ms e no máximo 350 ms (um React que re-renderiza).
      maxMs = Math.min(maxMs, 350);
      quietMs = Math.min(quietMs, 60);
    }
    return activity.settle({
      maxMs, quietMs, pendingMaxMs: pendingMs, netIdleMs: fastCommand ? 120 : 250, minMs: fastCommand ? 100 : quietMs,
      baseline: commandBaseline,
    });
  }

  /** O que a espera conta no resultado do comando (só quando valeu a pena contar). */
  function waitedField(report: SettleReport): { waited?: string } {
    const note = describeWait(report);
    return note ? { waited: note } : {};
  }

  /** A espera explícita do piloto/ponte: depois de uma navegação ou quando o Jev pede para esperar. Conta TODOS os pedidos
   *  em voo (a página nova acabou de carregar e os pedidos dela são justo o que se quer esperar). */
  async function settleOp(command: Extract<PageCommand, { op: "settle" }>): Promise<unknown> {
    const report = await activity.settle({
      maxMs: command.fast ? 350 : 1500, quietMs: command.fast ? 60 : 150, netIdleMs: command.fast ? 120 : 250,
      pendingMaxMs: Math.min(Math.max(command.ceilingMs ?? PENDING_MS.navigate, 0), 14_000), minMs: 0,
    });
    return {
      settled: report.reason, readyState: document.readyState, pendingRequests: activity.size(), navigating: activity.navigating(),
      ...waitedField(report), waitedMs: report.waitedMs,
    };
  }

  function mouse(el: Element, type: string, x: number, y: number): boolean {
    const init: MouseEventInit = {
      bubbles: !type.endsWith("enter"), cancelable: true, composed: true,
      clientX: x, clientY: y, button: 0, buttons: type.endsWith("down") ? 1 : 0, view: window,
    };
    const event = type.startsWith("pointer") && typeof PointerEvent === "function"
      ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: isTouch() ? "touch" : "mouse", isPrimary: true })
      : new MouseEvent(type.replace("pointer", "mouse"), init);
    return el.dispatchEvent(event);
  }

  /** Dónde tocar el elemento, trayéndolo a la vista. Falla si otra cosa lo tapa: eso es un
   *  bug de la página (un overlay que quedó abierto), y un click que lo atraviesa lo
   *  escondería. */
  function aim(el: Element): { x: number; y: number; target: Element } {
    el.scrollIntoView({ block: "center", inline: "center" });
    let target = el;
    let rect = el.getBoundingClientRect();
    // Los checkbox "lindos" esconden el input (0×0 o transparente) y se tocan por su label.
    const labels = isFormControl(el) ? (el as HTMLInputElement).labels : null;
    if ((rect.width === 0 || rect.height === 0) && labels && labels.length) {
      target = labels[0];
      target.scrollIntoView({ block: "center", inline: "center" });
      rect = target.getBoundingClientRect();
    }
    if (rect.width === 0 || rect.height === 0) throw new Error(`${describeElement(el)} não está visível (mede 0×0).`);
    const reaches = (hit: Element | null) => !hit || hit === target || target.contains(hit) || hit.contains(target)
      || (labels !== null && Array.from(labels).some((l) => l === hit || l.contains(hit)));
    // Uma camada decorativa sobre o centro (o corte de um título numa loja) não impede um clique de verdade em outro ponto
    // do elemento: tenta o centro e, se está coberto, as bordas. Só falha se NENHUM ponto chega ao elemento.
    const clear = probePoints(rect).find((point) => reaches(document.elementFromPoint(point.x, point.y)));
    if (!clear) {
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      throw new Error(`${describeElement(el)} está coberto por ${hit ? describeElement(hit) : "outro elemento"} (${hit ? selectorOf(hit) : "?"}). `
        + "Se for um modal ou overlay, feche-o primeiro; se for preciso forçar, use eval.");
    }
    return { x: clear.x, y: clear.y, target };
  }

  async function click(el: Element): Promise<unknown> {
    if ((el as HTMLButtonElement).disabled) throw new Error(`${describeElement(el)} está desabilitado.`);
    await cursor.toElement(el, "click");
    cursor.click();
    const { x, y, target } = aim(el);
    const before = location.href;
    // Un dedo no pasa por encima antes de apretar: va directo. Es la diferencia que rompe
    // un menú que solo se abre con `:hover`, y por eso se emula en vez de simplificarse.
    const approach = isTouch() ? ["pointerdown"] : ["pointerover", "pointerenter", "pointermove", "pointerdown"];
    if (isTouch()) sendTouch(target, "touchstart", x, y);
    for (const type of approach) mouse(target, type, x, y);
    if (typeof (target as HTMLElement).focus === "function") (target as HTMLElement).focus({ preventScroll: true });
    if (isTouch()) sendTouch(target, "touchend", x, y);
    mouse(target, "pointerup", x, y);
    // `click()` y no un MouseEvent a mano: dispara lo que hace el navegador con un click de
    // verdad (seguir el link, marcar el checkbox, enviar el form).
    if (typeof (target as HTMLElement).click === "function") (target as HTMLElement).click();
    else mouse(target, "click", x, y);
    const waited = await settle();
    return {
      clicked: describeElement(el),
      ...(location.href !== before ? { url: location.href } : {}),
      ...invalidForm(target),
      ...waitedField(waited),
    };
  }

  /** Un submit que el navegador frenó por validación no hace nada visible: sin decirlo, el
   *  agente creería que la página ignoró el click. */
  function invalidForm(el: Element): { formInvalid?: { field: string; message: string }[] } {
    const button = el as HTMLButtonElement | HTMLInputElement;
    const isSubmit = (el.tagName === "BUTTON" && (button.type === "submit" || !el.getAttribute("type")))
      || (el.tagName === "INPUT" && button.type === "submit");
    const form = isSubmit ? button.form : null;
    if (!form || form.noValidate || form.checkValidity()) return {};
    const fields = Array.from(form.elements) as HTMLInputElement[];
    return {
      formInvalid: fields
        .filter((f) => typeof f.checkValidity === "function" && !f.checkValidity())
        .slice(0, 10)
        .map((f) => ({ field: describeElement(f), message: f.validationMessage })),
    };
  }

  function nativeSetValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    // El setter del prototipo, no `el.value = …`: React guarda el último valor que vio y,
    // si se asigna directo, cree que no cambió nada y descarta el evento.
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function inputEvent(el: Element, data: string | null): void {
    const event = typeof InputEvent === "function"
      ? new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data })
      : new Event("input", { bubbles: true, composed: true });
    el.dispatchEvent(event);
  }

  /** Um campo que abre uma lista de sugestões ao digitar (autocomplete): `role=combobox`, `aria-autocomplete` de lista, ou
   *  `aria-haspopup=listbox`, ou um popup controlado (`aria-controls` + `aria-expanded`). */
  function isCombobox(el: Element): boolean {
    if (el.getAttribute("role")?.trim().split(/s+/)[0] === "combobox") return true;
    const auto = el.getAttribute("aria-autocomplete");
    if (auto === "list" || auto === "both") return true;
    if (el.getAttribute("aria-haspopup") === "listbox") return true;
    return el.hasAttribute("aria-expanded") && (el.hasAttribute("aria-controls") || el.hasAttribute("aria-owns"));
  }

  /** As opções visíveis da lista de um combobox: a que ele controla, ou, sem essa ligação, qualquer opção visível. */
  function visibleOptions(el: Element): Element[] {
    const ids = `${el.getAttribute("aria-controls") ?? ""} ${el.getAttribute("aria-owns") ?? ""}`.split(/s+/).filter(Boolean);
    const roots = ids.map((id) => document.getElementById(id)).filter((n): n is HTMLElement => !!n);
    const found = roots.length > 0
      ? roots.flatMap((root) => (root.getAttribute("role") === "option" ? [root] : Array.from(root.querySelectorAll("[role=option]"))))
      : Array.from(document.querySelectorAll("[role=option]"));
    return found.filter(isVisible);
  }

  /** Quanto esperar as sugestões depois de digitar (o jev-ultrafast espera ≤ 200 ms): passado isso, o Jev lê o que houver. */
  const COMBOBOX_OPTIONS_MS = 200;

  /** Espera as opções aparecerem, no máximo `COMBOBOX_OPTIONS_MS` desde `typedAt`. Devolve quantas há. */
  async function optionsAppear(el: Element, typedAt: number): Promise<number> {
    for (;;) {
      const count = visibleOptions(el).length;
      if (count > 0) {
        // As opções chegam de uma vez, mas a lista costuma terminar de pintar um instante depois.
        await new Promise<void>((done) => setTimer(done, 30));
        return visibleOptions(el).length;
      }
      if (Date.now() - typedAt >= COMBOBOX_OPTIONS_MS) return 0;
      await new Promise<void>((done) => setTimer(done, 25));
    }
  }

  async function type(el: Element, text: string, clear: boolean, submit: boolean): Promise<unknown> {
    if ((el as HTMLInputElement).disabled) throw new Error(`${describeElement(el)} está desabilitado.`);
    await cursor.toElement(el, `type "${clipLabel(text)}"`);
    (el as HTMLElement).focus?.({ preventScroll: false });
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const field = el as HTMLInputElement | HTMLTextAreaElement;
      if (["checkbox", "radio", "button", "submit", "file"].includes((field as HTMLInputElement).type)) {
        throw new Error(`${describeElement(el)} es un ${(field as HTMLInputElement).type}: use com click, não digitando.`);
      }
      if ((field as HTMLInputElement).readOnly) throw new Error(`${describeElement(el)} é somente leitura.`);
      nativeSetValue(field, clear ? text : field.value + text);
      inputEvent(field, text);
      field.dispatchEvent(new Event("change", { bubbles: true }));
    } else if ((el as HTMLElement).isContentEditable) {
      if (clear) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      if (!document.execCommand("insertText", false, text)) {
        el.textContent = clear ? text : `${el.textContent ?? ""}${text}`;
        inputEvent(el, text);
      }
    } else {
      throw new Error(`${describeElement(el)} não é um campo de texto.`);
    }
    if (submit) return press("Enter", el);
    const combobox = isCombobox(el);
    const typedAt = Date.now();
    const waited = await settle(800, 150, PENDING_MS.type);
    // Um autocomplete mostra as sugestões um instante depois de digitar; sem esperar, o Jev lê a lista vazia e aperta Enter.
    const options = combobox ? await optionsAppear(el, typedAt) : null;
    return { typed: describeElement(el), value: valueOf(el) ?? "", ...(options !== null ? { options } : {}), ...waitedField(waited) };
  }

  function focusables(): HTMLElement[] {
    const all = Array.from(document.querySelectorAll<HTMLElement>(
      "a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex],[contenteditable]"
    )).filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && isVisible(el));
    const positive = all.filter((el) => el.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex);
    return [...positive, ...all.filter((el) => el.tabIndex === 0)];
  }

  const CLICK_ON_ENTER = new Set(["A", "BUTTON", "SUMMARY"]);

  async function press(key: string, targetEl?: Element): Promise<unknown> {
    const combo = parseKeyCombo(key);
    const el = targetEl ?? document.activeElement ?? document.body;
    if (el instanceof Element && el !== document.body) await cursor.toElement(el, `key ${key}`);
    else cursor.say(`key ${key}`);
    if (targetEl) (targetEl as HTMLElement).focus?.({ preventScroll: false });
    const code = /^[a-z]$/i.test(combo.key) ? `Key${combo.key.toUpperCase()}`
      : /^\d$/.test(combo.key) ? `Digit${combo.key}` : combo.key === " " ? "Space" : combo.key;
    const init: KeyboardEventInit = {
      key: combo.key, code, bubbles: true, cancelable: true, composed: true,
      ctrlKey: combo.ctrlKey, shiftKey: combo.shiftKey, altKey: combo.altKey, metaKey: combo.metaKey,
    };
    const proceed = el.dispatchEvent(new KeyboardEvent("keydown", init));

    // Una tecla sintética no hace lo que haría el teclado de verdad: eso se simula acá,
    // salvo que la página la haya cancelado con `preventDefault`.
    if (proceed) {
      const role = el.getAttribute("role");
      if (combo.key === "Enter") {
        if (CLICK_ON_ENTER.has(el.tagName) || role === "button" || role === "link") {
          (el as HTMLElement).click();
        } else if (el.tagName === "INPUT") {
          const form = (el as HTMLInputElement).form;
          if (form) {
            const submitter = form.querySelector<HTMLElement>("button:not([type]),button[type=submit],input[type=submit]");
            if (submitter) submitter.click();
            else if (typeof form.requestSubmit === "function") form.requestSubmit();
            else if (form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))) form.submit();
          }
        }
      } else if (combo.key === " " && (el.tagName === "BUTTON" || role === "button"
        || (el as HTMLInputElement).type === "checkbox" || (el as HTMLInputElement).type === "radio")) {
        (el as HTMLElement).click();
      } else if (combo.key === "Tab") {
        const list = focusables();
        const index = list.indexOf(el as HTMLElement);
        const next = list[(index + (combo.shiftKey ? -1 : 1) + list.length) % list.length];
        next?.focus();
      }
    }
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    const waited = await settle(1000);
    const focused = document.activeElement;
    return {
      pressed: key,
      on: describeElement(el),
      focused: focused && focused !== document.body ? describeElement(focused) : null,
      ...waitedField(waited),
    };
  }

  async function select(el: Element, value: string): Promise<unknown> {
    await cursor.toElement(el, `select "${clipLabel(value)}"`);
    if (el.tagName !== "SELECT") {
      throw new Error(`${describeElement(el)} não é um <select>. Se for um menu próprio, abra-o com click e escolha a opção com click.`);
    }
    const selectEl = el as HTMLSelectElement;
    const options = Array.from(selectEl.options);
    const wanted = value.trim().toLowerCase();
    const option = options.find((o) => o.value === value) ?? options.find((o) => normalizeName(o.text).toLowerCase() === wanted);
    if (!option) {
      const known = options.slice(0, 25).map((o) => `"${normalizeName(o.text)}"`).join(", ");
      throw new Error(`Nenhuma opção é "${value}". Há: ${known}`);
    }
    selectEl.value = option.value;
    selectEl.dispatchEvent(new Event("input", { bubbles: true }));
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
    const waited = await settle(800, 150, PENDING_MS.select);
    return { selected: normalizeName(option.text), value: option.value, ...waitedField(waited) };
  }

  async function hover(el: Element): Promise<unknown> {
    await cursor.toElement(el, "hover");
    const { x, y, target } = aim(el);
    // En una pantalla táctil no hay hover: el dedo está o no está. Simularlo igual daría
    // un menú abierto que en el teléfono no se abre nunca, que es justo el bug que se
    // estaba buscando.
    if (isTouch()) {
      return {
        hovered: describeElement(el),
        note: "No se hizo nada: estás emulando una pantalla táctil y ahí no hay hover. Si esto solo se abre pasando "
          + "por encima, en un teléfono no se abre. Probá tocarlo con browser_click, o apagá el táctil con browser_resize.",
      };
    }
    for (const t of ["pointerover", "pointerenter", "pointermove"]) mouse(target, t, x, y);
    mouse(target, "mouseover", x, y);
    mouse(target, "mouseenter", x, y);
    await settle(800, 150, PENDING_MS.hover);
    return { hovered: describeElement(el), note: "Dispara los eventos del mouse; el :hover de CSS no se puede simular desde la página." };
  }

  /** Arrastrar y soltar: los eventos de puntero para lo que escucha el mouse, y los de
   *  arrastre de HTML para lo que usa `draggable`. Sin los dos, la mitad de las listas
   *  ordenables no se enteran. */
  async function drag(fromTarget: string, toTarget: string): Promise<unknown> {
    const from = resolve(fromTarget, true);
    const to = resolve(toTarget, true);
    await cursor.toElement(from, "drag");
    const start = aim(from);
    const end = aim(to);

    mouse(start.target, "pointerover", start.x, start.y);
    mouse(start.target, "pointerdown", start.x, start.y);
    const transfer = typeof DataTransfer === "function" ? new DataTransfer() : null;
    const dragEvent = (el: Element, type: string, x: number, y: number) => {
      const event = transfer && typeof DragEvent === "function"
        ? new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: transfer })
        : new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
      el.dispatchEvent(event);
    };
    dragEvent(start.target, "dragstart", start.x, start.y);

    // Unos pasos intermedios: una lista ordenable decide dónde cae mirando por dónde pasó.
    for (let step = 1; step <= 4; step++) {
      const x = start.x + ((end.x - start.x) * step) / 4;
      const y = start.y + ((end.y - start.y) * step) / 4;
      await cursor.toElement(step === 4 ? to : from, "drag");
      mouse(end.target, "pointermove", x, y);
      dragEvent(end.target, "dragover", x, y);
    }
    dragEvent(end.target, "drop", end.x, end.y);
    mouse(end.target, "pointerup", end.x, end.y);
    dragEvent(start.target, "dragend", end.x, end.y);
    cursor.click();
    await settle(1500, 150, PENDING_MS.drag);
    return { dragged: describeElement(from), onto: describeElement(to) };
  }

  /** Pone un archivo en un `<input type=file>` como si lo hubiera elegido una persona. */
  async function upload(target: string, name: string, mime: string, data: string): Promise<unknown> {
    const el = resolve(target, true);
    const input = el as HTMLInputElement;
    if (input.tagName !== "INPUT" || input.type !== "file") {
      throw new Error(`${describeElement(el)} não é um <input type="file">.`);
    }
    if (typeof DataTransfer !== "function") throw new Error("Este motor não permite colocar arquivos de fora.");
    await cursor.toElement(el, `upload ${clipLabel(name)}`);
    const blob = await (await fetch(`data:${mime || "application/octet-stream"};base64,${data}`)).blob();
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], name, { type: mime || blob.type }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(800, 150, PENDING_MS.select);
    return { uploaded: name, bytes: blob.size, input: describeElement(el) };
  }

  async function scroll(command: Extract<PageCommand, { op: "scroll" }>): Promise<unknown> {
    const root = document.documentElement;
    if (command.target) {
      const el = resolve(command.target);
      await cursor.toElement(el, "scroll");
      if (command.dy) el.scrollBy(0, command.dy);
      else el.scrollIntoView({ block: "center" });
    } else if (command.to === "top") {
      window.scrollTo(0, 0);
    } else if (command.to === "bottom") {
      window.scrollTo(0, root.scrollHeight);
    } else {
      window.scrollBy(0, command.dy ?? Math.round(window.innerHeight * 0.8));
    }
    await settle(600, 100, PENDING_MS.scroll);
    return { scrollY: Math.round(window.scrollY), documentHeight: root.scrollHeight, viewportHeight: window.innerHeight };
  }

  function wait(command: Extract<PageCommand, { op: "wait" }>): Promise<unknown> {
    const { text, selector, gone, idle } = command;
    if (!text && !selector && !idle) return Promise.reject(new Error("Pasá text, selector o idle."));
    const timeout = Math.min(Math.max(command.timeoutMs ?? 5000, 0), 15_000);
    const started = Date.now();
    // "En reposo" no es "cero pedidos ahora": una página que encadena llamadas tiene
    // huecos de milisegundos entre una y la siguiente. Hace falta que se sostenga.
    let quietSince: number | null = null;
    const isIdle = (): boolean => {
      if (activity.size() > 0) {
        quietSince = null;
        return false;
      }
      quietSince = quietSince ?? Date.now();
      return Date.now() - quietSince >= 400;
    };
    const present = (): boolean => {
      if (idle && !text && !selector) return isIdle();
      if (selector) {
        try {
          return Array.from(document.querySelectorAll(selector)).some(isVisible);
        } catch {
          throw new Error(`"${selector}" não é um seletor CSS válido.`);
        }
      }
      return textOf(document.body ?? document.documentElement).toLowerCase().includes(text!.toLowerCase());
    };
    return new Promise((done, fail) => {
      const tick = () => {
        let ok: boolean;
        try {
          ok = present() !== !!gone;
        } catch (e) {
          fail(e);
          return;
        }
        if (ok && idle && (text || selector) && !isIdle()) ok = false;
        if (ok) done({ waitedMs: Date.now() - started, inFlight: activity.size() });
        else if (Date.now() - started >= timeout) {
          const what = selector ? `el selector "${selector}"` : text ? `el texto "${text}"` : `la red en reposo (${activity.size()} pedido(s) sin terminar)`;
          fail(new Error(`${gone ? "Continua presente" : "Não apareceu"} ${what} depois de ${timeout} ms.`));
        } else setTimer(tick, 100);
      };
      tick();
    });
  }

  async function evaluate(code: string): Promise<unknown> {
    let fn: () => Promise<unknown>;
    try {
      // Primero como expresión (`document.title`), después como cuerpo con `return`.
      fn = new Function(`return (async () => (${code}\n))()`) as () => Promise<unknown>;
    } catch {
      fn = new Function(`return (async () => {${code}\n})()`) as () => Promise<unknown>;
    }
    return toTransferable(await fn.call(window));
  }

  function layout(): unknown {
    const root = document.documentElement;
    const vw = root.clientWidth;
    const vh = window.innerHeight;
    const clips = new Map<Element, boolean>();
    const clippedByAncestor = (el: Element): boolean => {
      for (let a = el.parentElement; a && a !== document.body && a !== root; a = a.parentElement) {
        let clipped = clips.get(a);
        if (clipped === undefined) {
          const overflow = getComputedStyle(a).overflowX;
          clipped = overflow !== "visible";
          clips.set(a, clipped);
        }
        if (clipped) return true;
      }
      return false;
    };

    const overflowing: Element[] = [];
    const small: string[] = [];
    let smallCount = 0;
    let tinyTextCount = 0;
    const tinyText: string[] = [];
    const elements = document.body ? Array.from(document.body.querySelectorAll("*")).slice(0, 8000) : [];
    for (const el of elements) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if ((rect.right > vw + 1 || rect.left < -1) && !overflowing.some((o) => o.contains(el)) && !clippedByAncestor(el)) {
        if (getComputedStyle(el).position !== "fixed") overflowing.push(el);
      }
      const role = roleOf(el);
      // WCAG 2.2 pide 24×24 como mínimo para lo que se toca; un link en medio de un
      // párrafo está exceptuado, así que solo se miran los que no están en línea con texto.
      if (role && INTERACTIVE_ROLES.has(role) && (rect.width < 24 || rect.height < 24)
        && getComputedStyle(el).display !== "inline" && isVisible(el)) {
        smallCount += 1;
        if (small.length < 5) small.push(`${describeElement(el)} ${Math.round(rect.width)}×${Math.round(rect.height)}`);
      }
      const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim());
      if (ownText && Number.parseFloat(getComputedStyle(el).fontSize) < 12 && isVisible(el)) {
        tinyTextCount += 1;
        if (tinyText.length < 3) tinyText.push(`${describeElement(el)} ${getComputedStyle(el).fontSize}`);
      }
    }

    return {
      viewport: { width: vw, height: vh, devicePixelRatio: window.devicePixelRatio },
      document: { width: root.scrollWidth, height: root.scrollHeight },
      horizontalScroll: root.scrollWidth > vw,
      overflowing: overflowing.slice(0, 10).map((el) => {
        const r = el.getBoundingClientRect();
        return { element: describeElement(el), selector: selectorOf(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
      }),
      smallTapTargets: { count: smallCount, examples: small },
      smallText: { count: tinyTextCount, examples: tinyText },
      hasViewportMeta: !!document.querySelector("meta[name=viewport]"),
    };
  }

  function storageOf(area: StorageArea): Storage {
    return area === "local" ? window.localStorage : window.sessionStorage;
  }

  async function storage(command: Extract<PageCommand, { op: "storage" }>): Promise<unknown> {
    if (command.action === "set") {
      storageOf(command.area).setItem(command.key, command.value);
      return { ok: true };
    }
    if (command.action === "remove") {
      storageOf(command.area).removeItem(command.key);
      return { ok: true };
    }
    if (command.action === "clear") {
      storageOf(command.area).clear();
      return { ok: true };
    }
    const read = (area: StorageArea) => {
      try {
        const s = storageOf(area);
        return Array.from({ length: s.length }, (_, i) => {
          const key = s.key(i) ?? "";
          const value = s.getItem(key) ?? "";
          return { key, value: clip(value, 4000), size: key.length + value.length };
        });
      } catch (e) {
        return { error: formatValue(e) };
      }
    };
    const attempt = async <T,>(fn: () => Promise<T> | T): Promise<T | null> => {
      try {
        return await fn();
      } catch {
        return null;
      }
    };
    return {
      local: read("local"),
      session: read("session"),
      indexedDB: await attempt(async () => {
        const idb = window.indexedDB as IDBFactory & { databases?: () => Promise<IDBDatabaseInfo[]> };
        return idb?.databases ? (await idb.databases()).map((d) => ({ name: d.name ?? "", version: d.version ?? null })) : null;
      }),
      cacheStorage: await attempt(async () => (typeof caches !== "undefined" ? await caches.keys() : null)),
      serviceWorkers: await attempt(async () => (navigator.serviceWorker
        ? (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope)
        : null)),
    };
  }

  function documentCookies(): { name: string; value: string }[] {
    return document.cookie.split(";").map((pair) => pair.trim()).filter(Boolean).map((pair) => {
      const eq = pair.indexOf("=");
      return eq < 0 ? { name: "", value: pair } : { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
    });
  }

  async function cookies(command: Extract<PageCommand, { op: "cookies" }>): Promise<unknown> {
    if (command.action === "list") {
      // Lo pide el panel o un agente, pocas veces: se lee el frasco tal como está ahora,
      // aunque lo haya cambiado algo que la página no vio (olvidar el sitio desde el panel).
      cookieJar?.invalidate();
      return { cookies: documentCookies() };
    }
    if (command.action === "set") {
      if (/[;\r\n]/.test(command.value) || /[=;\s]/.test(command.name)) throw new Error("O nome ou o valor têm caracteres que um cookie não aceita.");
      const maxAge = command.maxAge != null ? `; max-age=${Math.round(command.maxAge)}` : "";
      document.cookie = `${command.name}=${command.value}; path=${command.path ?? "/"}${maxAge}; samesite=lax`;
      return { set: documentCookies().some((c) => c.name === command.name) };
    }
    // La borra el proxy, que es donde se guardan, en todos sus paths y aunque sea HttpOnly
    // (desde acá no se podría).
    let viaProxy = false;
    if (nativeFetch) {
      try {
        const response = await nativeFetch(`/__ags__/cookies/clear?name=${encodeURIComponent(command.name)}`, {
          credentials: "same-origin", cache: "no-store", headers: { [OWN_HEADER]: "1" },
        });
        cookieJar?.invalidate();
        viaProxy = response.ok;
      } catch {
        /* sin proxy delante (una página abierta por fuera de la app) */
      }
    }
    return { deleted: !documentCookies().some((c) => c.name === command.name), viaProxy };
  }

  function performanceReport(): unknown {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const round = (n: number | undefined) => (n && n > 0 ? Math.round(n) : null);
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const byType: Record<string, number> = {};
    let transfer = 0;
    for (const r of resources) {
      byType[r.initiatorType || "other"] = (byType[r.initiatorType || "other"] ?? 0) + 1;
      transfer += r.transferSize || 0;
    }
    const memory = (performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
    }).memory;
    const fcp = round(performance.getEntriesByName("first-contentful-paint")[0]?.startTime);
    const load = round(nav?.loadEventEnd);
    return {
      navigation: nav ? {
        type: nav.type,
        ttfbMs: round(nav.responseStart),
        domContentLoadedMs: round(nav.domContentLoadedEventEnd),
        loadMs: round(nav.loadEventEnd),
        transferBytes: nav.transferSize || null,
      } : null,
      firstContentfulPaintMs: fcp,
      // Una tab de navegador que un agente carga sin mostrarla no pinta hasta que alguien la
      // mira: un FCP muy posterior a la carga mide eso, no lo que tarda la página.
      paintDeferred: fcp !== null && load !== null && fcp - load > 3000,
      largestContentfulPaintMs: vitals.lcp,
      cumulativeLayoutShift: vitals.cls === null ? null : Math.round(vitals.cls * 1000) / 1000,
      longTasks: vitals.longTasks,
      // Solo Chromium (WebView2) expone el heap de JS. En WebKit no hay forma de medirlo
      // desde la página; `null` dice eso y no "cero".
      memory: memory ? {
        usedJSHeapBytes: memory.usedJSHeapSize,
        totalJSHeapBytes: memory.totalJSHeapSize,
        limitBytes: memory.jsHeapSizeLimit,
      } : null,
      domNodes: document.getElementsByTagName("*").length,
      resources: { count: resources.length, transferBytes: transfer, byType },
      uptimeMs: Math.round(performance.now()),
    };
  }

  /** Todo lo que se puede saber de un elemento sin adivinar: qué es, dónde está en la
   *  página, qué componente lo dibujó y con qué estilos se pinta.
   *
   *  Es lo que recibe un agente cuando la persona le señala algo en el navegador: sin esto
   *  tendría un selector y nada más, y la mitad de las preguntas ("¿de qué componente es?",
   *  "¿por qué se ve así?") volverían al usuario. */
  function describe(target: string): unknown {
    const el = resolve(target);
    const role = roleOf(el) ?? "generic";
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const root = document.documentElement;

    let ref = [...refs.entries(), ...marked.entries()].find(([, node]) => node === el)?.[0];
    if (!ref) {
      ref = `u${markedSeq++}`;
      marked.set(ref, el);
      markedPrints.set(ref, fingerprintOf(el));
    }

    const attributes: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("data-ade-ags")) continue;
      // Las clases y el estilo en línea ya viajan aparte; el resto (aria, data, name,
      // href, type…) es justo lo que identifica al elemento en el código.
      if (attr.name === "class" || attr.name === "style") continue;
      attributes[attr.name] = clip(attr.value, 200);
    }

    const ancestors: string[] = [];
    for (let node = el.parentElement; node && ancestors.length < 5 && node !== root; node = node.parentElement) {
      ancestors.push(describeElement(node));
    }

    // El centro del elemento, para saber si algo lo tapa: un botón que no responde suele
    // tener un overlay encima, y eso no se ve en el HTML.
    const hit = rect.width > 0 && rect.height > 0
      ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      : null;
    const covered = hit && hit !== el && !el.contains(hit) && !hit.contains(el) ? describeElement(hit) : null;

    return {
      ref,
      role,
      name: nameOf(el, role),
      tag: el.tagName.toLowerCase(),
      selector: selectorOf(el),
      states: statesOf(el, role),
      value: valueOf(el),
      text: normalizeName(textOf(el), 300),
      components: componentChain(el),
      ancestors,
      attributes,
      classes: Array.from(el.classList).slice(0, 12),
      box: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: isVisible(el),
        covered,
      },
      viewport: { width: root.clientWidth, height: window.innerHeight },
      styles: {
        display: style.display,
        position: style.position,
        color: style.color,
        background: style.backgroundColor,
        font: `${style.fontSize} ${style.fontWeight} ${style.fontFamily.split(",")[0]}`,
        padding: style.padding,
        margin: style.margin,
        border: style.border,
        zIndex: style.zIndex,
        overflow: style.overflow,
      },
      html: clip(el.outerHTML, 1500),
      url: location.href,
    };
  }

  /** Resolve o alvo com a guarda e, feita a ação, anota o elemento como está agora: repetir o mesmo toque no mesmo ref
   *  («+» duas vezes, digitar de novo no campo) não é uma mudança que o agente não tenha visto. */
  async function acting<T>(target: string, action: (el: Element) => Promise<T>): Promise<T> {
    const el = resolve(target, true);
    const result = await action(el);
    const spec = parseTarget(target);
    const withNeighbors = spec.kind === "point" && pointNeighbors > 0 && result !== null && typeof result === "object"
      ? { ...(result as object), unnamedNeighbors: pointNeighbors } as T
      : result;
    if (spec.kind === "ref" && el.isConnected) {
      const fresh = fingerprintOf(el);
      if (prints.has(spec.ref)) prints.set(spec.ref, fresh);
      else if (markedPrints.has(spec.ref)) markedPrints.set(spec.ref, fresh);
    }
    return withNeighbors;
  }

  function execute(command: PageCommand): Promise<unknown> | unknown {
    switch (command.op) {
      case "snapshot": return snapshot(!!command.all, !!command.inView);
      case "touch": {
        const { rules } = setTouch(command.on);
        return {
          touch: command.on,
          mediaQueries: rules,
          note: command.on
            ? (rules > 0
              ? `La página distingue el táctil: ${rules} media query(s) de hover/puntero ahora contestan como un teléfono.`
              : "La página no mira hover ni puntero en su CSS: lo táctil solo cambia los eventos que recibe.")
            : "Vuelve a comportarse como con mouse.",
        };
      }
      case "click": return acting(command.target, click);
      case "hover": return acting(command.target, hover);
      case "type": return acting(command.target, (el) => type(el, command.text, !!command.clear, !!command.submit));
      case "press": return command.target ? acting(command.target, (el) => press(command.key, el)) : press(command.key);
      case "select": return acting(command.target, (el) => select(el, command.value));
      case "scroll": return scroll(command);
      case "wait": return wait(command);
      case "settle": return settleOp(command);
      case "eval": return evaluate(command.code);
      case "layout": return layout();
      case "storage": return storage(command);
      case "cookies": return cookies(command);
      case "performance": return performanceReport();
      case "describe": return describe(command.target);
      case "peek": {
        const el = resolve(command.target);
        return { label: [nameOf(el, roleOf(el) || "clickable"), normalizeName(textOf(el), 80), describeElement(el), el.getAttribute("href") ?? ""].filter(Boolean).join(" | ") };
      }
      case "drag": return drag(command.from, command.to);
      case "upload": return upload(command.target, command.name, command.mime, command.data);
      case "dialogs": {
        if (command.accept !== undefined) dialogPolicy.accept = command.accept;
        if (command.text !== undefined) dialogPolicy.text = command.text;
        return {
          policy: { accept: dialogPolicy.accept, promptText: dialogPolicy.text },
          seen: dialogs.slice(-20),
        };
      }
    }
  }

  async function run(id: string, command: PageCommand): Promise<void> {
    let payload: { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };
    // Mientras dura la orden, los diálogos de la página los contesta el runtime: si no, la
    // acción del agente quedaría esperando a una persona que quizá no está mirando.
    driving = true;
    commandBaseline = activity.liveIds();
    fastCommand = (command as { fast?: boolean }).fast === true;
    cursor.setFast(fastCommand);
    try {
      payload = { id, ok: true, result: await execute(command) };
    } catch (e) {
      payload = { id, ok: false, error: e instanceof Error ? e.message : formatValue(e) };
    }
    if (!post({ type: "page:reply", payload })) {
      post({ type: "page:reply", payload: { id, ok: false, error: "O resultado não pode ser transferido para o app." } });
    }
    driving = false;
    fastCommand = false;
    commandBaseline = undefined;
    cursor.setFast(false);
    // Lo que la acción haya logueado viaja enseguida: la app lo junta con la respuesta.
    flush();
  }

  window.addEventListener("message", (e: MessageEvent<AppMessage>) => {
    if (e.source !== window.parent || e.data?.source !== "ade-ags") return;
    parentOrigin = e.origin;
    const message = e.data;
    // Mientras nadie mira la tab, el puntero no se anima: serían 300 ms por acción
    // dibujando algo que no se ve.
    if (message.type === "view:shown" || message.type === "view:hidden") {
      cursor.setWatched(message.type === "view:shown");
      return;
    }
    if (message.type === "net:on" || message.type === "net:off") {
      recordingNet = message.type === "net:on";
      return;
    }
    if (message.type === "connect" || message.type === "hello") flush();
    else if (message.type === "page:run") void run(message.id, message.command);
  });

  // Enlaces y formularios con URL absoluta. Al servidor de la página se reescriben a la ruta
  // del proxy antes de que el navegador los siga (en captura: un router de SPA que lea el
  // `href` después ve uno del propio origen y lo maneja él). A otro sitio, la app lo abre
  // con su propio proxy, en vez de que el iframe se vaya directo y pierda el runtime.
  // Mientras maneja un agente, una página nueva ("_blank", un nombre de ventana, "_top") se abre en ESTE navegador: el
  // agente tiene un portal, no una ventana más que seguir, y "_top"/"_parent" llevarían la app entera a otro sitio (E4).
  const staysHere = (target: string | null | undefined): boolean => !target || target === "_self";

  document.addEventListener("click", (event) => {
    const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!link) return;
    if (driving && !staysHere(link.getAttribute("target")) && !link.hasAttribute("download")) link.setAttribute("target", "_self");
    const routed = route(link.href);
    if (routed && !routed.forwarded) link.href = routed.url;
  }, true);
  window.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
    const routed = route(link.href);
    if (!routed?.forwarded) return;
    event.preventDefault();
    post({ type: "nav:open", payload: { url: routed.original } });
  });
  document.addEventListener("submit", (event) => {
    const form = event.target as HTMLFormElement | null;
    if (!(form instanceof HTMLFormElement)) return;
    if (driving) {
      if (!staysHere(form.getAttribute("target"))) form.setAttribute("target", "_self");
      const submitter = (event as SubmitEvent).submitter;
      if (submitter && !staysHere(submitter.getAttribute("formtarget"))) submitter.setAttribute("formtarget", "_self");
    }
    const routed = route(form.action);
    if (routed && !routed.forwarded) form.action = routed.url;
  }, true);

  // `window.open(url)` desde la acción de un agente: la misma página, no una ventana nueva. Un sitio de otro origen lo abre la app
  // con su propio proxy (igual que un link); lo que no es http(s) (`mailto:`, `javascript:`) o no tiene URL, queda como estaba.
  const nativeOpen = window.open.bind(window);
  function openHere(raw: string): void {
    const routed = route(raw);
    if (routed?.forwarded) post({ type: "nav:open", payload: { url: routed.original } });
    else location.assign(routed ? routed.url : new URL(raw, location.href).href);
  }
  window.open = function (url?: string | URL, target?: string, features?: string): Window | null {
    const raw = url === undefined || url === null ? "" : String(url);
    let here = false;
    try { here = driving && /^https?:$/.test(new URL(raw, location.href).protocol) && raw.trim() !== "" && !raw.startsWith("about:"); } catch { /* una URL rara: queda como estaba */ }
    if (!here) return nativeOpen(url as string, target, features);
    openHere(raw);
    // Quien abre una ventana suele guardarla (`popup.focus()`, `popup.closed`, `popup.location = …`): un doble mínimo, para no romperlo.
    const stub = {
      closed: false, name: target ?? "", opener: window,
      focus: () => undefined, blur: () => undefined, close: () => undefined, postMessage: () => undefined,
      location: {
        get href() { return location.href; },
        set href(next: string) { openHere(String(next)); },
        assign: (next: string) => openHere(String(next)),
        replace: (next: string) => openHere(String(next)),
      },
    };
    return stub as unknown as Window;
  };

  post({ type: "page:ready", payload: { doc, url: location.href } }, true);
})();
