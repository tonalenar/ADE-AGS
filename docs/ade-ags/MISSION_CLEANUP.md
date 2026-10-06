# Limpeza e conflitos de integração — Etapa 21

`ags mission cleanup <id> --dry-run` inspeciona os worktrees da equipe, tarefas headless
e integração. `ags mission cleanup <id>` executa só quando a inspeção inteira não tem
bloqueios. A UI usa `mission_cleanup({missionId,dryRun})`; `dryRun` é true por padrão.
O relatório é `{dryRun, entries:[{missionId,root,branch,sizeBytes,blockers,removed}]}`.

São elegíveis apenas missões `done`, `cancelled` ou `failed`, sem terminais abertos
na árvore, alterações não commitadas ou commits fora de `origin/master`. O relatório
lista arquivos/commits que impedem a limpeza. Não consulta PRs pela rede: conter todos
os commits no master local é a prova conservadora de integração. PR mesclado por squash
pode continuar bloqueado se o commit original não for ancestral de master; o trabalho
é preservado para revisão. Não há remoção forçada de trabalho não integrado.

Antes de remover, o caminho canônico deve permanecer estritamente dentro de
`~/.ags/worktrees`, a branch deve ser `cc/*`, e a identidade do checkout deve conferir.
A junction/symlink de `node_modules` é desmontada com a API do SO (`remove_mount`),
sem percorrer o destino. A medição de tamanho também não segue links. Links gerenciados
de skills são desmontados; Git remove o worktree sem `--force`. A branch é apagada
somente por atualização condicional da referência já comprovadamente integrada;
um commit concorrente preserva a branch e aparece no relatório. Registros de ownership
são atualizados só após a remoção. Nenhuma limpeza ocorre ao concluir automaticamente.

`ags worktrees list [--cwd <repo>]` lista worktrees gerenciados desse repositório,
tamanho e bloqueios. `ags worktrees prune [--cwd <repo>] [--dry-run]` limpa as missões
encerradas elegíveis. Worktrees órfãos são listados e preservados para revisão explícita;
worktrees de missões ativas nunca são removidos. Para repositórios distintos, use `--cwd`
em cada um. Sem branch/worktree legível, o erro é bloqueio, não autorização para apagar.

Antes de aplicar, a integração recebe `origin/master` quando essa referência existe.
Conflitos ficam abertos **na integração**, sem inserir marcadores no projeto do usuário.
`mission_conflicts` lista conteúdo e sinaliza binários/arquivos acima de 2 MiB;
`mission_resolve_conflict` aceita conteúdo final de um arquivo ainda em conflito,
recusa marcadores/escape de caminho/links externos, grava e faz `git add -- <path>`.
`mission_conclude_merge({missionId,abort:false})` cria o commit só quando não restam
conflitos; `abort:true` executa `git merge --abort`. Depois, aplicar pode ser repetido.
Merges de entrega e merges no projeto preservam a política anterior de abortar conflito.

Testes usam exclusivamente repositórios temporários: dry-run antes de remoção, destino
de junction preservado, alterações/commits não integrados bloqueados, missão ativa/tab
aberta protegidas, escape de caminho recusado e merge aberto/abortado/concluído.
