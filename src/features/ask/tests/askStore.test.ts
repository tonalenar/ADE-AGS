import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAskStore, type UserQuestion } from "../askStore";

function question(resolve: (answer: string | null) => void): UserQuestion {
  return { id: "q1", question: "Qual conta?", options: [], from: "QA", fromId: "tab-1", expiresAt: 0, resolve };
}

describe("askStore: prazo vencido", () => {
  beforeEach(() => useAskStore.setState({ questions: [] }));

  it("mantém a pergunta na tela e manda a resposta tardia como mensagem", () => {
    const first = vi.fn();
    const deliver = vi.fn();
    useAskStore.getState().add(question(first));
    useAskStore.getState().expire("q1", deliver);
    expect(useAskStore.getState().questions[0]?.late).toBe(true);
    useAskStore.getState().answer("q1", "a de teste");
    expect(deliver).toHaveBeenCalledWith("a de teste");
    expect(first).not.toHaveBeenCalled();
    expect(useAskStore.getState().questions).toHaveLength(0);
  });

  it("pular depois do prazo não manda nada", () => {
    const deliver = vi.fn();
    useAskStore.getState().add(question(vi.fn()));
    useAskStore.getState().expire("q1", deliver);
    useAskStore.getState().answer("q1", null);
    expect(deliver).not.toHaveBeenCalled();
    expect(useAskStore.getState().questions).toHaveLength(0);
  });

  it("prazo vencido sem aba tira da tela sem responder null", () => {
    const resolve = vi.fn();
    useAskStore.getState().add(question(resolve));
    useAskStore.getState().drop("q1");
    expect(useAskStore.getState().questions).toHaveLength(0);
    expect(resolve).not.toHaveBeenCalled();
  });
});
