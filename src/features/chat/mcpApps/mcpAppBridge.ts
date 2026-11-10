/** Resposta a qualquer pedido do app que o host não tem como atender. */
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
  /** O app avisa que a pessoa clicou nele. Só vale com o quadro em foco (o host confere). */
  | { kind: "gesture" }
  | { kind: "drop"; method: string; note: typeof MCP_APP_UNSUPPORTED }
  | { kind: "refuse"; method: string; note: typeof MCP_APP_UNSUPPORTED; response: McpAppRefusal };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * O que o host faz com uma mensagem do iframe. Pedido com `id` é recusado (`refuse`), a menos que a sessão
 * tenha um handler para o método: aí quem decide é ele (aprovação, tela cheia). Notificação sem `id` só é
 * registrada. `navigate-away` para o app.
 */
export function decideAppMessage(data: unknown): AppDecision {
  if (!isRecord(data)) return { kind: "ignore" };
  if (data.source === "ags-mcp-app" && data.kind === "navigate-away") return { kind: "stop" };
  if (data.source === "ags-mcp-app" && data.kind === "user-gesture") return { kind: "gesture" };
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

/** O desfecho de um handler: o `result` do JSON-RPC, ou o `error` (que o app recebe como erro). */
export type McpAppRpcOutcome = { result: unknown } | { error: { code: number; message: string } };
export type McpAppHandler = (params: unknown) => Promise<McpAppRpcOutcome> | McpAppRpcOutcome;
/** Só métodos que o host escolheu atender. O resto continua recusado com -32601. */
export type McpAppHandlers = Partial<Record<string, McpAppHandler>>;

export const RPC_INTERNAL_ERROR = -32603;

export interface McpAppHostTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface McpAppSessionOptions {
  host?: McpAppHostTarget;
  getFrameWindow: () => Window | null;
  onStop: () => void;
  onLog?: (entry: McpAppLogEntry) => void;
  /** Métodos atendidos pelo host, cada um por sua conta e com a aprovação que exigir. */
  handlers?: McpAppHandlers;
  /** O app avisou que a pessoa clicou nele. */
  onGesture?: () => void;
}

/**
 * Escuta só o iframe deste app. `close` tira o listener.
 * O host não arma timer; o documento do iframe some com ele, e os timers de lá também.
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
      if (decision.kind === "gesture") {
        try { options.onGesture?.(); } catch { /* o app não derruba a timeline */ }
        return;
      }
      // `hasOwn`: o método vem do app, e `handlers["constructor"]` não pode virar função.
      const handler = decision.kind === "refuse" && options.handlers && Object.prototype.hasOwnProperty.call(options.handlers, decision.method)
        ? options.handlers[decision.method]
        : undefined;
      if (decision.kind === "refuse" && handler) {
        const params = (message.data as { params?: unknown }).params;
        void answer(frame, decision.response.id, handler, params);
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

  /** Roda o handler e devolve ao app o resultado ou o erro. Depois de `close` ninguém é respondido. */
  async function answer(frame: Window, id: string | number, handler: McpAppHandler, params: unknown): Promise<void> {
    let outcome: McpAppRpcOutcome;
    try {
      outcome = await handler(params);
    } catch {
      outcome = { error: { code: RPC_INTERNAL_ERROR, message: "erro interno" } };
    }
    if (closed) return;
    try { frame.postMessage({ jsonrpc: "2.0", id, ...outcome }, "*"); } catch { /* canal já fechado */ }
  }

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
