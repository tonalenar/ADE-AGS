/** Resposta desta fatia a qualquer pedido JSON-RPC do app. As próximas liberam com aprovação. */
export const MCP_APP_UNSUPPORTED = "não suportado ainda";

const JSONRPC_METHOD_NOT_FOUND = -32601;

export interface McpAppLogEntry {
  method: string;
  note: typeof MCP_APP_UNSUPPORTED;
}

export interface McpAppRefusal {
  jsonrpc: "2.0";
  id: string | number;
  error: { code: typeof JSONRPC_METHOD_NOT_FOUND; message: typeof MCP_APP_UNSUPPORTED };
}

export type AppDecision =
  | { kind: "ignore" }
  | { kind: "stop" }
  | { kind: "drop"; method: string; note: typeof MCP_APP_UNSUPPORTED }
  | { kind: "refuse"; method: string; note: typeof MCP_APP_UNSUPPORTED; response: McpAppRefusal };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * O que o host faz com uma mensagem do iframe. Pedido com `id` (ferramenta,
 * mensagem, tela cheia, initialize) é recusado. Notificação sem `id` só é registrada.
 * `navigate-away` para o app.
 */
export function decideAppMessage(data: unknown): AppDecision {
  if (!isRecord(data)) return { kind: "ignore" };
  if (data.source === "ags-mcp-app" && data.kind === "navigate-away") return { kind: "stop" };
  if (typeof data.method !== "string" || data.method.length === 0 || data.method.length > 200) return { kind: "ignore" };
  if (data.jsonrpc !== undefined && data.jsonrpc !== "2.0") return { kind: "ignore" };
  const note = MCP_APP_UNSUPPORTED;
  if (typeof data.id === "string" || typeof data.id === "number") {
    return {
      kind: "refuse",
      method: data.method,
      note,
      response: { jsonrpc: "2.0", id: data.id, error: { code: JSONRPC_METHOD_NOT_FOUND, message: note } },
    };
  }
  return { kind: "drop", method: data.method, note };
}

export interface McpAppHostTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface McpAppSessionOptions {
  host?: McpAppHostTarget;
  getFrameWindow: () => Window | null;
  onStop: () => void;
  onLog?: (entry: McpAppLogEntry) => void;
}

/**
 * Escuta só o iframe deste app. `close` tira o listener.
 * Esta fatia não arma timer no host; o documento do iframe some com ele, e os timers de lá também.
 */
export function createMcpAppSession(options: McpAppSessionOptions): { close: () => void; logs: McpAppLogEntry[] } {
  const host = options.host ?? window;
  const logs: McpAppLogEntry[] = [];
  let closed = false;

  const onMessage: EventListener = (event) => {
    if (closed) return;
    const message = event as MessageEvent;
    const frame = options.getFrameWindow();
    if (!frame || message.source !== frame) return;
    try {
      const decision = decideAppMessage(message.data);
      if (decision.kind === "ignore") return;
      if (decision.kind === "stop") {
        try { options.onStop(); } catch { /* o app não derruba a timeline */ }
        return;
      }
      const entry = { method: decision.method, note: decision.note };
      logs.push(entry);
      try { options.onLog?.(entry); } catch { /* registro hostil não sobe */ }
      if (decision.kind === "refuse") {
        try { frame.postMessage(decision.response, "*"); } catch { /* canal já fechado */ }
      }
    } catch { /* payload hostil não sobe */ }
  };

  host.addEventListener("message", onMessage);

  return {
    close() {
      if (closed) return;
      closed = true;
      host.removeEventListener("message", onMessage);
    },
    logs,
  };
}
