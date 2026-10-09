import { describe, expect, it } from "vitest";
import { createPtyReplay } from "../ptyReplay";

function setup() {
  const out: string[] = [];
  return { out, replay: createPtyReplay((data) => out.push(data)) };
}

describe("createPtyReplay", () => {
  it("o que saiu antes do ouvinte vem no snapshot, e o ao vivo depois dele segue", () => {
    const { out, replay } = setup();
    replay.ready({ data: "$ ", total: 2 });
    replay.push({ data: "ls\r\n", end: 6 });
    expect(out.join("")).toBe("$ ls\r\n");
  });

  it("eventos enfileirados que o snapshot já cobria não se repetem", () => {
    const { out, replay } = setup();
    replay.push({ data: "$ ", end: 2 }); // chegou ao vivo, mas o snapshot (total 2) já o tem
    replay.push({ data: "ls", end: 4 }); // depois do snapshot
    replay.ready({ data: "$ ", total: 2 });
    expect(out.join("")).toBe("$ ls");
  });

  it("depois do snapshot, o que termina até o total é descartado e o resto passa", () => {
    const { out, replay } = setup();
    replay.ready({ data: "abc", total: 3 });
    replay.push({ data: "c", end: 3 });
    replay.push({ data: "d", end: 4 });
    expect(out.join("")).toBe("abcd");
  });

  it("um aviso do app (sem end) sempre aparece, na ordem", () => {
    const { out, replay } = setup();
    replay.push({ data: "\r\naviso\r\n" });
    replay.ready({ data: "x", total: 1 });
    expect(out.join("")).toBe("x\r\naviso\r\n");
  });

  it("sem snapshot (processo já terminado) a fila inteira é escrita", () => {
    const { out, replay } = setup();
    replay.push({ data: "erro", end: 4 });
    replay.abort();
    replay.push({ data: "!", end: 5 });
    expect(out.join("")).toBe("erro!");
  });
});
