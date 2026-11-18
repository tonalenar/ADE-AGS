// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

// O registro de terminais é trocado por um dublê que dispara os eventos da política na ordem que interessa.
vi.mock("../terminalRegistry", () => ({
  pasteIntoTab: vi.fn(),
  screenOf: vi.fn(() => ({ lines: ["Editei o arquivo.", "›"], end: 2, alt: false })),
  sendWhenReady: vi.fn(),
}));
vi.mock("@/shared/brand/botToastStore", () => ({ showBotToast: vi.fn(() => 1) }));

import { pasteIntoTab, type SubmitPolicy } from "../terminalRegistry";
import { writeToAgent } from "../safeWrite";

const paste = vi.mocked(pasteIntoTab);

beforeEach(() => {
  paste.mockReset();
});

describe("writeToAgent: uma só resolução, pelo primeiro evento real (fix 2)", () => {
  it("um bloqueio antes de colar é o resultado, mesmo que a colagem depois devolva falso", async () => {
    paste.mockImplementation((_tab, _text, _submit, _onRetry, policy?: SubmitPolicy) => {
      policy?.onBlocked?.("blocked-busy", false);
      return false;
    });
    expect(await writeToAgent("resolucao-antes", "msg", { submit: true, source: "peer" })).toBe("blocked-busy");
  });

  it("um Enter barrado depois de colar é 'unconfirmed', e não vira 'no-terminal'", async () => {
    paste.mockImplementation((_tab, _text, _submit, _onRetry, policy?: SubmitPolicy) => {
      policy?.onBlocked?.("blocked-waiting-user", true);
      return true;
    });
    expect(await writeToAgent("resolucao-depois", "msg", { submit: true, source: "vigia" })).toBe("unconfirmed");
  });

  it("sem evento nenhum e sem terminal, o resultado é 'no-terminal'", async () => {
    paste.mockReturnValue(false);
    expect(await writeToAgent("resolucao-sem-terminal", "msg", { submit: true, source: "peer" })).toBe("no-terminal");
  });
});
