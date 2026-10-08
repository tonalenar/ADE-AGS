# Execução local de testes e cache

No worktree do integrante, use `ags test affected --dry-run` para revisar o plano e
`ags test affected` para validar a entrega. A seleção reúne os arquivos commitados
desde o ancestral comum com `origin/master`, as alterações locais (inclusive staged
e exclusões) e os arquivos novos não ignorados. Nomes com espaços são preservados.
Arquivos sem mapeamento provocam fallback explícito para as suites completas.
Se `origin/master` estiver indisponível, a CLI falha claramente sem declarar verde.

`ags test run frontend|rust|tsc|babel` executa uma suite completa. Os comandos são:

| Suite | Comando (relativo à raiz) |
| --- | --- |
| frontend | `node node_modules/vitest/vitest.mjs run` |
| rust | em `src-tauri`: `cargo test --lib --bin ags` |
| tsc | `node node_modules/typescript/bin/tsc --noEmit` |
| babel | `node scripts/babel-parse-check.mjs src` |

Suites completas locais ficam reservadas para mudanças de risco: migrações de
banco, schema, código unsafe ou COM. Nas demais entregas, integrantes e QA usam
o plano afetado; ao abrir um PR, aguardam o CI com `gh pr checks <n> --watch`.

O target padrão é `~/.ags/cargo-target-agents`, separado do target usado pelo app
em `tauri dev`. O aquecimento inicial é feito uma vez com `cargo test --lib --no-run`
e `CARGO_TARGET_DIR` apontando para esse diretório. A configuração
`ADE_AGS_CARGO_TARGET_DIR=per-worktree` mantém um target por worktree;
`shared` seleciona o padrão e um caminho personalizado também é aceito.
A CLI de testes usa essa configuração em vez de herdar o target do app.
Não remova targets nem worktrees de uma missão em andamento.

O schema v38 acrescenta a tabela `test_results` e seu índice de consulta sem
remover dados. A CLI pode funcionar sem a app: cria apenas essa tabela aditiva,
sem migrar ou rebaixar o restante do banco da app. `ags test status` lista os
últimos 50 resultados do repositório.

Uma reutilização exige árvore Git limpa, mesmo hash `HEAD^{tree}`, mesmo
repositório e mesma suite/comando (argv e diretório). Worktrees do mesmo
repositório podem compartilhar um resultado. Alterações staged, unstaged,
untracked ou em submódulos impedem reutilização. A árvore é verificada antes
e depois da execução; se mudar durante o teste, o resultado não serve como cache.
Falhas nunca produzem cache verde e uma falha forçada invalida o verde anterior
da mesma chave. `--force` ignora a consulta. A mensagem de acerto informa
`já verde neste hash (há X min)`.

Cada comando selecionado tem seu resultado e seu span `test`: suite, comando,
intervalo e `cacheHit`. `--dry-run` não executa, não grava resultado nem span.
A missão pode ser passada com `--mission <id>` ou `ADE_MISSION_ID`; normalmente
é inferida do worktree registrado para a missão em execução. `testMetrics` em
timings/efficiency contém `timeMs`, `commands`, `skippedCache` e `skippedAffected`.
Os contadores representam comandos/suites, não um número estimado de casos de
teste: `skippedAffected` conta suites ausentes do plano, e `skippedCache` conta
comandos já verdes. Os tempos reais de referência são consolidados em
[TEST_SPEED.md](TEST_SPEED.md).

## Por que o cache não acertava nas missões

Na Etapa 24 o contador skippedCache ficou em 0: os agentes rodavam `ags test affected` com a árvore suja (resultado com clean: false, sem treeHash, nunca reaproveitável), cada worktree tinha uma árvore diferente e o mesmo teste aparecia com argv diferente (`--bin ags`, `--lib --bin ags`, filtros de módulo).

A onda 1 faz o verde da mesma árvore e do mesmo comando valer em outro worktree:

- arquivo não rastreado de skill (`.agents/`, `.claude/`, `.gemini/`, `.codex/`, `.kimi/`, `.opencode/`, `.cursor/skills/`) não suja o cache e não dispara a suíte completa; esses diretórios também estão no `.gitignore` (`.cursor/skills` não, porque `.cursor/` pode ter regras do projeto);
- barras, grafia do `cwd` e a ordem dos filtros do Cargo ou dos arquivos do `vitest related` compartilham a mesma chave;
- a chave do repositório é o git comum, não o caminho do worktree.

O QA roda `ags test affected` no mesmo commit. `já verde neste hash` significa que a suíte não rodou de novo. A suíte completa (ou o CI) continua uma vez na integração. Arquivo de produto sem mapa, schema, COM e `unsafe` adicionado no diff continuam pedindo a suíte Rust completa. `unsafe` que já estava no arquivo e não entrou numa linha nova não pede.

A base do diff afetado continua `origin/master`, não a última árvore verificada. Uma base deslizante pode pular um arquivo que só ficou verde em outro worktree ou que mudou de novo depois do registro. Isso fica para a próxima onda.
