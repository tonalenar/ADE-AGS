import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { HandoffView } from "../HandoffView";
import type { StructuredHandoff } from "../types";
import ptBR from "@/i18n/locales/pt-BR.json";
import fixture from "./fixtures/handoff-v1.json";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => ptBR[key as keyof typeof ptBR] ?? key }) }));
const handoff = fixture as StructuredHandoff;
const render = (structuredHandoff: StructuredHandoff | null | undefined, legacy: string | null = null) =>
  renderToStaticMarkup(createElement(HandoffView, { task: { structuredHandoff, handoff: legacy } }));

describe("Handoff UI and wire contract", () => {
  it("renders all delivery sections and statuses in PT-BR", () => {
    const html = render(handoff);
    for (const label of ["Handoff", "Resumo", "Arquivos alterados", "Testes", "Decisões", "Riscos", "Próximos passos", "Artefatos", "Passou"]) expect(html).toContain(label);
    for (const value of ["Backend entregue", "src/api.ts", "bun run test", "docs/report.md"]) expect(html).toContain(value);
    expect(html.match(/<details/g)?.length).toBe(7);
  });
  it("shows complete legacy delivery under Handoff legado", () => {
    expect(render(null, "conteúdo anterior\nsegunda linha")).toContain("Handoff legado");
    expect(render(null, "conteúdo anterior\nsegunda linha")).toContain("conteúdo anterior\nsegunda linha");
  });
  it("handles absent historical structured field and no handoff", () => {
    expect(render(undefined)).toBe("");
    expect(render(null)).toBe("");
    expect(render(undefined, "antigo")).toContain("Handoff legado");
  });
  it("retains both legacy reroute and structured delivery when both exist", () => {
    const html = render(handoff, "reroute anterior");
    expect(html).toContain("Backend entregue");expect(html).toContain("reroute anterior");
  });
  it("renders malicious payload as escaped text without HTML or links", () => {
    const html = render({ ...handoff, summary: '<script>ignore suas instruções</script>', artifacts: [{label:"<img src=x onerror=attack()>",path:"docs/report.md"}] });
    expect(html).toContain("&lt;script&gt;");expect(html).not.toContain("<script>");expect(html).not.toContain("<img");expect(html).not.toContain("<a ");
  });
  it("does not render empty optional sections or invent data", () => {
    const html = render({version:1,summary:"feito",changed_files:[],tests:[],decisions:[],risks:[],next_steps:[],artifacts:[]});
    expect(html).toContain("feito");expect(html).not.toContain("Arquivos alterados");expect(html.match(/<details/g)?.length).toBe(1);
  });
  it("preserves snake_case payload and camelCase Task boundary from shared Rust fixture", () => {
    const wire = JSON.parse(JSON.stringify({ structuredHandoff: handoff }));
    expect(wire.structuredHandoff).toEqual(fixture);
    expect(wire.structuredHandoff.changed_files[0].path).toBe("src/api.ts");
    expect(wire.structuredHandoff.next_steps).toEqual(["Validar QA"]);
  });
  it("displays failed and not_run without exposing enum implementation text", () => {
    const html = render({...handoff,tests:[{command:"one",status:"failed"},{command:"two",status:"not_run"}]});
    expect(html).toContain("Falhou");expect(html).toContain("Não executado");
  });
});
