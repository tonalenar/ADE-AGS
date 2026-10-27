/** O que o painel da sessão mostra, sem React: rótulos e filtros puros. */
import type { ForgeItem } from "@/features/forge/types";
import type { Task } from "@/features/runs/types";

/** A pasta como o Claude Code a mostra: o nome, e o pai encurtado com `~` para o home. */
export function folderLabel(cwd: string, home: string | null): { name: string; parent: string } {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  const name = parts.pop() ?? cwd;
  const sep = cwd.includes("\\") ? "\\" : "/";
  let parent = (/^[\\/]/.test(cwd) ? sep : "") + parts.join(sep);
  if (home) {
    // O home vem do sistema (com `\` no Windows) e o cwd pode vir com `/`: compara sem olhar a barra.
    const key = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const h = home.replace(/[\\/]+$/, "");
    if (key(parent) === key(h)) parent = "~";
    else if (key(parent).startsWith(key(h) + "/")) parent = "~" + parent.slice(h.length);
  }
  return { name, parent };
}

const STATE_ORDER: Record<string, number> = { open: 0, merged: 1, closed: 2 };

/** Os PRs que saem desta branch: os abertos primeiro, depois os mais novos. */
export function branchPulls(items: ForgeItem[], branch: string | null, limit = 5): ForgeItem[] {
  if (!branch) return [];
  return items
    .filter((p) => p.sourceBranch === branch)
    .sort((a, b) => (STATE_ORDER[a.state] ?? 3) - (STATE_ORDER[b.state] ?? 3)
      || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, limit);
}

const LIVE: ReadonlySet<Task["status"]> = new Set(["pending", "ready", "running"]);
const FINISHED: ReadonlySet<Task["status"]> = new Set(["done", "failed", "cancelled", "handed_off", "skipped"]);

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** As tarefas da frota que rodam nesta pasta (ou num worktree dela): as vivas e quantas já acabaram. */
export function backgroundTasks(tasks: Task[], cwd: string | null): { live: Task[]; finished: number } {
  const here = cwd ? norm(cwd) : null;
  const mine = here ? tasks.filter((t) => norm(t.cwd) === here || norm(t.cwd).startsWith(here + "/")) : tasks;
  return {
    live: mine.filter((t) => LIVE.has(t.status)).sort((a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt)),
    finished: mine.filter((t) => FINISHED.has(t.status)).length,
  };
}

/** "45 s", "2 min 48 s", "1 h 05 min": o tempo que uma tarefa está rodando. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** "12,3k" e "1,2M": tokens curtos para caber numa linha. */
export function shortTokens(n: number, locale?: string): string {
  const fmt = (v: number) => v.toLocaleString(locale, { maximumFractionDigits: 1 });
  if (n >= 1_000_000) return `${fmt(n / 1_000_000)}M`;
  if (n >= 1_000) return `${fmt(n / 1_000)}k`;
  return String(n);
}
