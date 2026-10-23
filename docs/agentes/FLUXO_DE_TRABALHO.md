# Fluxo de trabalho: git, testes, CI, PRs e docs

> Parte do guia de agentes. Índice e regras de ouro: [`AGENTS.md`](../../AGENTS.md).

## Antes de começar
- A pasta principal (`~/.antigravity/ADE-AGS`) pode estar num branch local antigo, com mudanças sem commit. Confira `git status` e `git log origin/dev -1` antes de qualquer coisa.
- Trabalho novo sai de `origin/dev`, de preferência num worktree em `~/.antigravity/ADE-AGS-wt/<nome>`.
- Remotes:
  - `origin` = `tonalenar/ADE-AGS` (o fork);
  - `upstream` = `luis3132/ControlCode` (de outro autor; nunca abra nada lá).

## Comandos
| Tarefa | Comando |
|---|---|
| Instalar deps | `bun install` |
| Dev isolado (recomendado) | `pwsh scripts/dev-local.ps1 -Run` (`-SkipBuild` só reabre). Ver `docs/ade-ags/DEV_LOCAL.md` |
| Dev com Vite (porta 1420) | `bun run tauri dev` |
| Typecheck | `bunx tsc --noEmit` |
| Babel | `bun run check:babel` |
| Lint dos testes | `bun run check:test-lint` (`-- --todas` lista tudo; `-- --update-baseline` regrava o baseline) |
| Testes front | `bun run test` / `bunx vitest run <arquivo>` |
| Testes Rust | `cd src-tauri && cargo test --lib --bin ags` |
| Só o afetado | `ags test affected [--dry-run]` · `ags test run frontend\|rust\|tsc\|babel` · `ags test status` |
| Build/instalador | `bun run app:build [--release] [--target <triple>]` |
| Release | `bun run release X.Y.Z [--dry]`: só o usuário decide |
| Relatório A/B | `node scripts/ab-report.mjs [grupo]` (lê `data.db` só para leitura) |

## Testes: rápido, não suíte completa
- No ciclo interno, use **`ags test affected`**, depois de commitar o código de produto: o cache vale por `HEAD^{tree}`, e a comparação é com `origin/master`. Detalhes em `docs/ade-ags/TEST_SPEED.md` e `TEST_CACHE.md`.
- Suíte completa local **só** em três casos: migração de schema ou DDL; `unsafe`, COM ou Win32; mudança de schema IPC.
- Não remova targets nem worktrees de uma missão em andamento.

## Lint dos testes
`scripts/test-lint.mjs` varre os `*.test.ts(x)` de `src/` e o código de teste Rust (`test.rs`, `*_test.rs`, os `mod` puxados por `#[cfg(test)]` e os blocos `#[cfg(test)] mod x { … }`). Strings e comentários não contam.

| Regra | Pega | Como resolver |
|---|---|---|
| `espera-real` | `setTimeout`/`setInterval`/`sleep(N)` com mais de 10 ms num arquivo sem `vi.useFakeTimers()`; `thread::sleep`/`tokio::time::sleep` acima de 10 ms ou com duração não literal | Fake timers (`vi.useFakeTimers`, `tokio::time::pause`) ou esperar o evento |
| `polling` | Laço que dorme (`while`/`for`/`loop` com sleep ou timer acima de 10 ms) e `while (Date.now() < fim)` | Esperar o evento, o canal ou a promessa |
| `skip-sem-motivo` | `it.skip`, `describe.skip`, `test.skipIf`, `xit`, `#[ignore]` | `// quarantine: <motivo ou #issue>` na linha ou logo acima. No Rust, `#[ignore = "motivo"]` também vale |
| `supressao-sem-motivo` | `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable`, `biome-ignore`, `#[allow]`/`#[expect]` | Motivo depois da diretiva (`@ts-expect-error <motivo>`, `eslint-disable-line regra -- <motivo>`); no Rust, `// <motivo>` acima ou `reason = "…"` |

