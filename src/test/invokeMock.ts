/**
 * Mock do `invoke` do Tauri por nome de comando, para os testes do vitest.
 *
 * Cada comando que o teste espera ganha uma resposta (`on` para todas as chamadas, `once` para a próxima). Uma
 * chamada sem resposta preparada rejeita com um erro claro E fica registrada: `assertNoUnmatched()` (chamado
 * sozinho no `afterEach` por `useInvokeMock`) falha o teste. Uma resposta `once` que ninguém consumiu também
 * falha: o teste que passa porque a chamada sumiu deixa de passar.
 *
 * Uso:
 *
 * ```ts
 * import { invokeMock, useInvokeMock } from "@/test/invokeMock";
 * vi.mock("@tauri-apps/api/core", () => import("@/test/invokeMock").then((m) => m.tauriCoreMock()));
 * useInvokeMock();
 *
 * it("…", async () => {
 *   invokeMock.on("peer_queue_list", () => []);
 *   invokeMock.once("peer_queue_cancel", ({ id }) => ({ id }));
 *   // …
 *   expect(invokeMock.calls("peer_queue_cancel")).toEqual([{ id: 1 }]);
 * });
 * ```
 *
 * Ver `docs/ade-ags/BANCADA_MOTORES.md` (seção do front).
 */
import { afterEach, beforeEach, vi } from "vitest";

export type InvokeArgs = Record<string, unknown>;
/** A resposta: um valor, ou uma função dos argumentos (pode ser `async`, ou lançar para simular erro). */
export type ReplyFn = (args: InvokeArgs) => unknown;
export type Reply = ReplyFn | string | number | boolean | bigint | object | null | undefined;

type Call = { cmd: string; args: InvokeArgs };

function isHandler(reply: Reply): reply is ReplyFn {
  return typeof reply === "function";
}

export function createInvokeMock() {
  const always = new Map<string, Reply>();
  const queued = new Map<string, Reply[]>();
  const calls: Call[] = [];
  const unmatched: Call[] = [];

  const answer = (reply: Reply, args: InvokeArgs) => (isHandler(reply) ? reply(args) : reply);

  const invoke = vi.fn(async (cmd: string, args: InvokeArgs = {}) => {
    calls.push({ cmd, args });
    const queue = queued.get(cmd);
    if (queue && queue.length > 0) return answer(queue.shift(), args);
    if (always.has(cmd)) return answer(always.get(cmd), args);
    unmatched.push({ cmd, args });
    throw new Error(`invokeMock: "${cmd}" foi chamado sem resposta preparada (use invokeMock.on/once)`);
  });

  const mock = {
    /** A função que substitui o `invoke` de `@tauri-apps/api/core`. */
    invoke,
    /** Responde a toda chamada de `cmd` (até `reset`). */
    on(cmd: string, reply: Reply) {
      always.set(cmd, reply);
      return mock;
    },
    /** Responde à PRÓXIMA chamada de `cmd`; várias `once` respondem em ordem e vêm antes do `on`. */
    once(cmd: string, reply: Reply) {
      queued.set(cmd, [...(queued.get(cmd) ?? []), reply]);
      return mock;
    },
    /** Os argumentos de cada chamada de `cmd`, em ordem; sem `cmd`, todas as chamadas. */
    calls(cmd?: string): InvokeArgs[] | Call[] {
      return cmd === undefined ? [...calls] : calls.filter((c) => c.cmd === cmd).map((c) => c.args);
    },
    /** Os nomes chamados, em ordem. */
    commands(): string[] {
      return calls.map((c) => c.cmd);
    },
    /** Falha se houve chamada sem resposta ou se sobrou resposta `once` sem chamada. */
    assertNoUnmatched() {
      const problems: string[] = [];
      for (const c of unmatched) problems.push(`chamado sem resposta: ${c.cmd} ${JSON.stringify(c.args)}`);
      for (const [cmd, queue] of queued) {
        if (queue.length > 0) problems.push(`preparado e nunca chamado: ${cmd} (${queue.length}x once)`);
      }
      if (problems.length > 0) throw new Error(`invokeMock:\n  ${problems.join("\n  ")}`);
    },
    /** Esquece respostas e chamadas (o `useInvokeMock` faz isso antes de cada teste). */
    reset() {
      always.clear();
      queued.clear();
      calls.length = 0;
      unmatched.length = 0;
      invoke.mockClear();
    },
  };
  return mock;
}

export type InvokeMock = ReturnType<typeof createInvokeMock>;

/** O mock do arquivo de teste (o módulo é um por arquivo no vitest, como o `vi.mock`). */
export const invokeMock: InvokeMock = createInvokeMock();

/** A fábrica para `vi.mock("@tauri-apps/api/core", …)`. */
export function tauriCoreMock() {
  return { invoke: invokeMock.invoke };
}

/** Limpa antes de cada teste e cobra `assertNoUnmatched()` depois. */
export function useInvokeMock(mock: InvokeMock = invokeMock) {
  beforeEach(() => mock.reset());
  afterEach(() => mock.assertNoUnmatched());
  return mock;
}
