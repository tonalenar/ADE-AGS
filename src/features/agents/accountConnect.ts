/**
 * O que a tela de Agentes pode oferecer para ligar uma conta, sem mandar a pessoa
 * para outra seção. O programa ausente não pode sumir com o botão: a API key do
 * Claude Code grava no cofre e não precisa do binário.
 */
export type AccountConnectOffer =
  | { kind: "api-key"; login: boolean }
  | { kind: "dialog" }
  | { kind: "oauth" }
  | { kind: "cli-login" }
  | { kind: "found" }
  | { kind: "program" };

export function accountConnectOffer(agentId: string, available: boolean): AccountConnectOffer {
  if (agentId === "antigravity") return { kind: "oauth" };
  if (agentId === "claude-code") return { kind: "api-key", login: available };
  if ((agentId === "codex" || agentId === "opencode") && available) return { kind: "dialog" };
  if (agentId === "cursor" && available) return { kind: "cli-login" };
  // Encontrou o programa, mas não há login separado para abrir daqui.
  if (available) return { kind: "found" };
  return { kind: "program" };
}

/**
 * A busca da lista e o cadastro de contas são duas leituras. Depois de instalar,
 * a lista já vê o programa e o cadastro ainda diz que não está. Qualquer uma basta.
 */
export function programPresent(installed: boolean, detected: boolean): boolean {
  return installed || detected;
}

/** O formulário de nova conta abre: login, API key, ou os dois. */
export function accountFormMode(agentId: string, installed: boolean): "both" | "api-key" | "login" | "blocked" {
  const offer = accountConnectOffer(agentId, installed);
  if (offer.kind === "api-key") return offer.login ? "both" : "api-key";
  if (offer.kind === "dialog" && agentId === "codex") return "both";
  if (offer.kind === "dialog") return "login";
  return "blocked";
}
