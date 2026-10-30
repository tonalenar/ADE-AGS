/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Comandos Tauri mockados; cada teste define o que cada um devolve.
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
// t devolve a chave e, se houver valores, os anexa: assim os testes veem o agente e o erro.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
    i18n: { language: "pt-BR" },
  }),
}));

import { AiMemoryPanel } from "../AiMemoryPanel";
// Fixtures reais do ai-memory 3.3.0 (src-tauri/src/ai_memory/fixtures): nada de dados inventados aqui.
import handoffsFixture from "../../../../src-tauri/src/ai_memory/fixtures/handoffs-populated.json";
import readPageFixture from "../../../../src-tauri/src/ai_memory/fixtures/read-page-populated.json";
import recentFixture from "../../../../src-tauri/src/ai_memory/fixtures/recent-populated.json";
import projectsFixture from "../../../../src-tauri/src/ai_memory/fixtures/projects.json";
import briefingFixture from "../../../../src-tauri/src/ai_memory/fixtures/sessions-briefing-populated.json";

const CWD = "/workspace";
const envelope = <T,>(data: T) => ({ source: "ai-memory", trust: "UNTRUSTED", data });

const probeOk = (sessionsSupported: boolean) => ({
  state: "ok",
  version: "3.3.0",
  installation_instruction: null,
  status: null,
  sessions_supported: sessionsSupported,
});

/** Responde por nome de comando; o que não for passado cai numa falha, para o teste notar chamada inesperada. */
function route(handlers: Record<string, (args: unknown) => unknown>) {
  invoke.mockImplementation(async (cmd: string, args: unknown) => {
    const handler = handlers[cmd];
    if (!handler) throw new Error(`comando inesperado: ${cmd}`);
    return handler(args);
  });
}

