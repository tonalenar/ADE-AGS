/**
 * Ponte do protocolo `ags-design` (ver `src-tauri/src/design_frame/`).
 *
 * No WKWebView (macOS) e WebKitGTK, documentos em `iframe srcdoc` herdam a CSP restritiva
 * da página principal (`script-src 'self'` + nonces/hashes do Tauri), bloqueando scripts
 * inline e handlers das pranchetas, renders e apps MCP. Registrar o documento em memória no
 * backend e carregá-lo por `ags-design://localhost/<id>` (ou `http://ags-design.localhost/<id>`
 * no Windows) dá origem própria e aplica a CSP restritiva via header HTTP, mantendo
 * `sandbox="allow-scripts"` sem `allow-same-origin`.
 */
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

export const DESIGN_FRAME_SCHEME = "ags-design";

export type DesignFramePolicy = "design" | "isolated";

export interface DesignFrameState {
  readonly src?: string;
  readonly srcDoc?: string;
  readonly ready: boolean;
  readonly error: boolean;
}

const LOCAL_CACHE_TTL_MS = 10 * 60 * 1000;
const LOCAL_CACHE_MAX = 128;

interface CacheEntry {
  url: string;
  at: number;
}

const urlCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string>>();

function cacheKey(policy: DesignFramePolicy, html: string): string {
  return `${policy}\0${html}`;
}

function readCache(key: string): string | null {
  const hit = urlCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= LOCAL_CACHE_TTL_MS) {
    urlCache.delete(key);
    return null;
  }
  return hit.url;
}

function writeCache(key: string, url: string): void {
  urlCache.delete(key);
  urlCache.set(key, { url, at: Date.now() });
  while (urlCache.size > LOCAL_CACHE_MAX) {
    const oldest = urlCache.keys().next().value;
    if (oldest === undefined) break;
    urlCache.delete(oldest);
  }
}

/** Limpa o cache local de URLs registradas (para isolamento entre testes). */
export function clearDesignFrameCache(): void {
  urlCache.clear();
  inflight.clear();
}

/** Monta a URL do protocolo `ags-design` para o SO atual (macOS/Linux vs Windows). */
export function designFrameUrl(id: string): string {
  try {
    if (isTauri()) return convertFileSrc(id, DESIGN_FRAME_SCHEME);
  } catch {
    // Fallback para ambientes de teste onde `convertFileSrc` não está injetado.
  }
  return `${DESIGN_FRAME_SCHEME}://localhost/${encodeURIComponent(id)}`;
}

/** Registra o documento HTML no backend e devolve a URL `ags-design` correspondente. */
export async function registerDesignFrame(
  html: string,
  policy: DesignFramePolicy = "design",
): Promise<string> {
  const key = cacheKey(policy, html);
  const cached = readCache(key);
  if (cached) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const task = invoke<string>("design_frame_register", { html, policy })
    .then((id) => {
      const url = designFrameUrl(id);
      writeCache(key, url);
      return url;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, task);
  return task;
}

/**
 * Resolve a fonte do `<iframe>` isolado:
 * - No app Tauri: registra o HTML no backend e devolve `src` com o scheme `ags-design` (sem `srcDoc`).
 * - Fora do Tauri (navegador puro / testes sem runtime Tauri): usa `srcDoc`.
 */
export function useDesignFrame(
  html: string | null,
  policy: DesignFramePolicy = "design",
): DesignFrameState {
  const tauri = isTauri();
  const key = html ? cacheKey(policy, html) : null;
  const cached = tauri && key ? readCache(key) : null;
  const [resolved, setResolved] = useState<{ key: string; url: string | null; error: boolean } | null>(null);

  useEffect(() => {
    if (!tauri || !html || !key) return;
    const existing = readCache(key);
    if (existing) {
      setResolved((prev) => (prev?.key === key && prev.url === existing ? prev : { key, url: existing, error: false }));
      return;
    }
    let alive = true;
    registerDesignFrame(html, policy)
      .then((url) => {
        if (alive) setResolved({ key, url, error: false });
      })
      .catch(() => {
        if (alive) setResolved({ key, url: null, error: true });
      });
    return () => {
      alive = false;
    };
  }, [tauri, html, policy, key]);

  if (!html || !key) return { ready: false, error: false };
  if (!tauri) return { srcDoc: html, ready: true, error: false };
  if (cached) return { src: cached, ready: true, error: false };
  if (resolved?.key === key) {
    if (resolved.url) return { src: resolved.url, ready: true, error: false };
    return { ready: false, error: resolved.error };
  }
  return { ready: false, error: false };
}
