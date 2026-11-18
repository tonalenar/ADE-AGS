/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "neogestify-ui-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useUiStore } from "@/app/uiStore";
import type { MessageSearchHit } from "@/features/chat/structured/ipc";
import { useStructured } from "@/features/chat/structured/store";
import { CommandPalette } from "@/features/palette/CommandPalette";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// O acerto de mensagem que a busca do backend devolve. Vem preenchido por cada teste.
const busca = vi.hoisted(() => ({ estruturada: [] as unknown[] }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
// A lista de workspaces que a paleta lê ao montar; o resto dos comandos não importa para este teste.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (comando: string) => (comando === "db_list_workspaces" ? [] : undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

// A busca estruturada devolve o acerto do teste; as demais buscas (arquivadas, de TUI) ficam vazias.
vi.mock("@/features/chat/structured/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/chat/structured/ipc")>()),
  chatThreadSearch: async () => busca.estruturada,
}));
vi.mock("@/features/sessions/ipc.conversations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/sessions/ipc.conversations")>()),
  searchArchivedSessionMessages: async () => [],
}));
// Sem o carregamento do store estruturado no mount: não há backend nos testes.
vi.mock("@/features/chat/structured/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/chat/structured/store")>()),
  startStructured: () => {},
}));

const EXCERTO = "vamos fazer o deploy em produção";

const conversa = {
  id: "t1",
  agentId: "claude",
  cwd: "/projeto",
  title: "Publicação",
  model: null,
  effort: null,
  access: "safe" as const,
  accountId: null,
  state: "active" as const,
  createdAt: 1,
  updatedAt: 1,
};

const acerto: MessageSearchHit = {
  threadId: "t1",
  title: "Publicação",
  agentId: "claude",
  cwd: "/projeto",
  itemId: "i1",
  kind: "assistant",
  excerpt: EXCERTO,
};

/** Digita no input da paleta do jeito que o React enxerga (o evento `input` com o valor novo). */
function digitar(input: HTMLInputElement, valor: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("setter de value indisponível");
  act(() => {
    setter.call(input, valor);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * Deixa a busca andar até o fim: o debounce da paleta (180 ms) avança pelo relógio falso, e as
 * promessas das buscas resolvem por microtarefas. Sem tempo real e sem laço de espera.
 */
async function assentar() {
  await act(async () => {
    vi.advanceTimersByTime(200);
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });
}

describe("paleta de comandos com mensagens", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useStructured.setState({ threads: [conversa] });
    busca.estruturada = [acerto];
    useUiStore.setState({ paletteOpen: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useUiStore.setState({ paletteOpen: false });
    useStructured.setState({ threads: [] });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("paleta_com_termo_que_casa_mensagem_renderiza", async () => {
    act(() => {
      root.render(
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <CommandPalette />
          </MemoryRouter>
        </ThemeProvider>,
      );
    });

    const input = host.querySelector("input");
    if (!input) throw new Error("a paleta não abriu um input");
    digitar(input, "deploy");
    await assentar();

    // O acerto de mensagem aparece como resultado, e a renderização não lançou.
    expect(host.textContent).toContain(EXCERTO);
  });
});
