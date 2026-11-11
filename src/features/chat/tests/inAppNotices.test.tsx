// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AlertaToast } from "@/shared/ui/alerts";

import { abrirConversaDoAviso, InAppNotices } from "../InAppNotices";

const mocks = vi.hoisted(() => ({ select: vi.fn() }));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: vi.fn().mockResolvedValue({}) }));
vi.mock("@/features/chat/unified/selectionActions", () => ({ selectConversation: mocks.select }));
vi.mock("@/features/settings/inAppNoticesPreference", () => ({ useInAppNotices: () => true }));
vi.mock("@/features/chat/liveStore", () => ({ useChatLive: (select: (s: unknown) => unknown) => select({ phase: {}, question: {}, awaiting: {} }) }));
vi.mock("@/features/chat/structured/store", () => ({ useStructured: (select: (s: unknown) => unknown) => select({ live: {} }) }));
vi.mock("@/features/chat/unified/useConversations", () => ({
  useConversations: () => [{ ref: "thread:t-1", title: "Refatorar o login" }],
  useSelectedRef: () => null,
}));
vi.mock("@/features/chat/noticeRules", () => ({
  noticeStatesOf: () => ({}),
  noticesBetween: () => [{ ref: "thread:t-1", kind: "done" }],
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.mocked(AlertaToast).mockClear();
  mocks.select.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.restoreAllMocks();
});

describe("o aviso no app de conversa que terminou, falhou ou pede algo", () => {
  it("traz o botão 'Abrir conversa' (a chave que já existe) para a conversa do evento", async () => {
    await act(async () => { root.render(<InAppNotices />); });
    expect(AlertaToast).toHaveBeenCalledTimes(1);
    const [title, , icon, , , action] = vi.mocked(AlertaToast).mock.calls[0]!;
    expect(title).toBe("Refatorar o login");
    expect(icon).toBe("success");
    expect(action?.label).toBe("chat.inbox.open");
    action?.onClick();
    await vi.waitFor(() => expect(mocks.select).toHaveBeenCalledWith("thread:t-1"));
  });

  it("abrir a conversa leva à conversa indicada, e só a ela", async () => {
    await abrirConversaDoAviso("tab-codex");
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.select).toHaveBeenCalledWith("tab-codex");
  });
});
