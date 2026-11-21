import { describe, expect, it } from "vitest";

import {
  addEdge,
  emptyBoard,
  reconcile,
  remoteRefOf,
  syncRemoteNodesForFolder,
} from "@/features/canvas/board";

describe("nó de agente remoto no canvas", () => {
  it("no_remoto_aparece_no_canvas_da_pasta", () => {
    const clients = [
      { id: "c1", name: "Claude Laptop", default_folder: "/repo/app/", revoked: false },
      { id: "c2", name: "Outro Projeto", default_folder: "/repo/outro", revoked: false },
      { id: "c3", name: "Revogado", default_folder: "/repo/app", revoked: true },
    ];

    const initial = emptyBoard();
    const synced = syncRemoteNodesForFolder(initial, "/repo/app", clients);

    const ref1 = remoteRefOf("c1");
    expect(ref1).toBe("remote:c1");
    expect(synced.remotes[ref1]).toBeDefined();
    expect(synced.remotes[remoteRefOf("c2")]).toBeUndefined();
    expect(synced.remotes[remoteRefOf("c3")]).toBeUndefined();

    // Idempotente: sem mudança, devolve a mesma referência.
    expect(syncRemoteNodesForFolder(synced, "/repo/app", clients)).toBe(synced);

    // Corda entre o nó remoto e uma aba sobrevive ao reconcile das abas.
    const linked = addEdge(reconcile(synced, ["tab-1"]), ref1, "tab-1", "edge-1");
    const afterReconcile = reconcile(linked, ["tab-1"]);
    expect(afterReconcile.edges).toHaveLength(1);
    expect(afterReconcile.edges[0]).toEqual({ id: "edge-1", a: ref1, b: "tab-1" });

    // Revogar remove o nó e a corda dele.
    const afterRevoke = syncRemoteNodesForFolder(afterReconcile, "/repo/app", [
      { id: "c1", name: "Claude Laptop", default_folder: "/repo/app", revoked: true },
    ]);
    expect(afterRevoke.remotes[ref1]).toBeUndefined();
    expect(afterRevoke.edges).toHaveLength(0);
  });

  it("revogar limpa também coroa, papel e marca de subagente, sem sobrepor nós existentes", () => {
    const base = reconcile(emptyBoard(), ["tab-1"]);
    const synced = syncRemoteNodesForFolder(base, "/repo/app", [
      { id: "c1", name: "Codex Remoto", default_folder: "/repo/app", revoked: false },
    ]);
    const ref1 = remoteRefOf("c1");
    const boxTab = synced.nodes["tab-1"];
    const boxRemote = synced.remotes[ref1];
    expect(boxRemote).toBeDefined();
    expect(
      boxTab.x < boxRemote.x + boxRemote.w &&
      boxRemote.x < boxTab.x + boxTab.w &&
      boxTab.y < boxRemote.y + boxRemote.h &&
      boxRemote.y < boxTab.y + boxTab.h,
    ).toBe(false);

    const crowned = {
      ...addEdge(synced, ref1, "tab-1", "edge-1"),
      orchestrators: [ref1],
      roles: { [ref1]: "QA" },
      subagents: [ref1],
    };
    // reconcile preserva coroa, papel e subagente do nó remoto ativo.
    const kept = reconcile(crowned, ["tab-1"]);
    expect(kept.orchestrators).toEqual([ref1]);
    expect(kept.roles).toEqual({ [ref1]: "QA" });
    expect(kept.subagents).toEqual([ref1]);

    // Revogar remove tudo do nó remoto.
    const cleaned = syncRemoteNodesForFolder(kept, "/repo/app", []);
    expect(cleaned.remotes[ref1]).toBeUndefined();
    expect(cleaned.edges).toEqual([]);
    expect(cleaned.orchestrators).toEqual([]);
    expect(cleaned.roles).toEqual({});
    expect(cleaned.subagents).toEqual([]);
  });
});
