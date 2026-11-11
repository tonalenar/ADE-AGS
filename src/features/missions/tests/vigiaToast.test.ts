import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/features/chat/chatActions", () => ({ openConversation: mocks.open }));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));

import { abrirConversaDoVigia, vigiaToast } from "../vigiaToast";

describe("vigiaToast", () => {
  it("o aviso do Vigia sai no tom de atenção, com o botão 'Abrir conversa' (a chave que já existe)", () => {
    const toast = vigiaToast("Vigia", "Codex parece travado", "tab-codex");
    expect(toast).toMatchObject({ title: "Vigia", text: "Codex parece travado", tone: "warning", ms: 12_000 });
    expect(toast.actionLabel).toBe("chat.inbox.open");
    expect(typeof toast.onAction).toBe("function");
  });

  it("abrir a conversa leva à conversa indicada, e só a ela", async () => {
    await abrirConversaDoVigia("tab-lider");
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.open).toHaveBeenCalledWith("tab-lider");
  });

  it("o tempo na tela pode ser outro, e o padrão é o de sempre", () => {
    expect(vigiaToast("Vigia", "t", "x", 5_000).ms).toBe(5_000);
  });
});
