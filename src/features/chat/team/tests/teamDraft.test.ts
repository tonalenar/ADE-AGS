import { describe, expect, it } from "vitest";

import type { AgentInfo } from "@/features/tabs/types";
import {
  addDraftMember, draftMemberName, launchTeam, removeDraftMember, updateDraftMember,
  type Created, type DraftMember, type TeamPort,
} from "../teamDraft";

const agent = (id: string, label = id): AgentInfo => ({ id, label, command: id, available: true } as AgentInfo);
const fresh = (id: string, agentId = "codex", role = "reviewer"): DraftMember => ({
  id, kind: "new", agent: agent(agentId, agentId === "codex" ? "Codex" : agentId), role, policy: "read", subagent: false, model: null, effort: null, worktree: true,
});
const existing = (id: string, key: string): DraftMember => ({
  id, kind: "existing", conv: { key, agentId: "claude-code", agentLabel: "Claude Code", title: "Conversa velha", cwd: "/p" }, role: "qa", policy: "ask", subagent: true,
});

describe("o rascunho do time", () => {
  it("acrescenta, edita e remove integrantes sem mutar a lista", () => {
    const base = [fresh("a")];
    const added = addDraftMember(base, fresh("b", "gemini"));
    expect(base).toHaveLength(1);
    expect(added.map((m) => m.id)).toEqual(["a", "b"]);
    const edited = updateDraftMember(added, "b", { role: "qa", policy: "edits" });
    expect(edited[1]).toMatchObject({ role: "qa", policy: "edits" });
    expect(added[1]!.role).toBe("reviewer");
    expect(removeDraftMember(edited, "a").map((m) => m.id)).toEqual(["b"]);
  });

  it("o nome do integrante é o do agente (conversa nova) ou o título (conversa aberta)", () => {
    expect(draftMemberName(fresh("a"))).toBe("Codex");
    expect(draftMemberName(existing("b", "tab-9"))).toBe("Conversa velha");
  });
});

/** Um `TeamPort` falso que registra o que foi feito (e desfeito), na ordem. */
function fakePort(failAt: string | null = null, failUndo: string | null = null) {
  const log: string[] = [];
  const step = async (name: string, ref: string): Promise<Created> => {
    if (failAt === name) throw new Error(`falhou ${name}`);
    log.push(`criou ${name}`);
    return { ref, undo: async () => { if (failUndo === name) throw new Error(`não desfez ${name}`); log.push(`desfez ${name}`); }, describe: name };
  };
  const port: TeamPort = {
    createLead: () => step("lead", "tab-lead"),
    makeTeam: (lead) => step("time", lead.ref),
    linkMember: (_team, member) => step(`membro ${member.id}`, `tab-${member.id}`),
    deliver: () => { if (failAt === "entrega") throw new Error("falhou entrega"); log.push("entregou"); },
  };
  return { port, log };
}

describe("criar o time ao enviar a primeira mensagem", () => {
  it("cria a conversa, o time, cada integrante e só então entrega a mensagem, nessa ordem", async () => {
    const { port, log } = fakePort();
    const result = await launchTeam(port, [fresh("a"), existing("b", "tab-9")]);
    expect(log).toEqual(["criou lead", "criou time", "criou membro a", "criou membro b", "entregou"]);
    expect(result).toEqual({ ok: true, ref: "tab-lead", teamId: "tab-lead" });
  });

  it("falha na conversa orquestradora: nada foi criado, nada a desfazer", async () => {
    const { port, log } = fakePort("lead");
    const result = await launchTeam(port, [fresh("a")]);
    expect(log).toEqual([]);
    expect(result).toMatchObject({ ok: false, leftovers: [] });
    expect(result.ok === false && result.error).toContain("falhou lead");
  });

  it("falha no segundo integrante: desfaz o primeiro, o time e a conversa, do último ao primeiro", async () => {
    const { port, log } = fakePort("membro b");
    const result = await launchTeam(port, [fresh("a"), fresh("b", "gemini")]);
    expect(log).toEqual(["criou lead", "criou time", "criou membro a", "desfez membro a", "desfez time", "desfez lead"]);
    expect(result).toMatchObject({ ok: false, leftovers: [] });
  });

  it("falha na entrega da mensagem: desfaz tudo, e a mensagem não saiu", async () => {
    const { port, log } = fakePort("entrega");
    const result = await launchTeam(port, [fresh("a")]);
    expect(log).toEqual(["criou lead", "criou time", "criou membro a", "desfez membro a", "desfez time", "desfez lead"]);
    expect(result.ok).toBe(false);
  });

  it("o que não deu para desfazer vira sobra no resultado, e o resto é desfeito mesmo assim", async () => {
    const { port, log } = fakePort("membro b", "membro a");
    const result = await launchTeam(port, [fresh("a"), fresh("b", "gemini")]);
    expect(log).toEqual(["criou lead", "criou time", "criou membro a", "desfez time", "desfez lead"]);
    expect(result).toMatchObject({ ok: false, leftovers: ["membro a"] });
  });

  it("um worktree criado fica no disco e é avisado, mesmo com o resto desfeito", async () => {
    const { port } = fakePort("membro b");
    const link = port.linkMember;
    port.linkMember = async (team, member) => {
      const created = await link(team, member);
      return member.id === "a" ? { ...created, keeps: "worktree team/tests" } : created;
    };
    const result = await launchTeam(port, [fresh("a"), fresh("b", "gemini")]);
    expect(result).toMatchObject({ ok: false, leftovers: ["worktree team/tests"] });
  });

  it("uma etapa que falhou no meio e deixou um worktree também avisa", async () => {
    const { port } = fakePort();
    port.linkMember = async () => { throw Object.assign(new Error("ligar falhou"), { keeps: "worktree team/ui" }); };
    const result = await launchTeam(port, [fresh("a")]);
    expect(result).toMatchObject({ ok: false, error: "ligar falhou", leftovers: ["worktree team/ui"] });
  });

  it("não deixa duas criações correrem ao mesmo tempo (duplo clique)", async () => {
    const { port, log } = fakePort();
    const [first, second] = await Promise.all([launchTeam(port, [fresh("a")]), launchTeam(port, [fresh("a")])]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect(log.filter((l) => l === "criou lead")).toHaveLength(1);
  });
});