- As violações antigas ficam em `scripts/test-lint-baseline.json`, contadas por arquivo e regra. O check falha só quando uma contagem passa do baseline.
- **Para encolher o baseline:** rode `bun run check:test-lint -- --todas`, corrija uma violação, rode `bun run check:test-lint -- --update-baseline` e commite o baseline menor junto com a correção.
- **Nunca** use o `--update-baseline` para engolir violação nova. Um baseline que cresce no diff do PR precisa de motivo escrito.
- O próprio checker tem teste: `src/app/tests/testLint.test.ts`.

## CI (`.github/workflows/ci.yml`)
Roda em todo PR, mas ignora `**.md` e `docs/**`.

| SO | Job | O que roda | Tempo |
|---|---|---|---|
| Linux | `test` | `bunx tsc --noEmit` → `node scripts/babel-parse-check.mjs src` → `node scripts/test-lint.mjs` → `bun run test` → `cargo test --lib --bin ags` | ~4 min |
| Windows | `check (windows)` | `cargo check --lib --bins --tests` | ~1m40s |

- Não há clippy nem fmt no CI.
- Para esperar o CI, use `gh pr checks <n> --repo tonalenar/ADE-AGS --watch`. **Nunca** faça polling com `sleep`/`Start-Sleep`.
- O release (`release.yml`) roda em tags `v*`, numa matriz de 6 alvos. As notas ficam em `.github/releases/<tag>.md`, em inglês e escritas à mão.

## Branches
- `feat/<kebab-pt>`, `fix/…`, `docs/…`, `test/…`, `perf/…`, `chore/…`, `ci/…`.
- Branches `cc/…` são criadas pelo app (missões, frota, andares): não reutilize.
- Fluxo: PR de feature vai para **`dev`**; `dev` vai para `master` periodicamente, pelo usuário.

## Commits
- **Conventional Commits em PT-BR**, em minúsculas e descritivos. Exemplo: `feat(canvas): navegador com a moldura do terminal e zoom da página`.
- Escopos livres: `missions`, `memória`, `vigia`, `jev`, `conversas`, `andares`, `forge`, `canvas`, `tabs`, `qa`…
- Uma melhoria por commit, cada uma com teste quando houver lógica.
- Agentes incluem o trailer `Co-Authored-By` do seu modelo.

## PRs
- Crie com `gh pr create --repo tonalenar/ADE-AGS --base dev`. **Sempre `--repo`**: sem ele, o `gh` deste clone aponta para o upstream.
- Descrição em PT-BR: o que muda, como foi testado, **o que foi verificado e o que não foi**.
- Antes de abrir, confira a §6 do [`AGENTS.md`](../../AGENTS.md#6-antes-de-abrir-o-pr): superfícies, prova e planos.
- Sem merge, push para `dev`/`master`, tag, release ou reinstalação sem OK do usuário.
- Mudou um comportamento visível ou um contrato? Atualize o doc correspondente em `docs/ade-ags/` e a seção do `ROADMAP.md`.
- Não commite `site api/` (projeto de teste de missões), binários de `src-tauri/binaries/` nem pastas de agente (`.claude/`, `.agents/`, `.codex/`…).

## Documentação
- Fica em `docs/ade-ags/`, em PT-BR e **sem BOM**.
- Nomes:
  - temas: `MAIUSCULAS_COM_UNDERSCORE.md`;
  - auditorias: `AUDITORIA_<AAAA-MM-DD>[_TEMA].md`;
  - rodadas de teste: `RELATORIO_TESTE_V<n>.md`;
  - etapas: `ETAPA_<n>_*.md`;
  - decisões: `docs/decisoes/<TEMA>.md`;
  - bench: `docs/ade-ags/bench/`.
- `ROADMAP.md` é o índice vivo; `ARCHITECTURE.md` é a visão geral.
- Estilo: frases curtas, tabelas, citações `arquivo:linha`, "não medido" em vez de número inventado.
- Guia de agentes: `AGENTS.md` mais os arquivos de `docs/agentes/`. Mudou uma regra? Mude ali.
