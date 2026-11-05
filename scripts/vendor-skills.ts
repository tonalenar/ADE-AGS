#!/usr/bin/env bun
/**
 * Skills de terceiros que a ADE AGS traz embutidas (`skills/vendor.lock.json`).
 *
 * Cada uma é copiada de um repositório público numa tag fixa, conferida pelo commit, e cada arquivo leva o SHA-256
 * do original. O app instala e atualiza a cópia ao abrir (`src-tauri/src/skills/bundled.rs`), então uma versão nova
 * só chega aos agentes depois de revisada num PR. Nada do clone é executado: o script só lê arquivos.
 *
 * O `SKILL.md` embutido é o original com duas coisas a mais, fáceis de tirar para conferir o hash:
 * - linhas do frontmatter terminadas em `# ade-ags` (a versão que o app compara);
 * - o bloco entre `<!-- ADE AGS:BEGIN -->` e `<!-- ADE AGS:END -->` (como a skill convive com o caminho nativo).
 *
 * Uso:
 *   bun scripts/vendor-skills.ts --check                       # offline: os arquivos conferem com o lock
 *   bun scripts/vendor-skills.ts --outdated                    # rede: tags mais novas no upstream (só relata)
 *   bun scripts/vendor-skills.ts --update <nome> --tag <tag> --commit <sha>
 *       Clona a tag, exige que ela aponte para o commit informado, copia os arquivos do lock, recalcula os hashes e
 *       preserva o bloco da ADE AGS. A versão (`<upstream>+ade.<n>`) vai no frontmatter.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..");
const LOCK = join(ROOT, "skills", "vendor.lock.json");

type FileEntry = { from: string; sha256: string };
type Entry = { repo: string; tag: string; commit: string; version: string; license: string; files: Record<string, FileEntry> };
type Lock = { skills: Record<string, Entry> };

export const BEGIN = "<!-- ADE AGS:BEGIN -->";
export const END = "<!-- ADE AGS:END -->";

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** O `SKILL.md` original a partir do embutido: sem as linhas `# ade-ags` e sem o bloco da ADE AGS. */
export function upstreamOf(skill: string): string {
  const start = skill.indexOf(BEGIN);
  const end = skill.indexOf(END);
  let body = skill;
  if (start >= 0 && end > start) {
    // O bloco entra seguido de uma linha em branco; sai junto.
    body = skill.slice(0, start) + skill.slice(end + END.length).replace(/^\n\n/, "");
  }
  return body
    .split("\n")
    .filter((line) => !line.trimEnd().endsWith("# ade-ags"))
    .join("\n");
}

/** O embutido a partir do original: a versão no frontmatter e o bloco logo depois dele. */
export function compose(upstream: string, version: string, block: string): string {
  const lines = upstream.split("\n");
  if (lines[0] !== "---") throw new Error("SKILL.md sem frontmatter");
  const close = lines.indexOf("---", 1);
  if (close < 0) throw new Error("frontmatter sem fim");
  const head = [...lines.slice(0, close), `version: "${version}" # ade-ags`, "---"];
  const rest = lines.slice(close + 1);
  // Depois do frontmatter costuma vir uma linha em branco: o bloco entra depois dela.
  const blank = rest[0] === "" ? [""] : [];
  return [...head, ...blank, `${BEGIN}\n${block.trim()}\n${END}`, "", ...rest.slice(blank.length)].join("\n");
}

function readLock(): Lock {
  return JSON.parse(readFileSync(LOCK, "utf8"));
}

function check(): number {
  const lock = readLock();
  let bad = 0;
  for (const [name, entry] of Object.entries(lock.skills)) {
    for (const [dest, file] of Object.entries(entry.files)) {
      const path = join(ROOT, "skills", name, dest);
      if (!existsSync(path)) {
        console.error(`✗ ${name}/${dest}: falta`);
        bad++;
        continue;
      }
      const raw = readFileSync(path, "utf8");
      const content = dest === "SKILL.md" ? upstreamOf(raw) : raw;
      if (sha256(content) !== file.sha256) {
        console.error(`✗ ${name}/${dest}: o hash não confere com ${entry.repo}@${entry.tag}`);
        bad++;
      }
      if (dest === "SKILL.md" && !raw.includes(`version: "${entry.version}" # ade-ags`)) {
        console.error(`✗ ${name}/SKILL.md: a versão do frontmatter não é ${entry.version}`);
        bad++;
      }
    }
    if (bad === 0) console.log(`✓ ${name} ${entry.version} (${entry.repo}@${entry.tag}, ${entry.commit.slice(0, 7)})`);
  }
  return bad === 0 ? 0 : 1;
}

