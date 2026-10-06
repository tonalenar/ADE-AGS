import { describe, expect, it } from "vitest";

import { buildTasks } from "../buildTasks";
import { allApproved, buildable, formatQueueForAgent, pendingComments } from "../commentQueue";
import { type Artboard, type ArtboardStatus, type Design, normalizeDesign, type RawDesign } from "../designApi";
import { BOARD_GAP, spreadOverlapping } from "../layout";
import { defaultDesignId, resolveOwner } from "../owner";
import { buildSrcdoc, CHOOSER_SCRIPT, DESIGN_CSP, DESIGN_SANDBOX, parsePick, PICK_MESSAGE, PICKER_SCRIPT } from "../srcdoc";
import { fitViewport, INITIAL_VIEWPORT, zoomPercent } from "../viewport";

describe("Design Canvas Integration & Regression Suite (Etapa 19 QA)", () => {
  describe("1. Auditoria com dados reais do SQLite (data.db): Sobreposição e Layout", () => {
    // 5 pranchetas reais extraídas de ~/.ags/data.db na página 'Bot'
    const realStackedArtboards: Array<{ id: string; title: string; width: number; height: number; x: number; y: number; status: ArtboardStatus; version: number }> = [
      { id: "6b0ff77c-a86d-41a7-b86d-89c4ad13199f", title: "Aura - 3 propostas", width: 720, height: 560, x: 0, y: 0, status: "approved", version: 1 },
      { id: "409f4758-2a15-422b-919a-d3df53daa0ac", title: "Estados do bot", width: 720, height: 560, x: 0, y: 0, status: "approved", version: 1 },
      { id: "7fa1043a-578b-4125-96be-3f5c35a83b61", title: "Tamanhos", width: 720, height: 560, x: 0, y: 0, status: "approved", version: 1 },
      { id: "672db756-60a7-48fe-b68c-0e52ca396e8f", title: "Pixel-art detalhada", width: 720, height: 560, x: 0, y: 0, status: "rejected", version: 1 },
      { id: "d0829daa-7c8a-4e05-9dee-1849c073480a", title: "Microinteracoes", width: 720, height: 560, x: 0, y: 0, status: "approved", version: 1 },
    ];

    it("espalha horizontalmente as 5 pranchetas empilhadas em (0,0) com BOARD_GAP", () => {
      const placed = spreadOverlapping(realStackedArtboards);
      expect(placed).toHaveLength(5);

      // Cada prancheta deve ter x calculado incrementalmente: largura + GAP
      let expectedX = 0;
      for (let i = 0; i < placed.length; i++) {
        expect(placed[i].x).toBe(expectedX);
        expect(placed[i].y).toBe(0);
        expectedX += placed[i].width + BOARD_GAP;
      }

      // Última prancheta deve terminar em (720 + 48) * 4 = 3072
      expect(placed[4].x).toBe(3072);
    });

    it("preserva posições de pranchetas já organizadas manualmente sem sobreposição", () => {
      const manualBoards = [
        { id: "b1", title: "Painel 1", width: 500, height: 400, x: 100, y: 50 },
        { id: "b2", title: "Painel 2", width: 600, height: 400, x: 700, y: 50 },
        { id: "b3", title: "Painel 3", width: 400, height: 300, x: 1400, y: 120 },
      ];

      const placed = spreadOverlapping(manualBoards);
      expect(placed).toEqual(manualBoards);
    });

    it("acomoda tamanhos variados sem colisões (cenário real das 9 pranchetas)", () => {
      const variedBoards = [
        { id: "v1", width: 720, height: 560, x: 0, y: 0 },
        { id: "v2", width: 760, height: 640, x: 0, y: 0 },
        { id: "v3", width: 1000, height: 640, x: 0, y: 0 },
        { id: "v4", width: 900, height: 1080, x: 0, y: 0 },
      ];

      const placed = spreadOverlapping(variedBoards);
      expect(placed[0].x).toBe(0);
      expect(placed[1].x).toBe(720 + BOARD_GAP);
      expect(placed[2].x).toBe(720 + BOARD_GAP + 760 + BOARD_GAP);
      expect(placed[3].x).toBe(720 + BOARD_GAP + 760 + BOARD_GAP + 1000 + BOARD_GAP);
    });
  });

  describe("2. Auditoria de dados reais: Resolução de Dono e Designs Duplicados", () => {
    const missionId = "6dac3bc5-15ef-4b7d-824a-07c128e3b9cb";
    const deadOwnerTabId = "ecf90d5a-bbee-47af-97b1-b81bae1d19b5";

    const duplicateDesigns: Design[] = [
      {
        id: "be6ce1fb-b8e9-47e9-a2f0-78438e01fa1c",
        title: "Polir o bot - aura e acabamento",
        workspace: "C:\\Users\\tonz1n\\.ags\\worktrees\\8c1e293f",
        missionId,
        ownerTabId: null,
        status: "approved",
      },
      {
        id: "8fa79850-678c-493f-a8f1-915f4022ce95",
        title: "Polir o bot - aura e acabamento",
        workspace: "C:\\Users\\tonz1n\\.ags\\worktrees\\8c1e293f",
        missionId,
        ownerTabId: deadOwnerTabId,
        status: "draft",
      },
    ];

    it("resolve ownerTabId diretamente quando a aba criadora ainda existe", () => {
      const openTabs = [
        { id: deadOwnerTabId, title: "Designer Bot" },
        { id: "tab-lead", title: "Orquestrador" },
      ];
      const missionMap = { [deadOwnerTabId]: missionId, "tab-lead": missionId };

      const owner = resolveOwner(duplicateDesigns[1], openTabs, missionMap);
      expect(owner).toBe(deadOwnerTabId);
    });

    it("faz fallback para a orquestradora da missão quando a aba dona foi fechada (órfã)", () => {
      const openTabs = [
        { id: "tab-backend", title: "Backend" },
        { id: "tab-lead", title: "Orquestrador da Missão" },
      ];
      const missionMap = { "tab-backend": missionId, "tab-lead": missionId };

      const owner = resolveOwner(duplicateDesigns[1], openTabs, missionMap);
      expect(owner).toBe("tab-lead");
    });

    it("retorna null graciosamente quando a missão inteira já encerrou e não há abas ativas", () => {
      const openTabs = [
        { id: "other-tab", title: "Outra Missão" },
      ];
      const missionMap = { "other-tab": "different-mission" };

      const owner = resolveOwner(duplicateDesigns[1], openTabs, missionMap);
      expect(owner).toBeNull();
    });

    it("defaultDesignId seleciona o design mais recente que possui dono entregável", () => {
      const openTabs = [
        { id: "lead-tab", title: "Orquestrador" },
      ];
      const missionMap = { "lead-tab": missionId };

      const selectedId = defaultDesignId(duplicateDesigns, openTabs, missionMap);
      expect(selectedId).toBe("8fa79850-678c-493f-a8f1-915f4022ce95");
    });
  });

  describe("3. Revisão de Comentários por Elemento e Propostas", () => {
    it("parsePick valida e sanitiza payload vindo de postMessage do iframe", () => {
      const validPick = {
        type: PICK_MESSAGE,
        selector: "div#root > div:nth-of-type(2)",
        text: "B · Anel de energia girando",
      };
      const parsed = parsePick(validPick);
      expect(parsed).toEqual({
        selector: "div#root > div:nth-of-type(2)",
        text: "B · Anel de energia girando",
      });
    });

    it("parsePick rejeita mensagens espúrias ou seletores excessivamente longos", () => {
      expect(parsePick(null)).toBeNull();
      expect(parsePick({})).toBeNull();
      expect(parsePick({ type: "other-event", selector: "div" })).toBeNull();
      expect(parsePick({ type: PICK_MESSAGE, selector: "" })).toBeNull();
      expect(parsePick({ type: PICK_MESSAGE, selector: "x".repeat(501) })).toBeNull();
    });

    it("formata a fila de comentários para entrega ao agente incluindo seletores", () => {
      const artboards: Artboard[] = [
        { id: "b1", pageId: "p1", title: "Aura", html: "<div id='aura'></div>", width: 720, height: 560, x: 0, y: 0, version: 1, status: "approved" },
      ];
      const comments = [
        { id: "c1", artboardId: "b1", author: "user" as const, text: "Trocar para cor dourada", selector: "#aura", resolved: false, createdAt: 0 },
      ];

      const queue = pendingComments(comments);
      expect(queue).toHaveLength(1);

      const message = formatQueueForAgent("Polir o bot", artboards, queue);
      expect(message).toContain("Polir o bot");
      expect(message).toContain("Aura");
      expect(message).toContain("Trocar para cor dourada");
      expect(message).toContain("[#aura]");
    });

    it("ignora comentários já resolvidos na fila de envio", () => {
      const comments = [
        { id: "c1", artboardId: "b1", author: "user" as const, text: "Resolvido", selector: null, resolved: true, createdAt: 0 },
        { id: "c2", artboardId: "b1", author: "user" as const, text: "Pendente", selector: null, resolved: false, createdAt: 1 },
      ];
      expect(pendingComments(comments)).toHaveLength(1);
      expect(pendingComments(comments)[0].id).toBe("c2");
    });
  });

  describe("4. Segurança de Sandbox, CSP e Injeção de Scripts", () => {
    it("buildSrcdoc embute Content-Security-Policy restritiva e corta rede", () => {
      const srcdoc = buildSrcdoc("<h1>Teste</h1>");
      expect(srcdoc).toContain(`content="${DESIGN_CSP}"`);
      expect(srcdoc).toContain("default-src 'none'");
      expect(DESIGN_SANDBOX).toBe("allow-scripts");
    });

    it("remove tags hostis <meta http-equiv> e <base> para impedir relaxamento de CSP", () => {
      const hostileHtml = `<meta http-equiv="refresh" content="0;url=http://evil.com"><base href="https://evil.com/"/><div>Conteúdo</div>`;
      const cleanSrcdoc = buildSrcdoc(hostileHtml);
      expect(cleanSrcdoc).not.toContain("http-equiv=\"refresh\"");
      expect(cleanSrcdoc).not.toContain("<base");
      expect(cleanSrcdoc).toContain("<div>Conteúdo</div>");
    });

    it("injeta PICKER_SCRIPT apenas quando picker é solicitado", () => {
      const withoutPicker = buildSrcdoc("<p>Sem picker</p>");
      expect(withoutPicker).not.toContain(PICKER_SCRIPT);

      const withPicker = buildSrcdoc("<p>Com picker</p>", { picker: true });
      expect(withPicker).toContain(PICKER_SCRIPT);
    });

    it("injeta CHOOSER_SCRIPT apenas quando chooser é solicitado", () => {
      const withChooser = buildSrcdoc("<p>Com chooser</p>", { chooser: true });
      expect(withChooser).toContain(CHOOSER_SCRIPT);
      expect(withChooser).not.toContain(PICKER_SCRIPT);
    });
  });

  describe("5. Tarefas de Construção e Aprovação Estrita", () => {
    it("apenas pranchetas aprovadas geram tarefas de construção", () => {
      const designDetail = {
        id: "d1",
        title: "Bot Acabamento",
        workspace: "C:\\project",
        missionId: "m1",
        ownerTabId: "tab-1",
        status: "draft" as const,
        pages: [
          {
            id: "p1",
            name: "Página Principal",
            order: 0,
            artboards: [
              { id: "b-app", pageId: "p1", title: "Aprovada", html: "<div>Ok</div>", width: 720, height: 560, x: 0, y: 0, version: 1, status: "approved" as const },
              { id: "b-draft", pageId: "p1", title: "Rascunho", html: "<div>Draft</div>", width: 720, height: 560, x: 0, y: 0, version: 1, status: "draft" as const },
              { id: "b-rej", pageId: "p1", title: "Rejeitada", html: "<div>Bad</div>", width: 720, height: 560, x: 0, y: 0, version: 1, status: "rejected" as const },
            ],
          },
        ],
      };

      const tasks = buildTasks(designDetail);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].artboardId).toBe("b-app");
      expect(tasks[0].prompt).toContain("Aprovada");
      expect(tasks[0].prompt).toContain("Trabalhe exclusivamente no seu próprio worktree isolado");
    });

    it("allApproved requer aprovação de 100% das pranchetas", () => {
      const mixed: Artboard[] = [
        { id: "1", pageId: "p", title: "1", html: "", width: 100, height: 100, x: 0, y: 0, version: 1, status: "approved" },
        { id: "2", pageId: "p", title: "2", html: "", width: 100, height: 100, x: 0, y: 0, version: 1, status: "draft" },
      ];
      expect(allApproved(mixed)).toBe(false);

      const allOk: Artboard[] = [
        { id: "1", pageId: "p", title: "1", html: "", width: 100, height: 100, x: 0, y: 0, version: 1, status: "approved" },
        { id: "2", pageId: "p", title: "2", html: "", width: 100, height: 100, x: 0, y: 0, version: 1, status: "approved" },
      ];
      expect(allApproved(allOk)).toBe(true);
    });

    it("buildable filtra somente artboards aprovados", () => {
      const artboards: Artboard[] = [
        { id: "1", pageId: "p", title: "1", html: "", width: 100, height: 100, x: 0, y: 0, version: 1, status: "approved" },
        { id: "2", pageId: "p", title: "2", html: "", width: 100, height: 100, x: 0, y: 0, version: 1, status: "rejected" },
        { id: "3", pageId: "p", title: "3", html: "", width: 100, height: 100, x: 0, y: 0, version: 1, status: "draft" },
      ];
      const valid = buildable(artboards);
      expect(valid).toHaveLength(1);
      expect(valid[0].id).toBe("1");
    });
  });

  describe("6. Normalização de Dados e Viewport do Canvas", () => {
    it("normalizeDesign achata estrutura aninhada do backend e preserva versões e comentários", () => {
      const raw: RawDesign = {
        id: "d1",
        title: "Design Teste",
        workspace: "ws",
        missionId: "m1",
        ownerTabId: "t1",
        status: "draft",
        pages: [
          {
            id: "p1",
            designId: "d1",
            name: "Page 1",
            order: 0,
            artboards: [
              {
                id: "b1",
                pageId: "p1",
                title: "Board 1",
                html: "<h1>Hi</h1>",
                width: 720,
                height: 560,
                x: 0,
                y: 0,
                version: 2,
                status: "approved",
                versions: [
                  { version: 1, html: "<p>v1</p>", title: "Board 1" },
                  { version: 2, html: "<p>v2</p>", title: "Board 1" },
                ],
                comments: [
                  { id: "c1", artboardId: "b1", author: "user", text: "Fix this", selector: "h1", resolved: false },
                ],
              },
            ],
          },
        ],
      };

      const detail = normalizeDesign(raw);
      expect(detail.pages).toHaveLength(1);
      expect(detail.artboards).toHaveLength(1);
      expect(detail.comments).toHaveLength(1);
      expect(detail.versions["b1"]).toHaveLength(2);
    });

    it("fitViewport calcula zoom e posicionamento centralizado com margem de segurança", () => {
      const boxes = [
        { x: 0, y: 0, w: 720, h: 560 },
        { x: 768, y: 0, w: 720, h: 560 },
      ];
      const vp = fitViewport(boxes, 1920, 1080);
      expect(vp.zoom).toBeGreaterThan(0);
      expect(vp.zoom).toBeLessThanOrEqual(2);
      expect(zoomPercent(vp)).toMatch(/^\d+%$/);
    });

    it("zoomPercent exibe valor arredondado legível", () => {
      expect(zoomPercent({ ...INITIAL_VIEWPORT, zoom: 1 })).toBe("100%");
      expect(zoomPercent({ ...INITIAL_VIEWPORT, zoom: 0.75 })).toBe("75%");
      expect(zoomPercent({ ...INITIAL_VIEWPORT, zoom: 1.5 })).toBe("150%");
    });
  });

  describe("7. Casos Limítrofes de Layout e Robustez de Segurança", () => {
    it("spreadOverlapping lida com listas vazias ou de prancheta única sem mutação", () => {
      expect(spreadOverlapping([])).toEqual([]);
      const single = [{ id: "s1", width: 800, height: 600, x: 10, y: 20 }];
      expect(spreadOverlapping(single)).toEqual(single);
    });

    it("spreadOverlapping detecta sobreposição quando coordenadas são negativas ou parciais", () => {
      const partiallyOverlapping = [
        { id: "a", width: 100, height: 100, x: 0, y: 0 },
        { id: "b", width: 100, height: 100, x: 50, y: 50 }, // sobrepõe
      ];
      const result = spreadOverlapping(partiallyOverlapping);
      expect(result[0].x).toBe(0);
      expect(result[1].x).toBe(100 + BOARD_GAP);
    });

    it("resolveOwner identifica variações de case e termos de orquestrador no título da aba", () => {
      const tabs = [
        { id: "lead-1", title: "Project LEAD" },
        { id: "lead-2", title: "Tech ORCHESTRATOR" },
      ];
      const missionMap = { "lead-1": "m1", "lead-2": "m1" };

      const resolved = resolveOwner({ ownerTabId: null, missionId: "m1" }, tabs, missionMap);
      expect(resolved).toBe("lead-1");
    });

    it("normalizeDesign ordena páginas por sort_order / order crescente", () => {
      const raw: RawDesign = {
        id: "d1",
        title: "Multi-page",
        workspace: "ws",
        missionId: null,
        ownerTabId: null,
        status: "draft",
        pages: [
          { id: "p2", designId: "d1", name: "Página 2", order: 2, artboards: [] },
          { id: "p0", designId: "d1", name: "Página 0", order: 0, artboards: [] },
          { id: "p1", designId: "d1", name: "Página 1", order: 1, artboards: [] },
        ],
      };
      const normalized = normalizeDesign(raw);
      expect(normalized.pages.map((p) => p.id)).toEqual(["p0", "p1", "p2"]);
    });

    it("buildSrcdoc preserva HTML inócuo enquanto bloqueia tags perigosas em maiúsculas", () => {
      const upperCaseHostile = `<META HTTP-EQUIV="Refresh" content="0"><BASE href="http://evil.com"><p>Texto legítimo</p>`;
      const clean = buildSrcdoc(upperCaseHostile);
      expect(clean.toLowerCase()).not.toContain("http-equiv=\"refresh\"");
      expect(clean.toLowerCase()).not.toContain("<base");
      expect(clean).toContain("<p>Texto legítimo</p>");
    });
  });
});

