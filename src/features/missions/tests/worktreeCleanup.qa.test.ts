import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * QA Suite de Fixtures de Repositórios Git Temporários para Limpeza de Worktrees (Etapa 21, item 7b).
 *
 * Cobre:
 * 1. dry-run:
 *    - Inspeciona worktrees existentes e lista ações planejadas (remover vs preservar)
 *    - NENHUM arquivo no disco e NENHUMA branch do git é removida no modo dry-run
 * 2. Alterações não commitadas (uncommitted changes):
 *    - Arquivo rastreado modificado ou novo arquivo untracked
 *    - O processo de limpeza recusa a remoção / sinaliza trabalho pendente para prevenir perda de dados
 * 3. Commits fora do master (commits unmerged):
 *    - Worktree com commits que master ainda não possui
 *    - A branch NÃO é excluída (branchKept: true) para evitar perda de histórico
 *    - Worktree com branch 100% incorporada ao master é removida junto com a branch
 * 4. Junction node_modules (Windows Junction / Unix Symlink):
 *    - Worktree possui junction apontando para o node_modules compartilhado do repo principal
 *    - Limpeza remove o link de forma segura
 *    - CRÍTICO: o diretório node_modules no repo base e todo o seu conteúdo permanecem 100% INTACTOS!
 */

export interface WorktreeInspectResult {
  path: string;
  branch: string;
  isClean: boolean;
  uncommittedFiles: string[];
  commitsAheadOfMaster: number;
  hasNodeModulesLink: boolean;
  safeToDelete: boolean;
}

export interface CleanupPlanItem {
  worktreePath: string;
  branch: string;
  action: "delete_worktree_and_branch" | "delete_worktree_keep_branch" | "skip_dirty";
  reason: string;
}

export interface CleanupResult {
  planned: CleanupPlanItem[];
  executedDeletions: string[];
  branchesDeleted: string[];
  branchesPreserved: string[];
}

