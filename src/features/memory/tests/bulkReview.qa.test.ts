import { describe, expect, it, vi } from "vitest";
import {
  approveBulk,
  itemId,
  normalizeGroups,
  planBulk,
  rejectBulk,
  selectedItems,
  totalPending,
  type MissionReviewGroup,
} from "../bulkReview";
import type { MemoryReviewItem } from "../types";

const makeItem = (key: string, overrides: Partial<MemoryReviewItem> = {}): MemoryReviewItem => ({
  entryId: `entry-${key}`,
  revision: 1,
  key,
  kind: "decision",
  body: `Decisão referente a ${key}`,
  priority: 2,
  evidence: {
    runId: "run-12345678",
    taskId: "task-abcdef12",
    factId: null,
    actorKind: "worker",
    reason: "Verificado no código",
  },
  highValue: false,
  score: 40,
  ...overrides,
});

const makeContradiction = (key: string, oldKey = "regra-antiga"): MemoryReviewItem =>
  makeItem(key, {
    contradicts: { entryId: "entry-old", key: oldKey },
    score: 85,
  });

const makeDuplicate = (key: string, oldKey = "decisao-anterior"): MemoryReviewItem =>
  makeItem(key, {
    duplicateOf: { entryId: "entry-prev", key: oldKey },
    score: 30,
  });

const makeHighValue = (key: string, score = 80): MemoryReviewItem =>
  makeItem(key, {
    highValue: true,
    score,
  });

