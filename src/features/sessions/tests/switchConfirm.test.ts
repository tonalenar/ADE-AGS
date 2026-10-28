import { describe, expect, it } from "vitest";

import { answerConfirm, appConfirm, useConfirmStore } from "@/shared/ui/appConfirm";

import { switchRequest, workingLabels } from "../switchConfirm";

const t = (key: string) => key;

describe("quem está trabalhando", () => {
  it("só o nome do agente, sem repetir: dois iguais viram ×2", () => {
    expect(workingLabels([{ agentLabel: "Claude Code" }, { agentLabel: "Codex" }, { agentLabel: "Claude Code" }])).toEqual(["Claude Code ×2", "Codex"]);
  });
});

describe("o pedido de confirmação", () => {
  it("trocar, começar e salvar: explicam que a conversa fica salva e deixam ficar", () => {
    for (const intent of ["open", "new", "save"] as const) {
      const req = switchRequest(intent, ["Codex"], t);
      expect(req.title).toBe(`conversations.switch.title.${intent}`);
      expect(req.note).toBe("conversations.switch.note.save");
      expect(req.confirmLabel).toBe(`conversations.switch.confirm.${intent}`);
      expect(req.cancelLabel).toBe("conversations.switch.cancel.stay");
      expect(req.tone).toBeUndefined();
    }
  });

  it("excluir é perigoso e não promete que a conversa fica salva", () => {
    const req = switchRequest("delete", ["Codex"], t);
    expect(req.tone).toBe("danger");
    expect(req.note).toBe("conversations.switch.note.delete");
  });

  it("um agente usa a frase no singular, vários no plural", () => {
    expect(switchRequest("open", ["Codex"], t).lead).toBe("conversations.switch.leadOne");
    expect(switchRequest("open", ["Codex", "Claude Code"], t).lead).toBe("conversations.switch.leadMany");
  });
});

describe("a fila de confirmações", () => {
  it("responde na ordem e deixa o próximo pedido para depois", async () => {
    useConfirmStore.setState({ queue: [] });
    const base = { title: "t", lead: "l", confirmLabel: "sim", cancelLabel: "não" };
    const first = appConfirm(base);
    const second = appConfirm({ ...base, title: "t2" });
    expect(useConfirmStore.getState().queue[0].title).toBe("t");
    answerConfirm(true);
    expect(await first).toBe(true);
    expect(useConfirmStore.getState().queue[0].title).toBe("t2");
    answerConfirm(false);
    expect(await second).toBe(false);
    expect(useConfirmStore.getState().queue).toEqual([]);
  });
});
