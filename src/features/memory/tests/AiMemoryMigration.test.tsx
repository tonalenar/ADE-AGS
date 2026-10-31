/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Comandos Tauri mockados: cada teste define o que cada um devolve.
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
// t devolve a chave e, com valores, os anexa: os testes veem a contagem e o motivo.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
    i18n: { language: "pt-BR" },
  }),
}));

import { AiMemoryMigration } from "../AiMemoryMigration";

const WS = "ws-1";
const CWD = "/pasta/da/aba";

const row = (over: Record<string, unknown>) => ({
  entry_id: "e-1",
  key: null,
  revision: 1,
  status: "written",
  reason: null,
  wiki_path: null,
  aim_workspace: "WS-FAKE",
  aim_project: "projeto",
  migrated_at: 1,
  ...over,
});

const summary = (over: Record<string, unknown> = {}) => ({
  written: 2,
  skipped_secret: 1,
  conflict: 0,
  divergent: 0,
  failed: 1,
  already: 1,
  reason: null,
  stopped: null,
  ...over,
});

/** Responde por nome de comando; um comando não previsto falha, para o teste notar. */
function route(handlers: Record<string, (args: unknown) => unknown>) {
  invoke.mockImplementation(async (cmd: string, args: unknown) => {
    const handler = handlers[cmd];
    if (!handler) throw new Error(`comando inesperado: ${cmd}`);
    return handler(args);
  });
}

describe("AiMemoryMigration", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    invoke.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = async (cwd = CWD) => {
    await act(async () => { root.render(<AiMemoryMigration workspaceId={WS} cwd={cwd} />); });
  };
  const button = () => [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("aiMemory.migration.")) as HTMLButtonElement;
  const commands = () => invoke.mock.calls.map((c) => c[0]);

  it("relatório vazio mostra que ainda não houve cópia", async () => {
    route({ ai_memory_migration_report: () => [] });

    await render();

    expect(host.textContent).toContain("aiMemory.migration.never");
    expect(host.textContent).toContain("aiMemory.migration.run");
    expect(invoke).toHaveBeenCalledWith("ai_memory_migration_report", { workspaceId: WS });
  });

  it("copiadas aparecem com o nome (key) e o caminho na wiki", async () => {
    route({
      ai_memory_migration_report: () => [
        row({ entry_id: "e-id-1", key: "Decisão de autenticação", wiki_path: "ade/memoria/e-id-1.md" }),
        row({ entry_id: "e-id-2", key: null, wiki_path: "ade/memoria/e-id-2.md" }),
      ],
    });

    await render();

    expect(host.textContent).toContain('aiMemory.migration.copied {"count":2}');
    const nomes = [...host.querySelectorAll("li")].map((li) => li.textContent ?? "");
    // Com key, mostra o nome; sem key, cai no id da entrada.
    expect(nomes[0]).toContain("Decisão de autenticação");
    expect(nomes[0]).toContain("ade/memoria/e-id-1.md");
    expect(nomes[1]).toContain("e-id-2");
  });

  it("as de fora aparecem agrupadas por motivo, com o motivo de cada uma", async () => {
    route({
      ai_memory_migration_report: () => [
        row({ entry_id: "s-1", key: "chave segredo", status: "skipped_secret", reason: "segredo: não migra" }),
        row({ entry_id: "c-1", key: "chave A", status: "conflict", reason: "a página já existe" }),
        row({ entry_id: "c-2", key: "chave B", status: "conflict", reason: "a página já existe" }),
        row({ entry_id: "d-1", key: "chave C", status: "divergent", reason: "a página foi editada" }),
      ],
    });

    await render();

    expect(host.textContent).toContain('aiMemory.migration.left.skipped_secret {"count":1}');
    expect(host.textContent).toContain('aiMemory.migration.left.conflict {"count":2}');
    expect(host.textContent).toContain('aiMemory.migration.left.divergent {"count":1}');
    // Sem grupo para o que não ficou de fora (nada copiado, nada falhou).
    expect(host.textContent).not.toContain("aiMemory.migration.left.failed");
    expect(host.textContent).toContain("segredo: não migra");
    expect(host.textContent).toContain("chave B");
    const grupoConflito = [...host.querySelectorAll("details")].find((d) => d.textContent?.includes("aiMemory.migration.left.conflict"));
    expect(grupoConflito?.querySelectorAll("li")).toHaveLength(2);
  });

  it("clicar em copiar chama ai_memory_migrate com workspaceId e cwd, e mostra o resumo", async () => {
    let reportCalls = 0;
    route({
      ai_memory_migration_report: () => {
        reportCalls += 1;
        return reportCalls === 1 ? [] : [row({ key: "após a cópia" })];
      },
      ai_memory_migrate: () => summary(),
    });

    await render();
    await act(async () => { button().click(); });

    expect(invoke).toHaveBeenCalledWith("ai_memory_migrate", { workspaceId: WS, cwd: CWD });
    expect(host.textContent).toContain('aiMemory.migration.summary {"written":2,"already":1,"left":2}');
    // Depois da cópia, o relatório é lido de novo.
    expect(commands().filter((c) => c === "ai_memory_migration_report")).toHaveLength(2);
    expect(host.textContent).toContain("após a cópia");
  });

  it("sem pasta de aba, manda cwd null", async () => {
    route({
      ai_memory_migration_report: () => [],
      ai_memory_migrate: () => summary(),
    });

    await render("");
    await act(async () => { button().click(); });

    expect(invoke).toHaveBeenCalledWith("ai_memory_migrate", { workspaceId: WS, cwd: null });
  });

  it("enquanto roda, o botão fica desabilitado e mostra 'copiando'", async () => {
    let finish!: (value: unknown) => void;
    route({
      ai_memory_migration_report: () => [row({})],
      ai_memory_migrate: () => new Promise((resolve) => { finish = resolve; }),
    });

    await render();
    await act(async () => { button().click(); });

    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe("aiMemory.migration.running");

    await act(async () => { finish(summary()); });

    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe("aiMemory.migration.again");
  });

  it("erro da cópia aparece como alerta, sem resumo", async () => {
    route({
      ai_memory_migration_report: () => [],
      ai_memory_migrate: () => { throw new Error("servidor fora do ar"); },
    });

    await render();
    await act(async () => { button().click(); });

    const alerta = host.querySelector('[role="alert"]');
    expect(alerta?.textContent).toContain("aiMemory.error");
    expect(alerta?.textContent).toContain("servidor fora do ar");
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it("cópia que parou mostra o motivo da parada", async () => {
    route({
      ai_memory_migration_report: () => [],
      ai_memory_migrate: () => summary({ stopped: "ai-memory não respondeu à escrita" }),
    });

    await render();
    await act(async () => { button().click(); });

    expect(host.textContent).toContain('aiMemory.migration.stopped {"reason":"ai-memory não respondeu à escrita"}');
  });
});
