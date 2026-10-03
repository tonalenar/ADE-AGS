# Checkpoints e rollback de run

Item "Checkpoints, rollback e replay de missão" da [auditoria v2](./AUDITORIA_2026-10-02_v2.md).

## O que é

Uma **foto** do trabalho antes e depois de cada tarefa de um run, e a possibilidade de **voltar a antes de uma tarefa** (rollback) e deixá-la na fila para rodar de novo (replay).

- Antes de a tarefa arrancar (`before`) e quando termina (`after`), `supervisor.rs` chama `checkpoints::auto`. O líder (que só planeja) não gera fotos. Se a foto falha (sem git, sem commits, repositório enorme), a tarefa corre igual: nunca bloqueia nada.
- Além dessas, há fotos `manual` (botão "Guardar ponto agora") e `safety` (a que se tira antes de qualquer restauração).

## A foto

Um commit de git feito "por fora": índice temporário (`GIT_INDEX_FILE`), `add -A` (respeita `.gitignore`), `write-tree`, `commit-tree` com o `HEAD` de então como pai, e uma ref própria `refs/controlcode/checkpoints/<id>` para o `git gc` não a levar. **Não toca** o índice, a branch nem a árvore de trabalho. Guarda cambios sem commitear e arquivos novos.

Tabela `run_checkpoints` (schema v25, aditiva): `run_id`, `task_id`, `kind`, `dir` (raiz do repo ou worktree), `commit_sha`, `head_sha`, `label`, `created_at`. No máximo 200 por run.

## Restaurar

`HEAD` ao do momento da foto, árvore de trabalho ao seu conteúdo, e some o que nasceu depois (sem tocar no ignorado). Os cambios ficam como sem commitear. Se a foto ou o commit já não existem (um `gc` agressivo), falha **sem tocar em nada**.

## Rollback de uma tarefa

Volta ao `before` da tarefa e deixa na fila (`pending`, sessão e resultado limpos): ela, **o que depende dela** (transitivamente) e **o que correu depois na mesma pasta** (a restauração tira o chão). O que trabalha em seu próprio worktree e não depende dela não se mexe. Com algo rodando, se recusa. O líder nunca se refaz (duplicaria o plano).

Antes de restaurar cada pasta tira-se uma foto `safety`: o rollback não perde nada, e na própria janela se vê a lista para restaurá-las. Tudo se valida e fotografa **antes** de tocar: se algo falha, não fica pela metade.

Os `facts` das tarefas refeitas ficam no run (são append-only por desenho).

## Onde

- Backend: `runs/checkpoints.rs` (planejamento puro `plan`, `snapshot`/`restore`, comandos de Tauri `run_checkpoints`, `run_rollback_preview`, `run_rollback`, `run_checkpoint_create`, `run_restore_checkpoint`).
- Interface: botão **voltar atrás** no cartão da tarefa (Frota) → `RollbackDialog`.
- Sem comando de CLI de propósito: é destrutivo, fica na mão da pessoa.

## Limites

- A foto é de uma pasta com git. Repositórios gigantes ou com muito arquivo não ignorado tornam o `add -A` lento (limite de 120 s; falha sem quebrar a tarefa).
- Restaurar a pasta do projeto (tarefa sem worktree isolado) move o `HEAD` da branch do usuário para trás; os commits seguem no reflog e na foto de segurança.
- Não restaura estado de fora do git (bancos, caches, arquivos ignorados).
