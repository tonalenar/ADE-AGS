// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coversOf, hitCoversOf } from "../nativeSurface";

let host: HTMLDivElement;

const rectOf = (x: number, y: number, width: number, height: number): DOMRect =>
  ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
  vi.restoreAllMocks();
});

describe("cobertura de overlays sobre superfície nativa", () => {
  it("detecta_dialog_open_alertdialog_popover_e_data_native_overlay_ignorando_ocultos", () => {
    const surface = document.createElement("div");
    host.appendChild(surface);

    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    dialog.getBoundingClientRect = () => rectOf(0, 0, 1000, 700);

    const alert = document.createElement("div");
    alert.setAttribute("role", "alertdialog");
    alert.getBoundingClientRect = () => rectOf(100, 100, 300, 200);

    const pop = document.createElement("div");
    pop.setAttribute("popover", "auto");
    pop.getBoundingClientRect = () => rectOf(200, 50, 180, 120);

    const custom = document.createElement("div");
    custom.setAttribute("data-native-overlay", "");
    custom.getBoundingClientRect = () => rectOf(50, 50, 120, 80);

    const hiddenDialog = document.createElement("div");
    hiddenDialog.setAttribute("role", "dialog");
    hiddenDialog.style.display = "none";
    hiddenDialog.getBoundingClientRect = () => rectOf(10, 10, 400, 400);

    const invisibleTooltip = document.createElement("div");
    invisibleTooltip.setAttribute("role", "tooltip");
    invisibleTooltip.style.visibility = "hidden";
    invisibleTooltip.getBoundingClientRect = () => rectOf(20, 20, 200, 40);

    const overlays = [dialog, alert, pop, custom, hiddenDialog, invisibleTooltip];
    for (const overlay of overlays) document.body.appendChild(overlay);
    try {
      vi.spyOn(document, "elementFromPoint").mockReturnValue(null);

      const covers = coversOf(surface, { x: 0, y: 0, width: 1000, height: 700 });
      expect(covers).toEqual([
        { x: 0, y: 0, width: 1000, height: 700 },
        { x: 100, y: 100, width: 300, height: 200 },
        { x: 200, y: 50, width: 180, height: 120 },
        { x: 50, y: 50, width: 120, height: 80 },
      ]);
    } finally {
      for (const overlay of overlays) overlay.remove();
    }
  });

  it("nao_escala_menu_da_barra_do_chat_para_o_chat_shell_inteiro", () => {
    // Simula a árvore real do AppShell: EditorArea e [data-chat-shell] são irmãos dentro do mesmo container.
    const shellParent = document.createElement("div");
    const editorWrap = document.createElement("div");
    const surface = document.createElement("div");
    editorWrap.appendChild(surface);

    const chatShell = document.createElement("div");
    chatShell.setAttribute("data-chat-shell", "");
    chatShell.getBoundingClientRect = () => rectOf(0, 0, 1200, 800);

    const aside = document.createElement("aside");
    aside.getBoundingClientRect = () => rectOf(700, 0, 500, 800);

    const tabbar = document.createElement("div");
    tabbar.setAttribute("data-column-tabbar", "");
    tabbar.getBoundingClientRect = () => rectOf(700, 0, 500, 44);

    const menuWrap = document.createElement("div");
    menuWrap.setAttribute("data-over-webview", "");
    menuWrap.getBoundingClientRect = () => rectOf(930, 48, 260, 320);

    const menuList = document.createElement("ul");
    menuList.setAttribute("role", "menu");
    menuList.getBoundingClientRect = () => rectOf(934, 52, 252, 312);

    const menuItem = document.createElement("button");
    menuItem.setAttribute("role", "menuitem");
    menuItem.getBoundingClientRect = () => rectOf(934, 52, 252, 32);

    menuList.appendChild(menuItem);
    menuWrap.appendChild(menuList);
    tabbar.appendChild(menuWrap);
    aside.appendChild(tabbar);
    chatShell.appendChild(aside);
    shellParent.appendChild(editorWrap);
    shellParent.appendChild(chatShell);
    host.appendChild(shellParent);

    vi.spyOn(document, "elementFromPoint").mockImplementation((x, y) => {
      if (x >= 930 && x <= 1190 && y >= 48 && y <= 368) return menuItem;
      return aside;
    });

    const covers = coversOf(surface, { x: 700, y: 44, width: 500, height: 756 });
    expect(covers).not.toContainEqual({ x: 0, y: 0, width: 1200, height: 800 });
    expect(covers).not.toContainEqual({ x: 700, y: 0, width: 500, height: 800 });
    expect(covers).toContainEqual({ x: 930, y: 48, width: 260, height: 320 });
  });

  it("nao_escala_popover_sem_aria_dentro_do_chat_shell_quando_tem_z_index", () => {
    const shellParent = document.createElement("div");
    const editorWrap = document.createElement("div");
    const surface = document.createElement("div");
    editorWrap.appendChild(surface);

    const chatShell = document.createElement("div");
    chatShell.setAttribute("data-chat-shell", "");
    chatShell.getBoundingClientRect = () => rectOf(0, 0, 1200, 800);

    const aside = document.createElement("aside");
    aside.getBoundingClientRect = () => rectOf(700, 0, 500, 800);

    const popover = document.createElement("div");
    popover.style.position = "absolute";
    popover.style.zIndex = "50";
    popover.getBoundingClientRect = () => rectOf(800, 120, 240, 180);

    const child = document.createElement("span");
    child.getBoundingClientRect = () => rectOf(810, 130, 100, 20);
    popover.appendChild(child);
    aside.appendChild(popover);
    chatShell.appendChild(aside);
    shellParent.appendChild(editorWrap);
    shellParent.appendChild(chatShell);
    host.appendChild(shellParent);

    vi.spyOn(document, "elementFromPoint").mockImplementation((x, y) => {
      if (x >= 800 && x <= 1040 && y >= 120 && y <= 300) return child;
      return aside;
    });

    const covers = coversOf(surface, { x: 700, y: 44, width: 500, height: 756 });
    expect(covers).toEqual([{ x: 800, y: 120, width: 240, height: 180 }]);
  });

  it("separa_data_over_webview_hit_de_cobertura_visual_inclusive_na_grade", () => {
    const surface = document.createElement("div");
    const grip = document.createElement("div");
    grip.setAttribute("data-over-webview", "hit");
    grip.getBoundingClientRect = () => rectOf(290, 10, 100, 36);
    const gripButton = document.createElement("button");
    gripButton.getBoundingClientRect = () => rectOf(300, 14, 28, 28);
    grip.appendChild(gripButton);

    host.appendChild(surface);
    host.appendChild(grip);

    vi.spyOn(document, "elementFromPoint").mockImplementation((x, y) => {
      if (x >= 290 && x <= 390 && y >= 10 && y <= 46) return gripButton;
      return surface;
    });

    const rect = { x: 0, y: 0, width: 400, height: 300 };
    expect(coversOf(surface, rect)).toEqual([]);
    expect(hitCoversOf(surface)).toEqual([{ x: 290, y: 10, width: 100, height: 36 }]);
  });

  it("ignora_overlays_com_opacity_zero_ou_ancestral_transparente", () => {
    const surface = document.createElement("div");
    host.appendChild(surface);

    const fadeTooltip = document.createElement("div");
    fadeTooltip.setAttribute("role", "tooltip");
    fadeTooltip.style.opacity = "0";
    fadeTooltip.getBoundingClientRect = () => rectOf(20, 20, 200, 40);

    const fadedParent = document.createElement("div");
    fadedParent.style.opacity = "0";
    const childDialog = document.createElement("div");
    childDialog.setAttribute("role", "dialog");
    childDialog.getBoundingClientRect = () => rectOf(0, 0, 400, 300);
    fadedParent.appendChild(childDialog);

    document.body.append(fadeTooltip, fadedParent);
    try {
      vi.spyOn(document, "elementFromPoint").mockReturnValue(null);
      expect(coversOf(surface, { x: 0, y: 0, width: 400, height: 300 })).toEqual([]);
    } finally {
      fadeTooltip.remove();
      fadedParent.remove();
    }
  });

  it("ignora_overlay_com_z_index_inferior_a_superficie_nativa", () => {
    const pipWrap = document.createElement("div");
    pipWrap.style.position = "absolute";
    pipWrap.style.zIndex = "35";
    const surface = document.createElement("div");
    pipWrap.appendChild(surface);

    const behindOverlay = document.createElement("div");
    behindOverlay.setAttribute("role", "dialog");
    behindOverlay.style.position = "fixed";
    behindOverlay.style.zIndex = "10";
    behindOverlay.getBoundingClientRect = () => rectOf(0, 0, 400, 300);

    const frontOverlay = document.createElement("div");
    frontOverlay.setAttribute("role", "dialog");
    frontOverlay.style.position = "fixed";
    frontOverlay.style.zIndex = "50";
    frontOverlay.getBoundingClientRect = () => rectOf(50, 50, 120, 80);

    host.append(pipWrap, behindOverlay, frontOverlay);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(null);

    const covers = coversOf(surface, { x: 0, y: 0, width: 400, height: 300 });
    expect(covers).toEqual([{ x: 50, y: 50, width: 120, height: 80 }]);
  });
});
