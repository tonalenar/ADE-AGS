import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf-8");

/** Os caminhos que o router registra (`path: "settings"` → `/settings`). */
function registeredRoots(): Set<string> {
  const source = read("../../../app/router.tsx");
  return new Set([...source.matchAll(/path:\s*"([^"]+)"/g)].map((m) => `/${m[1]!.split("/")[0]}`).filter((p) => p !== "//"));
}

describe("a barra só navega para rotas que existem", () => {
  // "Artefatos" chamava `navigate("/design")`, mas só existe `design/:id`: a rota não casava e o
  // React Router derrubava o app com "404 Not Found".
  const files = ["../ChatSidebar.tsx", "../sidebar/AppSessionsSidebar.tsx"];
  const roots = registeredRoots();

  it("o router tem as rotas de que a barra precisa", () => {
    for (const route of ["/settings", "/forge", "/missions", "/fleet", "/squads", "/skills", "/marketplace", "/workspace"]) expect(roots.has(route)).toBe(true);
  });

  for (const file of files) {
    it(`todo navigate("/…") de ${file.split("/").pop()} cai numa rota registrada`, () => {
      const targets = [...read(file).matchAll(/navigate\("(\/[^"]*)"\)/g)].map((m) => m[1]!);
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        const root = target === "/" ? "/" : `/${target.split("/")[1]}`;
        expect(root === "/" || roots.has(root), `${target} não está no router`).toBe(true);
      }
    });
  }

  it("não resta nenhum navigate('/design') solto (a rota pede um id)", () => {
    for (const file of files) expect(read(file)).not.toMatch(/navigate\("\/design"\)/);
  });

  it("o router tem a rota curinga: um caminho desconhecido mostra 'Não encontrado' dentro da casca", () => {
    expect(read("../../../app/router.tsx")).toMatch(/path: "\*", element: <NotFound \/>/);
  });

  it('Criar, Projetos e o "+" do projeto usam o mesmo composer sem navegar para a Home', () => {
    const sidebar = read("../sidebar/AppSessionsSidebar.tsx");
    expect(sidebar).toContain("newConversationLocal();");
    expect(sidebar).toContain("onNewIn={newConversationIn}");
    expect(sidebar).toContain("pickProjectFolder");
    expect(sidebar).not.toMatch(/navigate\("\/"\)/);
  });
});
