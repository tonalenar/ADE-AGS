import { describe, expect, it } from "vitest";

import { basenameOf, buildProjectRows, iconValueOf, withAgentEnabled } from "../projectsSettingsModel";
import type { ChatProjectIdentity } from "@/features/chat/chatProjectIdentity";

const identity = (over: Partial<ChatProjectIdentity> = {}): ChatProjectIdentity => ({
  known: false, pinned: false, archived: false, icon: null, name: null, branch: null, ...over,
});

describe("a lista de projetos da página", () => {
  it("o nome da pasta é o último pedaço do caminho, e a raiz fica com ele mesmo", () => {
    expect(basenameOf("/Users/ton/app")).toBe("app");
    expect(basenameOf("/Users/ton/app/")).toBe("app");
    expect(basenameOf("C:\\dev\\app")).toBe("app");
    expect(basenameOf("/")).toBe("/");
  });

  it("junta as conversas por pasta, com a mais recente e a contagem", () => {
    const rows = buildProjectRows({
      conversations: [
        { cwd: "/p/app", openedAt: 10 },
        { cwd: "/p/app/", openedAt: 30 },
        { cwd: "/p/outro", openedAt: 5 },
      ],
      identities: {},
    });
    const app = rows.find((r) => r.key === "/p/app");
    expect(app).toMatchObject({ name: "app", conversations: 2, latest: 30 });
    expect(rows.find((r) => r.key === "/p/outro")?.conversations).toBe(1);
  });

  it("usa o nome que a pessoa deu e mostra fixado e arquivado", () => {
    const rows = buildProjectRows({
      conversations: [{ cwd: "/p/app", openedAt: 1 }],
      identities: { "/p/app": identity({ known: true, name: "Meu app", pinned: true, archived: true }) },
    });
    expect(rows[0]).toMatchObject({ name: "Meu app", pinned: true, archived: true });
  });

  it("um projeto só com rótulo (fixado, arquivado ou renomeado) entra mesmo sem conversa", () => {
    const rows = buildProjectRows({
      conversations: [],
      identities: {
        "/p/so-rotulo": identity({ known: true, name: "Só rótulo" }),
        "/p/so-fixado": identity({ pinned: true }),
        "/p/sem-nada": identity({ icon: { kind: "emoji", value: "🚀" } }),
      },
    });
    expect(rows.map((r) => r.key).sort()).toEqual(["/p/so-fixado", "/p/so-rotulo"]);
    expect(rows.find((r) => r.key === "/p/so-rotulo")?.conversations).toBe(0);
  });
});

describe("a política de agentes do projeto", () => {
  it("ligar tira da lista de bloqueados; desligar põe, sem repetir e em ordem", () => {
    expect(withAgentEnabled(["codex"], "claude-code", false)).toEqual(["claude-code", "codex"]);
    expect(withAgentEnabled(["codex", "claude-code"], "codex", true)).toEqual(["claude-code"]);
    expect(withAgentEnabled(["codex"], "codex", false)).toEqual(["codex"]);
  });

  it("o ícone aparece como o valor dele, e o automático é nulo", () => {
    expect(iconValueOf({ kind: "monogram", value: "AG" })).toBe("AG");
    expect(iconValueOf(null)).toBeNull();
  });
});
