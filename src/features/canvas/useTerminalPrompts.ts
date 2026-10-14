import { useEffect, useState } from "react";

import { screenOf, sendKeysToTab } from "@/features/terminal/terminalRegistry";

import { detectPermissionPrompt, type PermissionChoice } from "./terminalPrompts";
import type { TerminalPromptItem } from "./teamFeedModel";

const POLL_MS = 1500;

/**
 * Os pedidos de permissão que os TUIs dos agentes estão mostrando agora (Codex, Claude Code, Gemini):
 * um por terminal. Lê a tela de cada um a cada poucos segundos. O pedido some quando o menu some
 * da tela (foi respondido, aqui ou no próprio terminal). Só olha enquanto `enabled`.
 */
export function useTerminalPrompts(tabs: { id: string; name: string }[], enabled: boolean): TerminalPromptItem[] {
  const [items, setItems] = useState<TerminalPromptItem[]>([]);
  const ids = tabs.map((t) => `${t.id}:${t.name}`).join("|");

  useEffect(() => {
    if (!enabled) { setItems([]); return; }
    let alive = true;
    const scan = () => {
      setItems((prev) => {
        const next: TerminalPromptItem[] = [];
        for (const tab of tabs) {
          const prompt = detectPermissionPrompt(screenOf(tab.id, null, 40)?.lines);
          if (!prompt) continue;
          const before = prev.find((p) => p.tabId === tab.id && p.prompt.signature === prompt.signature);
          next.push(before ? { ...before, who: tab.name } : { tabId: tab.id, who: tab.name, prompt, atMs: Date.now() });
        }
        const same = next.length === prev.length && next.every((n, i) => prev[i]?.tabId === n.tabId && prev[i]?.prompt.signature === n.prompt.signature && prev[i]?.who === n.who);
        return same ? prev : next;
      });
    };
    scan();
    const timer = window.setInterval(() => { if (alive) scan(); }, POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
    // `ids` resume a lista de terminais; `tabs` muda de identidade a cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ids]);

  return items;
}

/**
 * Responde ao menu do TUI: manda a tecla da opção. Formulários que pedem "enter to submit" (aprovação de
 * ferramenta MCP no Codex) recebem também o Enter, um instante depois. `false` se o terminal não está aberto.
 */
export function answerTerminalPrompt(tabId: string, choice: PermissionChoice): boolean {
  const needsEnter = choice.id !== "deny"
    && (screenOf(tabId, null, 30)?.lines ?? []).slice(-8).some((line) => /enter to submit/i.test(line));
  if (!sendKeysToTab(tabId, choice.keys)) return false;
  if (needsEnter) window.setTimeout(() => sendKeysToTab(tabId, "\r"), 200);
  return true;
}
