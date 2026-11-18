// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { appConfirm } from "@/shared/ui/appConfirm";
import { askPersonAboutDialog, askPersonAboutReset } from "../dialogPolicy";

vi.mock("@/shared/ui/appConfirm", () => ({ appConfirm: vi.fn() }));

const confirmMock = vi.mocked(appConfirm);

describe("pergunta à pessoa sobre o que o agente disparou", () => {
  beforeEach(() => confirmMock.mockReset());

  it("confirm_permitido_vira_allow_uma_vez", async () => {
    const allow = vi.fn().mockResolvedValue(undefined);
    confirmMock.mockResolvedValueOnce(true);
    await askPersonAboutDialog({ kind: "confirm", message: "Excluir?", key: "confirm:Excluir?" }, allow);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0][0].lead).toContain("Excluir?");
    expect(allow).toHaveBeenCalledWith("confirm:Excluir?");
  });

  it("confirm_recusado_nao_libera_o_diálogo", async () => {
    const allow = vi.fn();
    confirmMock.mockResolvedValueOnce(false);
    await askPersonAboutDialog({ kind: "confirm", message: "Excluir?", key: "confirm:Excluir?" }, allow);
    expect(allow).not.toHaveBeenCalled();
  });

  it("alert_e_prompt_so_informam", async () => {
    const allow = vi.fn();
    confirmMock.mockResolvedValue(false);
    await askPersonAboutDialog({ kind: "alert", message: "Pronto", key: "alert:Pronto" }, allow);
    await askPersonAboutDialog({ kind: "prompt", message: "Nome?", key: "prompt:Nome?" }, allow);
    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(allow).not.toHaveBeenCalled();
  });
});

describe("reset de sessão", () => {
  beforeEach(() => confirmMock.mockReset());

  it("reset_pede_confirmacao_e_so_segue_se_a_pessoa_aceitar", async () => {
    confirmMock.mockResolvedValueOnce(false);
    expect(await askPersonAboutReset("https://app.exemplo.com")).toBe(false);
    expect(confirmMock.mock.calls[0][0].tone).toBe("danger");
    confirmMock.mockResolvedValueOnce(true);
    expect(await askPersonAboutReset("https://app.exemplo.com")).toBe(true);
  });
});
