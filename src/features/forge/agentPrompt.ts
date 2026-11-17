/**
 * El mensaje con que se le pasa un issue o un PR a un agente para que lo trabaje.
 *
 * Va en inglés, como todo lo que lee el modelo. Lleva el issue entero —descripción e hilo—
 * y no solo el enlace: el agente puede no tener cómo abrirlo (un repo privado, sin las
 * herramientas de git de ADE AGS), y con el texto adelante no gasta un paso en ir a
 * buscarlo.
 */
import type { ForgeItemDetail } from "./types";
import { wrapUntrusted } from "./untrustedPrompt";

/** Más que esto de hilo ya no es contexto, es ruido: un issue con 80 comentarios. */
const MAX_THREAD = 24_000;
const MAX_COMMENT = 4_000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[… truncated]`;
}

export function itemPrompt(item: ForgeItemDetail, pr: boolean): string {
  const kind = pr ? "pull request" : "issue";
  const remote: string[] = [];

  remote.push(
    `Title: ${item.title}`,
    `State: ${item.state}${item.draft ? " (draft)" : ""}`,
  );
  if (item.author) remote.push(`Author: @${item.author}`);
  if (item.labels.length) remote.push(`Labels: ${item.labels.join(", ")}`);
  if (pr && item.sourceBranch && item.targetBranch) {
    remote.push(`Branches: ${item.sourceBranch} → ${item.targetBranch}`);
  }

  remote.push("", `## Description`, "", item.body?.trim() ? clip(item.body.trim(), MAX_THREAD) : "(no description)");

  if (item.thread.length) {
    remote.push("", `## Comments`);
    let used = 0;
    let shown = 0;
    for (const c of item.thread) {
      const body = clip(c.body.trim(), MAX_COMMENT);
      if (used + body.length > MAX_THREAD) break;
      used += body.length;
      shown++;
      remote.push("", `### @${c.author ?? "unknown"}${c.createdAt ? ` (${c.createdAt})` : ""}`, "", body);
    }
    if (shown < item.thread.length) {
      remote.push("", `[${item.thread.length - shown} more comments omitted: read them at the URL above]`);
    }
  }

  const lines: string[] = [
    pr
      ? `Continue work on pull request #${item.number} of this repository (${item.webUrl}) and get it ready to merge.`
      : `Resolve issue #${item.number} of this repository (${item.webUrl}).`,
    "",
    wrapUntrusted(pr ? "pull-request" : "issue", remote.join("\n")),
    "",
    `## What to do`,
    "",
    ...(pr
      ? [
        `- Make sure you are on the \`${item.sourceBranch ?? "PR"}\` branch before changing anything.`,
        "- Read the PR's diff and the review comments above, and address whatever is still pending.",
      ]
      : [
        "- Read the relevant code first, and ask me if the issue is ambiguous before making large changes.",
        "- Implement the fix or feature, with tests where the project has them.",
      ]),
    `- If you have ADE AGS's git tools (git_${pr ? "pr" : "issue"}_view${pr ? ", git_pr_files, git_checks" : ""}), use them to read the latest state of this ${kind}.`,
    "- Don't push, comment or open pull requests unless I ask you to.",
  ];

  return lines.join("\n");
}
