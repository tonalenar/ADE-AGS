/** O fundo do ícone de cada agente (estilo app do iOS). */
export function agentTile(id: string): string {
  if (id.startsWith("claude")) return "linear-gradient(180deg,#e08a6c,#c96442)";
  if (id.startsWith("codex")) return "linear-gradient(180deg,#3a3a3c,#1c1c1e)";
  if (id.startsWith("antigravity") || id.startsWith("gemini")) return "linear-gradient(135deg,#4285f4,#9b72cb)";
  if (id.startsWith("opencode")) return "linear-gradient(180deg,#5e5ce6,#3634a3)";
  if (id.startsWith("kimi")) return "linear-gradient(180deg,#30b0c7,#0a7d93)";
  if (id.startsWith("hermes")) return "linear-gradient(180deg,#e9b949,#b7791f)";
  return "linear-gradient(180deg,#636366,#48484a)";
}

/**
 * O fundo ATRÁS do logo do agente. Os logos vão nas cores originais (`brandColorIcons.tsx`), e o caranguejo laranja do Claude
 * sumiria num ladrilho laranja: o fundo é neutro, como ícone de app. A cor do agente (`agentTile`) continua nos pontos de
 * identidade do canvas, do chat e das missões.
 */
export function agentIconTile(_id: string): string {
  return "linear-gradient(180deg,#3a3a3e,#202023)";
}

/**
 * A cor SÓLIDA do agente (o `agentTile` é um gradiente e não serve de borda). Clara o bastante para
 * aparecer no fundo escuro: o tile do Codex é quase preto, aqui vira um cinza claro.
 */
export function agentAccent(id: string): string {
  if (id.startsWith("claude")) return "#d97757";
  if (id.startsWith("codex")) return "#a1a1a8";
  if (id.startsWith("antigravity") || id.startsWith("gemini")) return "#5b8def";
  if (id.startsWith("opencode")) return "#7a78f0";
  if (id.startsWith("kimi")) return "#30b0c7";
  if (id.startsWith("hermes")) return "#e3b341";
  return "#8e8e93";
}

/**
 * A moldura de um nó de terminal: uma borda de 2 px na cor do agente (2,5 px e um halo suave quando
 * selecionado) mais a sombra. O orquestrador ganha um brilho por fora. Pura.
 */
export function nodeFrame(accent: string, selected: boolean, orchestrator: boolean): string {
  const lift = selected ? "0 14px 36px rgba(0,0,0,0.5), 0 2px 6px rgba(0,0,0,0.3)" : "0 10px 30px rgba(0,0,0,0.38), 0 2px 6px rgba(0,0,0,0.25)";
  if (selected) return `0 0 0 2.5px ${accent}, 0 0 0 6px color-mix(in oklab, ${accent} 24%, transparent), ${lift}`;
  const glow = orchestrator ? ", 0 0 0 5px color-mix(in oklab, var(--color-glow) 30%, transparent)" : "";
  return `0 0 0 2px ${accent}${glow}, ${lift}`;
}

/** Quem faz o agente ("Anthropic"), ou `null` se não se sabe. */
export function vendorOf(id: string): string | null {
  if (id.startsWith("claude")) return "Anthropic";
  if (id.startsWith("codex")) return "OpenAI";
  if (id.startsWith("antigravity") || id.startsWith("gemini")) return "Google";
  if (id.startsWith("opencode")) return "SST";
  if (id.startsWith("kimi")) return "Moonshot";
  if (id.startsWith("hermes")) return "Nous Research";
  if (id.startsWith("cursor")) return "Cursor";
  return null;
}

/** "Anthropic · CLI": quem faz o agente (o subtítulo do cartão no "Novo agente"). */
export function agentVendor(id: string, command: string, t: (key: string) => string): string {
  if (id === "bash" || id === "shell") return t("newAgent.vendor.shell");
  return `${vendorOf(id) ?? command} · CLI`;
}

/** O nome de exibição de um agente pelo id (quando não há o rótulo da tab à mão). */
export function agentName(id: string): string {
  if (id.startsWith("claude")) return "Claude Code";
  if (id.startsWith("codex")) return "Codex";
  if (id.startsWith("antigravity")) return "Antigravity";
  if (id.startsWith("gemini")) return "Gemini";
  if (id.startsWith("opencode")) return "OpenCode";
  if (id.startsWith("kimi")) return "Kimi";
  if (id.startsWith("hermes")) return "Hermes";
  if (id.startsWith("cursor")) return "Cursor";
  return id;
}