describe("AiMemoryPanel", () => {
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
    await act(async () => { root.render(<AiMemoryPanel cwd={cwd} />); });
  };
  const commands = () => invoke.mock.calls.map((c) => c[0]);

  describe("estados que não são ok", () => {
    it.each([
      ["missing", "Instale o ai-memory."],
      ["outdated", "Atualize o ai-memory."],
      ["server_down", "O servidor do ai-memory não responde."],
    ] as const)("%s mostra a mensagem e não consulta páginas nem handoffs", async (state, instruction) => {
      route({
        ai_memory_probe: () => envelope({
          state,
          version: null,
          installation_instruction: instruction,
          status: null,
          sessions_supported: false,
        }),
      });

      await render();

      expect(host.textContent).toContain(`aiMemory.state.${state}`);
      expect(host.textContent).toContain(instruction);
      expect(commands()).toEqual(["ai_memory_probe"]);
    });
  });

  it("ok mostra a wiki, os handoffs agrupados e 'sessões ainda não disponíveis'", async () => {
    // Um handoff sem destinatário (fixture real) e um para o codex, para ver os dois grupos.
    const handoffs = [
      ...handoffsFixture,
      { ...handoffsFixture[0], id: "h-codex", to_agent: "codex", created_at_ms: 1793384900000 },
    ];
    route({
      ai_memory_probe: () => envelope(probeOk(false)),
      ai_memory_recent: () => envelope(recentFixture),
      ai_memory_handoffs: () => envelope(handoffs),
    });

    await render();

    expect(host.textContent).toContain("Probe");
    expect(host.textContent).toContain('aiMemory.handoffsTo {"agent":"codex"}');
    expect(host.textContent).toContain("aiMemory.handoffsAnyone");
    expect(host.textContent).toContain("aiMemory.sessionsSoon");
    expect(commands()).toEqual(["ai_memory_probe", "ai_memory_recent", "ai_memory_handoffs"]);
    expect(invoke).toHaveBeenCalledWith("ai_memory_recent", { cwd: CWD });
  });

  it("com sessões suportadas pré-seleciona o projeto da pasta e lista as sessões dele", async () => {
    // A pasta da aba se chama "probe", como o projeto da fixture.
    const cwd = "/fixture/probe";
    route({
      ai_memory_probe: () => envelope(probeOk(true)),
      ai_memory_recent: () => envelope([]),
      ai_memory_handoffs: () => envelope([]),
      ai_memory_projects: () => envelope(projectsFixture),
      ai_memory_sessions: () => envelope(briefingFixture.recent_sessions),
    });

    await act(async () => { root.render(<AiMemoryPanel cwd={cwd} />); });
    await act(async () => {});

    expect(invoke).toHaveBeenCalledWith("ai_memory_projects", { cwd });
    expect(invoke).toHaveBeenCalledWith("ai_memory_sessions", { cwd, workspace: "ade-test", project: "probe" });
    expect(host.textContent).toContain('aiMemory.sessionLine {"agent":"codex","when":"2024-01-01T00:00:00Z"}');
    expect(host.textContent).not.toContain("aiMemory.sessionsSoon");
  });

  it("sem projeto com o nome da pasta não consulta sessões até a escolha", async () => {
    route({
      ai_memory_probe: () => envelope(probeOk(true)),
      ai_memory_recent: () => envelope([]),
      ai_memory_handoffs: () => envelope([]),
      ai_memory_projects: () => envelope(projectsFixture),
    });

    await render();
    await act(async () => {});

    expect(commands()).not.toContain("ai_memory_sessions");
  });

  it("snippet com <mark> destaca o termo sem criar HTML extra", async () => {
    route({
      ai_memory_probe: () => envelope(probeOk(false)),
      ai_memory_recent: () => envelope([{ ...recentFixture[0], snippet: "A <mark>fixtureunique</mark> local test page." }]),
      ai_memory_handoffs: () => envelope([]),
    });

    await render();

    const marks = host.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("fixtureunique");
    expect(host.textContent).toContain("A fixtureunique local test page.");
  });

  it("snippet com '<img onerror>' não vira elemento: nenhum img nem atributo onerror no DOM", async () => {
    route({
      ai_memory_probe: () => envelope(probeOk(false)),
      ai_memory_recent: () => envelope([{ ...recentFixture[0], snippet: "<img src=x onerror=alert(1)> texto seguro" }]),
      ai_memory_handoffs: () => envelope([]),
    });

    await render();

    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelectorAll("[onerror]")).toHaveLength(0);
    expect(host.textContent).toContain("texto seguro");
  });

  it("erro do invoke mostra o alerta com a mensagem", async () => {
    route({ ai_memory_probe: () => { throw new Error("binário travou"); } });

    await render();

    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("aiMemory.error");
    expect(alert?.textContent).toContain("binário travou");
  });

  it("clicar numa página chama ai_memory_read_page e mostra o corpo como texto", async () => {
    route({
      ai_memory_probe: () => envelope(probeOk(false)),
      ai_memory_recent: () => envelope(recentFixture),
      ai_memory_handoffs: () => envelope([]),
      ai_memory_read_page: () => envelope(readPageFixture),
    });

    await render();
    const pageButton = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Probe"));
    expect(pageButton).toBeDefined();
    await act(async () => { pageButton!.click(); });

    expect(invoke).toHaveBeenCalledWith("ai_memory_read_page", { cwd: CWD, path: "notes/probe.md" });
    const body = host.querySelector("article pre");
    expect(body?.textContent).toBe(readPageFixture.body);
  });

  it("corpo de página com HTML aparece como texto, sem elemento criado", async () => {
    const hostile = "<img src=x onerror=alert(1)>\n<script>alert(2)</script> fim";
    route({
      ai_memory_probe: () => envelope(probeOk(false)),
      ai_memory_recent: () => envelope(recentFixture),
      ai_memory_handoffs: () => envelope([]),
      ai_memory_read_page: () => envelope({ ...readPageFixture, body: hostile }),
    });

    await render();
    const pageButton = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Probe"));
    await act(async () => { pageButton!.click(); });

    expect(host.querySelector("article pre")?.textContent).toBe(hostile);
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("script")).toBeNull();
  });

  it("estado ok mostra o aviso fixo de decaimento: o ADE só avisa e não apaga", async () => {
    route({
      ai_memory_probe: () => envelope(probeOk(false)),
      ai_memory_recent: () => envelope([]),
      ai_memory_handoffs: () => envelope([]),
    });

    await render();

    expect(host.textContent).toContain("aiMemory.decayNote");
  });

  it("o aviso de decaimento não aparece quando o binário não está pronto", async () => {
    route({
      ai_memory_probe: () => envelope({ state: "missing", version: null, installation_instruction: "Instale.", status: null, sessions_supported: false }),
    });

    await render();

    expect(host.textContent).not.toContain("aiMemory.decayNote");
  });

  it("página vencida (expired: true) mostra que o prazo passou e que nada foi apagado", async () => {
    route({
      ai_memory_probe: () => envelope(probeOk(false)),
      ai_memory_recent: () => envelope(recentFixture),
      ai_memory_handoffs: () => envelope([]),
      ai_memory_read_page: () => envelope({ ...readPageFixture, expired: true }),
    });

    await render();
    const pageButton = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Probe"));
    await act(async () => { pageButton!.click(); });

    expect(host.querySelector("article")?.textContent).toContain("aiMemory.expired");
  });
});