function git(args: string[], cwd?: string, trim = true): string {
  // Sem hooks e sem perguntar senha: o clone é só leitura.
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return trim ? r.stdout.trim() : r.stdout;
}

function semverish(tag: string): number[] {
  return tag.replace(/^v/, "").split(/[.+-]/).map((p) => Number.parseInt(p, 10) || 0);
}

function outdated(): number {
  const lock = readLock();
  for (const [name, entry] of Object.entries(lock.skills)) {
    const tags = git(["ls-remote", "--tags", "--refs", `https://github.com/${entry.repo}.git`])
      .split("\n")
      .map((l) => l.split("refs/tags/")[1])
      .filter((t): t is string => !!t && /^v?\d+\.\d+\.\d+$/.test(t));
    const newer = tags.filter((t) => {
      const [a, b] = [semverish(t), semverish(entry.tag)];
      for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
      return false;
    });
    console.log(newer.length ? `↑ ${name}: ${entry.tag} → ${newer.join(", ")}` : `= ${name}: ${entry.tag} é a mais nova`);
  }
  return 0;
}

function update(name: string, tag: string, commit: string): number {
  const lock = readLock();
  const entry = lock.skills[name];
  if (!entry) throw new Error(`${name} não está no lock`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("--commit precisa do SHA completo (40 caracteres)");
  const dir = mkdtempSync(join(tmpdir(), "ade-vendor-"));
  try {
    // Clone parcial, sem checkout: só os arquivos do lock são baixados (`git show`), nada vai para o disco como
    // árvore de trabalho e nada do repositório roda.
    git(["clone", "--quiet", "--depth", "1", "--filter=blob:none", "--no-checkout", "--branch", tag, `https://github.com/${entry.repo}.git`, dir]);
    const head = git(["rev-parse", "HEAD^{commit}"], dir);
    if (head !== commit) throw new Error(`a tag ${tag} aponta para ${head}, não para ${commit}: nada foi copiado`);
    const skillPath = join(ROOT, "skills", name, "SKILL.md");
    const old = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : "";
    const start = old.indexOf(BEGIN);
    const end = old.indexOf(END);
    if (start < 0 || end < start) throw new Error(`${name}/SKILL.md sem o bloco da ADE AGS: escreva-o antes de atualizar`);
    const block = old.slice(start + BEGIN.length, end);
    const plain = tag.replace(/^v/, "");
    const same = entry.version.startsWith(`${plain}+ade.`);
    const ade = same ? Number(entry.version.split("+ade.")[1]) + 1 : 1;
    const version = `${plain}+ade.${ade}`;
    for (const [dest, file] of Object.entries(entry.files)) {
      const raw = git(["show", `${commit}:${file.from}`], dir, false);
      file.sha256 = sha256(raw);
      const out = join(ROOT, "skills", name, dest);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, dest === "SKILL.md" ? compose(raw, version, block) : raw);
    }
    Object.assign(entry, { tag, commit, version });
    writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`${name}: ${version} (${entry.repo}@${tag}, ${commit.slice(0, 7)}). Revise o diff, sobretudo o SKILL.md e o bloco da ADE AGS.`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  let code = 0;
  try {
    if (args.includes("--outdated")) code = outdated();
    else if (args.includes("--update")) {
      const [name, tag, commit] = [flag("--update"), flag("--tag"), flag("--commit")];
      if (!name || !tag || !commit) throw new Error("uso: --update <nome> --tag <tag> --commit <sha>");
      code = update(name, tag, commit);
    } else code = check();
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    code = 1;
  }
  process.exit(code);
}
