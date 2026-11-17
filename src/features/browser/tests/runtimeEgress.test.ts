// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import type { PageMessage } from "../protocol";
import { loadRuntime } from "./runtimeHarness";

interface StorageList { local: { key: string; value?: string; size: number }[]; session: { key: string; value?: string; size: number }[] }
interface DialogLog { seen: { type: string; message: string; answer: string }[] }

const asked = (sent: PageMessage[]) => sent.filter((m) => m.type === "dialog:asked");

describe("runtime: o que sai da página para o agente", () => {
  it("storage_list_sem_valores_em_site_real", async () => {
    const h = await loadRuntime("<p>x</p>");
    localStorage.setItem("token", "eyJsegredo.abc.def");
    // Sem `values` (o que o app manda num site real), a lista traz só as chaves e o tamanho.
    const semValores = await h.run({ op: "storage", action: "list" }) as StorageList;
    const entry = semValores.local.find((e) => e.key === "token");
    expect(entry).toBeDefined();
    expect(entry?.value).toBeUndefined();
    expect(entry?.size).toBe("token".length + "eyJsegredo.abc.def".length);
    expect(JSON.stringify(semValores)).not.toContain("eyJsegredo");
    // Com `values` (um servidor local), o valor volta como antes.
    const comValores = await h.run({ op: "storage", action: "list", values: true }) as StorageList;
    expect(comValores.local.find((e) => e.key === "token")?.value).toBe("eyJsegredo.abc.def");
  });

  it("confirm_do_agente_pergunta", async () => {
    const h = await loadRuntime("<p>x</p>");
    await h.run({ op: "eval", code: "confirm('Excluir a conta?')" });
    // O agente não responde pela pessoa: o `confirm` volta sem aceitar e a pergunta sai para a app.
    const log = await h.run({ op: "dialogs" }) as DialogLog;
    expect(log.seen[log.seen.length - 1]?.answer).toMatch(/rechazado/);
    const questions = asked(h.sent);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ payload: { kind: "confirm", message: "Excluir a conta?", key: "confirm:Excluir a conta?" } });
  });

  it("confirm_permitido_pela_pessoa_vale_uma_vez", async () => {
    const h = await loadRuntime("<p>x</p>");
    await h.run({ op: "dialogs", allow: "confirm:Excluir a conta?" });
    await h.run({ op: "eval", code: "window.__primeiro = confirm('Excluir a conta?')" });
    await h.run({ op: "eval", code: "window.__segundo = confirm('Excluir a conta?')" });
    const log = await h.run({ op: "dialogs" }) as DialogLog;
    const answers = log.seen.filter((d) => d.message === "Excluir a conta?").map((d) => d.answer);
    expect(answers).toHaveLength(2);
    expect(answers[0]).toMatch(/aceptado por la persona/);
    expect(answers[1]).toMatch(/rechazado/);
  });

  it("driving_segue_ligado_enquanto_outra_orden_roda", async () => {
    const h = await loadRuntime("<p>x</p>");
    // Uma orden do agente fica esperando uma promessa; a página dispara um `confirm` depois que OUTRA orden já terminou.
    const pending = h.run({
      op: "eval",
      code: "window.__disparar = () => confirm('Apagar tudo?'); return new Promise((r) => { window.__soltar = r; });",
    });
    await h.run({ op: "dialogs" });
    (window as unknown as { __disparar: () => boolean }).__disparar();
    const log = await h.run({ op: "dialogs" }) as DialogLog;
    expect(log.seen.find((d) => d.message === "Apagar tudo?")?.answer).toMatch(/rechazado/);
    (window as unknown as { __soltar: (v: unknown) => void }).__soltar(null);
    await pending;
  });
});

describe("runtime: cookies com atributos injetados", () => {
  it("cookies_set_recusa_path_com_atributo", async () => {
    const h = await loadRuntime("<p>x</p>");
    // Um `path` com `;` acrescentaria atributos ao cookie (`domain=…`): recusa-se antes de gravar.
    await expect(h.run({ op: "cookies", action: "set", name: "sessao", value: "1", path: "/;domain=evil.com" })).rejects.toThrow();
    expect(document.cookie).not.toContain("sessao=1");
  });
});
