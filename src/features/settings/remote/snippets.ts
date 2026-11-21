/**
 * Lógica pura dos trechos de configuração do MCP remoto (Claude Code, Codex e T3 Code).
 * Sem DOM nem Tauri para ser testável diretamente em node/vitest.
 */

export interface T3CodeSnippet {
  url: string;
  headerName: string;
  headerValue: string;
  text: string;
}

export interface ClientSnippets {
  url: string;
  header: string;
  claudeCode: string;
  codex: string;
  t3Code: T3CodeSnippet;
}

export function remoteServerHost(tailscaleIp: string | null | undefined): string {
  const trimmed = tailscaleIp?.trim();
  return trimmed ? trimmed : "127.0.0.1";
}

export function remoteServerUrl(host: string, port: number): string {
  return `http://${host}:${port}/mcp`;
}

export function buildClientSnippets(host: string, port: number, token: string): ClientSnippets {
  const url = remoteServerUrl(host, port);
  const headerValue = `Bearer ${token}`;
  const header = `Authorization: ${headerValue}`;

  const claudeCode = `claude mcp add --transport http ade ${url} --header "${header}"`;

  const codex = [
    `export ADE_MCP_TOKEN="${token}"`,
    "",
    "[mcp_servers.ade]",
    `url = "${url}"`,
    'bearer_token_env_var = "ADE_MCP_TOKEN"',
  ].join("\n");

  const t3Code: T3CodeSnippet = {
    url,
    headerName: "Authorization",
    headerValue,
    text: `URL: ${url}\nAuthorization: ${headerValue}`,
  };

  return { url, header, claudeCode, codex, t3Code };
}
