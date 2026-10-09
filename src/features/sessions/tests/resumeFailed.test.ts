import { describe, expect, it } from "vitest";
import { RESUME_FAIL_MS, resumeFailed } from "../agentResume";

describe("resumeFailed", () => {
  it("sessão retomada que sai com erro logo ao abrir é um resume que falhou", () => {
    expect(resumeFailed(true, 1, 800)).toBe(true);
    expect(resumeFailed(true, 2, RESUME_FAIL_MS - 1)).toBe(true);
  });

  it("saída normal, tardia ou de uma aba que não era retomada não relança nada", () => {
    expect(resumeFailed(true, 0, 800)).toBe(false); // o usuário digitou /exit
    expect(resumeFailed(true, 1, RESUME_FAIL_MS)).toBe(false); // já vinha rodando
    expect(resumeFailed(false, 1, 800)).toBe(false); // não era resume: sem laço de relançamentos
    expect(resumeFailed(true, 1, -5)).toBe(false);
  });
});
