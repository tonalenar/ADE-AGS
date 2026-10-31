import { describe, expect, it } from "vitest";

import { commandTitle } from "../timeline/toolTitle";

describe("commandTitle", () => {
  it("tira o invólucro do shell e separa o programa dos argumentos", () => {
    const t = commandTitle(`/bin/zsh -lc "tail -7 /tmp/ade-ai-memory-backend.CgesI3/fase5-t.log"`);
    expect(t.program).toBe("tail");
    expect(t.rest).toBe("-7 /tmp/ade-ai-memory-backend.CgesI3/fase5-t.log");
    expect(t.script).toBe(false);
  });

  it("heredoc vira só o programa, marcado como script", () => {
    const t = commandTitle(`/bin/zsh -lc "python3 - <<'PY'\nimport json\nprint(1)\nPY"`);
    expect(t.program).toBe("python3");
    expect(t.rest).toBe("");
    expect(t.script).toBe(true);
  });

  it("ignora variáveis de ambiente no começo e o cd antes do &&", () => {
    expect(commandTitle(`/bin/zsh -lc 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=branch.x git status'`).program).toBe("git");
    const t = commandTitle("cd /repo && bun run test");
    expect(t.program).toBe("bun");
    expect(t.rest).toBe("run test");
  });

  it("usa a primeira linha útil de um comando multilinha", () => {
    const t = commandTitle("\n  echo um\necho dois");
    expect(t.program).toBe("echo");
    expect(t.rest).toBe("um");
  });

  it("guarda o comando inteiro, sem o invólucro, para o tooltip", () => {
    expect(commandTitle(`bash -lc "sed -n '2499,2518p' arquivo"`).full).toBe("sed -n '2499,2518p' arquivo");
  });

  it("aceita comando sem invólucro e o caminho completo do programa", () => {
    const t = commandTitle("/usr/bin/git diff --stat");
    expect(t.program).toBe("git");
    expect(t.rest).toBe("diff --stat");
  });

  it("vazio não quebra", () => {
    expect(commandTitle("   ")).toEqual({ program: "", rest: "", full: "", script: false });
  });
});
