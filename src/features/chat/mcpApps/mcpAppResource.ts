/**
 * Recurso de UI do MCP Apps (ext-apps, spec 2026-01-26).
 *
 * O `resources/read` devolve o HTML em `contents[]`:
 * `uri` com esquema `ui://`, `mimeType` `text/html;profile=mcp-app`,
 * corpo em `text` ou `blob` (base64). O mesmo objeto aparece no resultado
 * da ferramenta como recurso embutido, em `content[].resource`.
 *
 * `_meta.ui.resourceUri` só aponta o URI. Sem o HTML aqui, esta fatia não busca
 * o recurso no servidor.
 */

const MCP_APP_MIME = "text/html;profile=mcp-app";
const MAX_HTML = 512 * 1024;
const MAX_NODES = 200;
const MAX_DEPTH = 8;

export interface McpAppResource {
  uri: string;
  mimeType: string;
  html: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAppMime(mime: string): boolean {
  const parts = mime.trim().toLowerCase().split(";").map((part) => part.trim());
  return parts[0] === "text/html" && parts.includes("profile=mcp-app");
}

function isUiUri(uri: string): boolean {
  return uri.startsWith("ui://") && uri.length > "ui://".length && !/[\s<>]/.test(uri);
}

function decodeBlob(blob: string): string | null {
  try {
    const bin = atob(blob);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return html.trim() ? html : null;
  } catch {
    return null;
  }
}

function htmlOf(record: Record<string, unknown>): string | null {
  if (typeof record.text === "string" && record.text.trim()) {
    return record.text.length <= MAX_HTML ? record.text : null;
  }
  if (typeof record.blob === "string" && record.blob.trim()) {
    const html = decodeBlob(record.blob);
    return html && html.length <= MAX_HTML ? html : null;
  }
  return null;
}

function asResource(value: unknown): McpAppResource | null {
  if (!isRecord(value)) return null;
  if (typeof value.uri !== "string" || !isUiUri(value.uri)) return null;
  if (typeof value.mimeType !== "string" || !isAppMime(value.mimeType)) return null;
  const html = htmlOf(value);
  if (!html) return null;
  return { uri: value.uri, mimeType: value.mimeType, html };
}

function walk(value: unknown, depth: number, budget: { n: number }): McpAppResource | null {
  if (budget.n++ > MAX_NODES || depth > MAX_DEPTH) return null;
  const direct = asResource(value);
  if (direct) return direct;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > MAX_HTML || !/^[{[]/.test(trimmed)) return null;
    try {
      return walk(JSON.parse(trimmed), depth + 1, budget);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = walk(item, depth + 1, budget);
      if (found) return found;
    }
    return null;
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) {
      const found = walk(child, depth + 1, budget);
      if (found) return found;
    }
  }
  return null;
}

/** O texto do resultado da ferramenta, quando ele traz o recurso de app. */
export function parseMcpAppResource(output: string): McpAppResource | null {
  const trimmed = output.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return null;
  try {
    return walk(JSON.parse(trimmed) as unknown, 0, { n: 0 });
  } catch {
    return null;
  }
}

export { MCP_APP_MIME };
