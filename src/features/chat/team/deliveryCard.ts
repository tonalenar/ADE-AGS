import type { TeamHandoff } from "./ipc";

type Body = TeamHandoff["handoff"];
type Translate = (key: string, options?: Record<string, unknown>) => string;

/** O desfecho de uma entrega, como o T3 Code nomeia a conclusão de uma tarefa delegada. */
export type DeliveryOutcome = "finished" | "blocked" | "continue";

export function deliveryOutcome(body: Body | undefined): DeliveryOutcome {
  if (body?.status === "blocked") return "blocked";
  if (body?.status === "continue") return "continue";
  return "finished";
}

const PULL_REQUEST = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

/** O primeiro link de pull request citado em qualquer campo da entrega. */
export function deliveryPullRequest(body: Body | undefined): string | null {
  if (!body) return null;
  const fields = [body.summary ?? "", ...(body.evidence ?? []), ...(body.next_steps ?? []), ...(body.risks ?? [])];
  for (const field of fields) {
    const found = PULL_REQUEST.exec(field);
    if (found) return found[0];
  }
  return null;
}

/** A entrega inteira em Markdown, sem cortar nada: tarefa, resumo, arquivos, testes, riscos, pendências e PR. Pura. */
export function deliveryMarkdown(body: Body, task: string | null, t: Translate): string {
  const out: string[] = [];
  const list = (title: string, items: string[]) => {
    if (items.length > 0) out.push(`**${title}**\n\n${items.map((i) => `- ${i}`).join("\n")}`);
  };
  if (task?.trim()) out.push(`**${t("chat.team.card.task")}**\n\n${task.trim()}`);
  if (body.summary?.trim()) out.push(body.summary.trim());
  const pr = deliveryPullRequest(body);
  if (pr) out.push(`**${t("chat.team.card.pr")}:** [${pr}](${pr})`);
  list(t("chat.team.card.blockers"), body.blockers ?? []);
  list(t("chat.team.card.files"), (body.changed_files ?? []).map((f) => (f.description ? `\`${f.path}\` — ${f.description}` : `\`${f.path}\``)));
  list(t("chat.team.card.tests"), (body.tests ?? []).map((x) => `\`${x.command}\` (${t(`chat.team.card.test.${x.status}`)})`));
  list(t("chat.team.card.decisions"), body.decisions ?? []);
  list(t("chat.team.card.risks"), body.risks ?? []);
  list(t("chat.team.card.nextSteps"), body.next_steps ?? []);
  list(t("chat.team.card.evidence"), body.evidence ?? []);
  return out.join("\n\n");
}

/** O horário do cartão (`HH:MM`); aceita segundos ou milissegundos. */
export function cardTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "";
  return new Date(at < 1e12 ? at * 1000 : at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