describe("bulkReview - QA Suite de Segurança e Lógica em Massa de Memória", () => {
  describe("planejamento em massa (planBulk)", () => {
    it("detecta contradicoes e exige aviso antes de aceitar (needsWarning = true)", () => {
      const items = [
        makeItem("item-normal"),
        makeContradiction("porta-padrao-8080", "porta-padrao-3000"),
        makeDuplicate("duplicata-doc"),
      ];

      const plan = planBulk(items);
      expect(plan.total).toBe(3);
      expect(plan.duplicates).toBe(1);
      expect(plan.needsWarning).toBe(true);
      expect(plan.contradictions).toHaveLength(1);
      expect(plan.contradictions[0].key).toBe("porta-padrao-8080");
    });

    it("quando nao ha contradicoes, libera aprovacao sem aviso (needsWarning = false)", () => {
      const items = [
        makeItem("convencao-codigo"),
        makeDuplicate("alias-existente"),
        makeHighValue("arquitetura-db"),
      ];

      const plan = planBulk(items);
      expect(plan.total).toBe(3);
      expect(plan.duplicates).toBe(1);
      expect(plan.needsWarning).toBe(false);
      expect(plan.contradictions).toHaveLength(0);
    });
  });

  describe("garantia contra aceitacao acidental de contradicoes (approveBulk)", () => {
    it("CRITICO: SEM confirmacao explicita (acknowledgeContradictions: false), PULA contradicoes e nao chama decide", async () => {
      const decide = vi.fn().mockResolvedValue(undefined);
      const items = [
        makeItem("normal-1"),
        makeContradiction("conflito-1"),
        makeItem("normal-2"),
        makeContradiction("conflito-2"),
      ];

      const result = await approveBulk(items, decide, { acknowledgeContradictions: false });

      // Deve aprovar apenas os 2 itens normais
      expect(result.done).toBe(2);
      expect(result.failed).toEqual([]);
      expect(result.skippedContradictions).toEqual(["conflito-1", "conflito-2"]);

      // Verifica que decide foi chamado exatamente duas vezes com approve=true
      expect(decide).toHaveBeenCalledTimes(2);
      expect(decide).toHaveBeenCalledWith("entry-normal-1", 1, true);
      expect(decide).toHaveBeenCalledWith("entry-normal-2", 1, true);

      // E NUNCA foi chamado para as contradicoes
      expect(decide).not.toHaveBeenCalledWith("entry-conflito-1", 1, true);
      expect(decide).not.toHaveBeenCalledWith("entry-conflito-2", 1, true);
    });

    it("COM confirmacao do usuario (acknowledgeContradictions: true), aprova tudo inclusive contradicoes", async () => {
      const decide = vi.fn().mockResolvedValue(undefined);
      const items = [
        makeItem("normal-1"),
        makeContradiction("conflito-1"),
      ];

      const result = await approveBulk(items, decide, { acknowledgeContradictions: true });

      expect(result.done).toBe(2);
      expect(result.skippedContradictions).toEqual([]);
      expect(decide).toHaveBeenCalledTimes(2);
      expect(decide).toHaveBeenCalledWith("entry-normal-1", 1, true);
      expect(decide).toHaveBeenCalledWith("entry-conflito-1", 1, true);
    });

    it("resiliencia contra erros: falha em um item nao impede o processamento dos demais", async () => {
      const decide = vi.fn()
        .mockResolvedValueOnce(undefined) // item-1 ok
        .mockRejectedValueOnce(new Error("Database locked")) // item-2 falha
        .mockResolvedValueOnce(undefined); // item-3 ok

      const items = [makeItem("item-1"), makeItem("item-2"), makeItem("item-3")];

      const result = await approveBulk(items, decide, { acknowledgeContradictions: false });

      expect(result.done).toBe(2);
      expect(result.failed).toEqual(["item-2"]);
      expect(decide).toHaveBeenCalledTimes(3);
    });
  });

  describe("rejeicao em massa (rejectBulk)", () => {
    it("rejeita todos os itens sem pular contradicoes e sem exigir confirmacao de aviso", async () => {
      const decide = vi.fn().mockResolvedValue(undefined);
      const items = [
        makeItem("normal-1"),
        makeContradiction("conflito-1"),
        makeDuplicate("duplicata-1"),
      ];

      const result = await rejectBulk(items, decide);

      expect(result.done).toBe(3);
      expect(result.skippedContradictions).toEqual([]);
      expect(decide).toHaveBeenCalledTimes(3);
      expect(decide).toHaveBeenCalledWith("entry-normal-1", 1, false);
      expect(decide).toHaveBeenCalledWith("entry-conflito-1", 1, false);
      expect(decide).toHaveBeenCalledWith("entry-duplicata-1", 1, false);
    });
  });

  describe("ordenacao e agrupamento (normalizeGroups)", () => {
    it("ordena missoes por titulo e itens por prioridade (contradicoes > highValue > normal > duplicatas)", () => {
      const groups: MissionReviewGroup[] = [
        {
          missionId: "m-2",
          title: "Missao Beta",
          items: [makeItem("item-b")],
        },
        {
          missionId: "m-1",
          title: "Missao Alfa",
          items: [
            makeDuplicate("dup-1"),
            makeItem("normal-1"),
            makeContradiction("contra-1"),
            makeHighValue("high-1", 90),
          ],
        },
        {
          missionId: "m-3",
          title: "Missao Vazia",
          items: [],
        },
      ];

      const normalized = normalizeGroups(groups);

      // Missao Vazia deve ser descartada
      expect(normalized).toHaveLength(2);
      expect(normalized[0].title).toBe("Missao Alfa");
      expect(normalized[1].title).toBe("Missao Beta");

      // Ordem dos itens dentro de Alfa: contradicao -> highValue -> normal -> duplicata
      const alfaKeys = normalized[0].items.map((i) => i.key);
      expect(alfaKeys).toEqual(["contra-1", "high-1", "normal-1", "dup-1"]);

      expect(totalPending(normalized)).toBe(5);
    });
  });

  describe("selecao pontual (selectedItems)", () => {
    it("filtra exatamente os itens do conjunto de selecao", () => {
      const itemA = makeItem("a");
      const itemB = makeItem("b");
      const itemC = makeItem("c");

      const groups: MissionReviewGroup[] = [
        { missionId: "m-1", title: "M1", items: [itemA, itemB] },
        { missionId: "m-2", title: "M2", items: [itemC] },
      ];

      const selection = new Set([itemId(itemA), itemId(itemC)]);
      const selected = selectedItems(groups, selection);

      expect(selected.map((i) => i.key)).toEqual(["a", "c"]);
    });
  });
});