function shGit(cwd: string, cmd: string): string {
  return execSync(`git -c user.name="ADE QA" -c user.email="qa@localhost" ${cmd}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/[\r\n]+$/, "");
}

/** Inspeciona o estado detalhado de um worktree */
export function inspectWorktree(repoRoot: string, worktreePath: string, masterBranch = "master"): WorktreeInspectResult {
  const branch = shGit(worktreePath, "rev-parse --abbrev-ref HEAD");
  const statusOut = shGit(worktreePath, "status --porcelain -z");
  const uncommittedFiles = statusOut
    .split("\0")
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3))
    // O link node_modules do worktree (junction/symlink) não conta como alteração: o projeto o ignora.
    .filter((file) => file !== "node_modules");

  let commitsAheadOfMaster = 0;
  try {
    const revList = shGit(repoRoot, `rev-list ${masterBranch}..${branch} --count`);
    commitsAheadOfMaster = Number.parseInt(revList, 10) || 0;
  } catch {
    commitsAheadOfMaster = 0;
  }

  const nmPath = path.join(worktreePath, "node_modules");
  let hasNodeModulesLink = false;
  if (fs.existsSync(nmPath)) {
    try {
      const stat = fs.lstatSync(nmPath);
      hasNodeModulesLink = stat.isSymbolicLink();
    } catch {
      hasNodeModulesLink = false;
    }
  }

  const isClean = uncommittedFiles.length === 0;
  const safeToDelete = isClean;

  return {
    path: worktreePath,
    branch,
    isClean,
    uncommittedFiles,
    commitsAheadOfMaster,
    hasNodeModulesLink,
    safeToDelete,
  };
}

/** Planeja ou executa a limpeza de worktrees com suporte a dry-run */
export function cleanupWorktrees(
  repoRoot: string,
  worktreePaths: string[],
  options: { dryRun: boolean; masterBranch?: string } = { dryRun: false },
): CleanupResult {
  const masterBranch = options.masterBranch ?? "master";
  const planned: CleanupPlanItem[] = [];
  const executedDeletions: string[] = [];
  const branchesDeleted: string[] = [];
  const branchesPreserved: string[] = [];

  for (const wtPath of worktreePaths) {
    if (!fs.existsSync(wtPath)) continue;
    const inspected = inspectWorktree(repoRoot, wtPath, masterBranch);

    if (!inspected.isClean) {
      planned.push({
        worktreePath: wtPath,
        branch: inspected.branch,
        action: "skip_dirty",
        reason: `Alterações não commitadas pendentes: ${inspected.uncommittedFiles.join(", ")}`,
      });
      continue;
    }

    if (inspected.commitsAheadOfMaster > 0) {
      planned.push({
        worktreePath: wtPath,
        branch: inspected.branch,
        action: "delete_worktree_keep_branch",
        reason: `Branch possui ${inspected.commitsAheadOfMaster} commit(s) fora do ${masterBranch}; preservando branch`,
      });
    } else {
      planned.push({
        worktreePath: wtPath,
        branch: inspected.branch,
        action: "delete_worktree_and_branch",
        reason: `Worktree limpo e branch totalmente mesclada em ${masterBranch}`,
      });
    }

    if (!options.dryRun) {
      // Remoção segura de junction/symlink antes do git worktree remove se necessário
      const nmPath = path.join(wtPath, "node_modules");
      if (fs.existsSync(nmPath)) {
        try {
          const stat = fs.lstatSync(nmPath);
          if (stat.isSymbolicLink()) {
            fs.unlinkSync(nmPath);
          }
        } catch {
          // segue para git worktree remove
        }
      }

      shGit(repoRoot, `worktree remove "${wtPath}" --force`);
      executedDeletions.push(wtPath);

      if (inspected.commitsAheadOfMaster > 0) {
        branchesPreserved.push(inspected.branch);
      } else {
        shGit(repoRoot, `branch -D "${inspected.branch}"`);
        branchesDeleted.push(inspected.branch);
      }
    }
  }

  return { planned, executedDeletions, branchesDeleted, branchesPreserved };
}

describe("Worktree Cleanup - QA Git Repository Fixtures Suite", () => {
  let tmpBaseDir: string;
  let repoDir: string;
  let sharedNodeModulesDir: string;

  beforeEach(() => {
    tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-qa-wt-cleanup-"));
    repoDir = path.join(tmpBaseDir, "main-repo");
    fs.mkdirSync(repoDir, { recursive: true });

    // Inicializa repositório git principal com branch master
    shGit(repoDir, "init -q -b master");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Repo Principal\n");
    fs.writeFileSync(path.join(repoDir, ".gitignore"), "node_modules/\n");

    // Cria diretório compartilhado node_modules simulado
    sharedNodeModulesDir = path.join(repoDir, "node_modules");
    fs.mkdirSync(path.join(sharedNodeModulesDir, "@tauri-apps"), { recursive: true });
    fs.writeFileSync(path.join(sharedNodeModulesDir, "package.json"), '{"name":"shared-modules"}');
    fs.writeFileSync(
      path.join(sharedNodeModulesDir, "@tauri-apps", "api.js"),
      "module.exports = { invoke: () => {} };",
    );

    shGit(repoDir, "add .");
    shGit(repoDir, 'commit -q -m "initial master commit"');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBaseDir, { recursive: true, force: true });
    } catch {
      // Ignora erro de limpeza de temp em ambiente Windows se algum processo ainda liberar handles
    }
  });

  it("Fixture 1 (dry-run): inspeciona e gera plano sem tocar em arquivos ou branches", () => {
    const wtClean = path.join(tmpBaseDir, "wt-clean");
    shGit(repoDir, `worktree add -b mission-clean "${wtClean}" master`);

    const result = cleanupWorktrees(repoDir, [wtClean], { dryRun: true });

    expect(result.planned).toHaveLength(1);
    expect(result.planned[0].action).toBe("delete_worktree_and_branch");
    expect(result.executedDeletions).toHaveLength(0);
    expect(result.branchesDeleted).toHaveLength(0);

    // No modo dry-run, a pasta e a branch continuam existindo fisicamente
    expect(fs.existsSync(wtClean)).toBe(true);
    const branchList = shGit(repoDir, "branch --list mission-clean");
    expect(branchList).toContain("mission-clean");
  });

  it("Fixture 2 (alterações não commitadas): recusa remoção de worktree sujo", () => {
    const wtDirty = path.join(tmpBaseDir, "wt-dirty");
    shGit(repoDir, `worktree add -b mission-dirty "${wtDirty}" master`);

    // Modifica arquivo rastreado
    fs.appendFileSync(path.join(wtDirty, "README.md"), "\nEdição não commitada do agente\n");
    // Cria arquivo novo não rastreado
    fs.writeFileSync(path.join(wtDirty, "novo_rascunho.txt"), "conteúdo temporário");

    const inspect = inspectWorktree(repoDir, wtDirty);
    expect(inspect.isClean).toBe(false);
    expect(inspect.safeToDelete).toBe(false);
    expect(inspect.uncommittedFiles).toContain("README.md");
    expect(inspect.uncommittedFiles).toContain("novo_rascunho.txt");

    // Executa limpeza (não dry-run): DEVE pular o worktree sujo
    const result = cleanupWorktrees(repoDir, [wtDirty], { dryRun: false });
    expect(result.planned[0].action).toBe("skip_dirty");
    expect(result.executedDeletions).toHaveLength(0);
    expect(fs.existsSync(wtDirty)).toBe(true);
    expect(fs.existsSync(path.join(wtDirty, "novo_rascunho.txt"))).toBe(true);
  });

  it("Fixture 3 (commits fora do master): remove a pasta mas PRESERVA a branch com commits unmerged", () => {
    const wtUnmerged = path.join(tmpBaseDir, "wt-unmerged");
    shGit(repoDir, `worktree add -b mission-feature "${wtUnmerged}" master`);

    // Faz commit próprio na branch do worktree
    fs.writeFileSync(path.join(wtUnmerged, "feature.txt"), "código concluído da tarefa");
    shGit(wtUnmerged, "add feature.txt");
    shGit(wtUnmerged, 'commit -q -m "feat: entregue pela task"');

    const inspect = inspectWorktree(repoDir, wtUnmerged);
    expect(inspect.isClean).toBe(true);
    expect(inspect.commitsAheadOfMaster).toBe(1);

    // Executa limpeza: remove o worktree físico mas PRESERVA a branch
    const result = cleanupWorktrees(repoDir, [wtUnmerged], { dryRun: false });
    expect(result.planned[0].action).toBe("delete_worktree_keep_branch");
    expect(result.executedDeletions).toContain(wtUnmerged);
    expect(result.branchesPreserved).toContain("mission-feature");
    expect(result.branchesDeleted).not.toContain("mission-feature");

    // Confirma que a pasta foi removida e a branch ainda existe no repo principal
    expect(fs.existsSync(wtUnmerged)).toBe(false);
    const branchList = shGit(repoDir, "branch --list mission-feature");
    expect(branchList).toContain("mission-feature");
  });

  it("Fixture 4 (junction node_modules): limpa worktree sem apagar o node_modules compartilhado no repo base", () => {
    const wtJunction = path.join(tmpBaseDir, "wt-junction");
    shGit(repoDir, `worktree add -b mission-junction "${wtJunction}" master`);

    // Cria junction ou symlink de diretório no worktree apontando para repoDir/node_modules
    const wtNodeModules = path.join(wtJunction, "node_modules");
    try {
      fs.symlinkSync(sharedNodeModulesDir, wtNodeModules, "junction");
    } catch {
      fs.symlinkSync(sharedNodeModulesDir, wtNodeModules, "dir");
    }

    expect(fs.existsSync(wtNodeModules)).toBe(true);
    expect(fs.existsSync(path.join(wtNodeModules, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(wtNodeModules, "@tauri-apps", "api.js"))).toBe(true);

    const inspect = inspectWorktree(repoDir, wtJunction);
    expect(inspect.hasNodeModulesLink).toBe(true);
    expect(inspect.isClean).toBe(true);

    // Executa limpeza do worktree
    const result = cleanupWorktrees(repoDir, [wtJunction], { dryRun: false });
    expect(result.executedDeletions).toContain(wtJunction);
    expect(fs.existsSync(wtJunction)).toBe(false);

    // CRÍTICO: o node_modules original compartilhado e seus arquivos internos NÃO foram apagados
    expect(fs.existsSync(sharedNodeModulesDir)).toBe(true);
    expect(fs.existsSync(path.join(sharedNodeModulesDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(sharedNodeModulesDir, "@tauri-apps", "api.js"))).toBe(true);
    expect(fs.readFileSync(path.join(sharedNodeModulesDir, "package.json"), "utf-8")).toBe(
      '{"name":"shared-modules"}',
    );
  });
});
