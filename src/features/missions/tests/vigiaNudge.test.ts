import { describe, expect, it } from "vitest";

import { contaLembreteEnviado, type Watch } from "../vigia";

const base: Watch = { startedAt: 0, nudges: 0, limitReported: false };

describe("contaLembreteEnviado (A168): o lembrete conta no registro atual", () => {
  it("o contador vai para o registro que o tick seguinte deixou, não para o objeto antigo", () => {
    // O tick trocou o registro (nudges 2); a cutucada que saiu agora tinha capturado o objeto com 0.
    expect(contaLembreteEnviado({ ...base, nudges: 2 }, base)).toBe(3);
  });

  it("sem registro guardado, conta a partir do capturado", () => {
    expect(contaLembreteEnviado(undefined, { ...base, nudges: 1 })).toBe(2);
  });
});
