/**
 * Recurso de UI do MCP Apps (ext-apps, spec 2026-01-26).
 *
 * O `resources/read` devolve o HTML em `contents[]`:
 * `uri` com esquema `ui://`, `mimeType` `text/html;profile=mcp-app`,
 * corpo em `text` ou `blob` (base64). O mesmo objeto aparece no resultado
 * da ferramenta como recurso embutido, em `content[].resource`.
 *
 * O backend guarda o recurso no campo `appResource` do item (fora do `output`, que é cortado em 4.000
 * caracteres). `parseMcpAppResource` lê o `output` só como reserva, para itens antigos.
 *
 * `_meta.ui.resourceUri` só aponta o URI. Sem o HTML no resultado o host da spec faz `resources/read` no
 * servidor, e a ADE ainda não tem um cliente MCP do lado do host para isso: é o próximo passo, e hoje a
 * ferramenta nessa situação aparece como uma ferramenta comum.
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

/** O recurso do item: o campo próprio do backend (revalidado, vem de transcript) ou, se faltar, o texto do `output`. */
export function appResourceOf(item: { appResource?: unknown; output?: string }): McpAppResource | null {
  const own = item.appResource;
  if (isRecord(own)) {
    const found = asResource({ uri: own.uri, mimeType: own.mimeType, text: own.html });
    if (found) return found;
  }
  return item.output ? parseMcpAppResource(item.output) : null;
}

/**
 * O servidor dono do app, para o diálogo de aprovação. O nome da ferramenta MCP do Claude é
 * `mcp__servidor__ferramenta`; o do Codex, `servidor.ferramenta`. Sem isso, o host do `ui://servidor/…`.
 */
export function mcpAppServerOf(toolName: string | undefined, uri: string): string {
  const claude = /^mcp__(.+?)__.+$/.exec(toolName ?? "");
  if (claude?.[1]) return claude[1];
  const codex = /^([^.\s]+)\.[^\s]+$/.exec(toolName ?? "");
  if (codex?.[1]) return codex[1];
  return /^ui:\/\/([^/]+)/.exec(uri)?.[1] ?? "?";
}

export { MCP_APP_MIME };
