import type { McpAppHandlers, McpAppRpcOutcome } from "./mcpAppBridge";

/**
 * O que o app pode pedir ao host, e a aprovação de cada pedido. Aqui só há política; quem mostra o diálogo,
 * põe o texto no composer e muda a tela cheia entra por `McpAppHostDeps`.
 *
 * - `ui/message`: SEMPRE pede aprovação. Aprovada, o texto vai para o composer, marcado como vindo do app, para
 *   a pessoa revisar. Nunca é enviada sozinha.
 * - `tools/call`: só existe com `toolHost`. Pede aprovação, salvo para a ferramenta que o servidor marcou como
 *   somente leitura. Sem `toolHost` o pedido continua recusado (-32601) pela ponte.
 * - `ui/request-display-mode`: tela cheia só depois de um clique no app (regra de {@link ./mcpAppFullscreen}).
 */

/** O que o diálogo da ADE mostra para a pessoa decidir. Fica fora do iframe. */
export type McpAppApprovalRequest =
  | { kind: "tool"; server: string; tool: string; args: string }
  | { kind: "message"; server: string; text: string };

/** `busy`: já há outra aprovação aberta; o app tenta de novo depois. */
export type McpAppApprovalAnswer = "approved" | "denied" | "busy";

/**
 * A execução de uma ferramenta do PRÓPRIO servidor do app, pelo caminho MCP da conversa. A ADE ainda não tem
 * um cliente MCP do lado do host que faça isso com segurança, então em produção ninguém passa um `toolHost`.
 */
export interface McpAppToolHost {
  /** A anotação `readOnlyHint` que o servidor deu à ferramenta. Desconhecida conta como não somente leitura. */
  isReadOnly(tool: string): boolean;
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface McpAppHostDeps {
  /** O servidor dono do app (o nome que o diálogo mostra). */
  server: string;
  requestApproval(request: McpAppApprovalRequest): Promise<McpAppApprovalAnswer>;
  toolHost?: McpAppToolHost;
  /** Põe o texto no composer da conversa, sem enviar. */
  postToComposer(text: string): void;
  /** Tenta abrir em tela cheia; devolve se abriu. */
  enterFullscreen(): boolean;
  exitFullscreen(): void;
}

export const APP_MESSAGE_MAX = 4_000;
export const APP_ARGS_PREVIEW_MAX = 4_000;
const TOOL_NAME_MAX = 200;

const DENIED = -32000;
const INVALID_PARAMS = -32602;
const BUSY = -32001;

function fail(code: number, message: string): McpAppRpcOutcome {
  return { error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** O marcador que o texto leva ao composer, para a pessoa (e o agente) saberem que veio de um app. */
export function appMessageText(server: string, text: string): string {
  return `[App MCP «${server}»] ${text}`;
}

/** O texto da mensagem do app: blocos `text` de `content` (um bloco ou lista). Imagens e recursos ficam de fora. */
export function appMessageOf(params: unknown): string | null {
  if (!isRecord(params)) return null;
  const blocks = Array.isArray(params.content) ? params.content : [params.content];
  const parts = blocks.flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []));
  const text = parts.join("\n").trim();
  return text.length > 0 && text.length <= APP_MESSAGE_MAX ? text : null;
}

/** Os argumentos como o diálogo os mostra: JSON legível, cortado. */
export function previewArgs(args: Record<string, unknown>): string {
  let text: string;
  try { text = JSON.stringify(args, null, 2) ?? "{}"; } catch { text = "{…}"; }
  return text.length > APP_ARGS_PREVIEW_MAX ? `${text.slice(0, APP_ARGS_PREVIEW_MAX)}…` : text;
}

export function createMcpAppHandlers(deps: McpAppHostDeps): McpAppHandlers {
  const handlers: McpAppHandlers = {
    "ui/message": async (params) => {
      const text = appMessageOf(params);
      if (text === null) return fail(INVALID_PARAMS, "mensagem inválida");
      const answer = await deps.requestApproval({ kind: "message", server: deps.server, text });
      if (answer === "busy") return fail(BUSY, "há outro pedido aguardando aprovação");
      if (answer !== "approved") return fail(DENIED, "negado pela pessoa");
      deps.postToComposer(appMessageText(deps.server, text));
      return { result: {} };
    },
    "ui/request-display-mode": (params) => {
      const mode = isRecord(params) ? params.mode : undefined;
      if (mode === "inline") {
        deps.exitFullscreen();
        return { result: { mode: "inline" } };
      }
      // Sem clique válido (ou em outro modo), o app recebe o modo em que ficou: inline.
      if (mode === "fullscreen" && deps.enterFullscreen()) return { result: { mode: "fullscreen" } };
      return { result: { mode: "inline" } };
    },
  };

  const toolHost = deps.toolHost;
  if (toolHost) {
    handlers["tools/call"] = async (params) => {
      if (!isRecord(params) || typeof params.name !== "string" || !params.name.trim() || params.name.length > TOOL_NAME_MAX) {
        return fail(INVALID_PARAMS, "ferramenta inválida");
      }
      if (params.arguments !== undefined && !isRecord(params.arguments)) return fail(INVALID_PARAMS, "argumentos inválidos");
      const tool = params.name;
      const args = params.arguments ?? {};
      if (!toolHost.isReadOnly(tool)) {
        const answer = await deps.requestApproval({ kind: "tool", server: deps.server, tool, args: previewArgs(args) });
        if (answer === "busy") return fail(BUSY, "há outro pedido aguardando aprovação");
        if (answer !== "approved") return fail(DENIED, "negado pela pessoa");
      }
      try {
        return { result: await toolHost.call(tool, args) };
      } catch {
        return fail(-32603, "a ferramenta falhou");
      }
    };
  }
  return handlers;
}
