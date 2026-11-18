import { describe, expect, it } from "vitest";

import { createMcpAppSession } from "../mcpAppBridge";

describe("o registro do app MCP tem teto", () => {
  it("uma enxurrada de mensagens do app não faz o registro crescer sem limite", () => {
    const listeners = new Set<(ev: MessageEvent) => void>();
    const frame = { postMessage: () => undefined };
    const session = createMcpAppSession({
      host: {
        addEventListener: (_t: string, fn: EventListener) => { listeners.add(fn as (ev: MessageEvent) => void); },
        removeEventListener: (_t: string, fn: EventListener) => { listeners.delete(fn as (ev: MessageEvent) => void); },
      },
      getFrameWindow: () => frame as unknown as Window,
      onStop: () => undefined,
    });
    for (let i = 0; i < 1000; i++) {
      for (const fn of listeners) fn({ data: { jsonrpc: "2.0", id: i, method: "tools/call" }, source: frame } as unknown as MessageEvent);
    }
    expect(session.logs.length).toBeLessThanOrEqual(200);
    session.close();
  });
});
