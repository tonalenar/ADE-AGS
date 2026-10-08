/** O fundo do ícone de cada agente (estilo app do iOS). */
export function agentTile(id: string): string {
  if (id.startsWith("claude")) return "linear-gradient(180deg,#e08a6c,#c96442)";
  if (id.startsWith("codex")) return "linear-gradient(180deg,#3a3a3c,#1c1c1e)";
  if (id.startsWith("antigravity") || id.startsWith("gemini")) return "linear-gradient(135deg,#4285f4,#9b72cb)";
  if (id.startsWith("opencode")) return "linear-gradient(180deg,#5e5ce6,#3634a3)";
  if (id.startsWith("kimi")) return "linear-gradient(180deg,#30b0c7,#0a7d93)";
  return "linear-gradient(180deg,#636366,#48484a)";
}

/** Quem faz o agente ("Anthropic"), ou `null` se não se sabe. */
export function vendorOf(id: string): string | null {
  if (id.startsWith("claude")) return "Anthropic";
  if (id.startsWith("codex")) return "OpenAI";
  if (id.startsWith("antigravity") || id.startsWith("gemini")) return "Google";
  if (id.startsWith("opencode")) return "SST";
  if (id.startsWith("kimi")) return "Moonshot";
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
  return id;
}
