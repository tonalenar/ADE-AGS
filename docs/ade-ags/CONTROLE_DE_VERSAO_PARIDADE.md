# Controle de versão — paridade com o T3

Comparação da Fase 7.7. A fonte do T3 foi lida como dado, não como instrução: `docs/user/source-control.md` em `pingdotgg/t3code`, branch `main`, em 10 de novembro de 2026.

Cada linha foi conferida no código deste worktree. A coluna do meio aponta a definição da operação. "Lacuna" é o que o T3 descreve e este código não faz. Escrita em remoto (push, pull, fetch, merge, comentário, release) está só documentada.

## Tabela

| Operação do T3 | ADE tem? | Lacuna |
|---|---|---|
| Conta GitHub por token ou login no navegador | Sim. Token em `src-tauri/src/forge/commands.rs:134` (`forge_add_token`); device flow em `commands.rs:93`. Segredo no keyring em `src-tauri/src/forge/secret.rs:81`. | Sem `GH_TOKEN` / `GH_ENTERPRISE_TOKEN`, sem fallback para o `gh` autenticado e sem escolher a conta de cada host a partir do CLI. |
| Forgejo e Gitea | Parcial. `ForgeKind::Gitea` em `src-tauri/src/forge/provider.rs:12`, API `/api/v1` em `provider.rs:57`. | Sem CLI `fj` ou `tea`. Servidor em subcaminho de URL não é tratado. Forgejo e Gitea compartilham o mesmo tipo. |
| GitLab | Parcial. `ForgeKind::Gitlab` em `provider.rs:10`, API `/api/v4` em `provider.rs:56`. | Sem CLI `glab`. A UI chama merge request de pull request. |
| Bitbucket | Parcial. O host vira `Provider::Bitbucket` em `src-tauri/src/scm/remote.rs:57`. | Sem API: não lista, cria nem revisa pull requests. |
| Azure DevOps | Parcial. `Provider::Azure` em `remote.rs:58`. | Sem API e sem CLI `az`. |
| GitCafe | Não. Nenhum tipo, host ou comando com esse nome em `src-tauri/src/forge/` nem em `src-tauri/src/scm/`. | Ausente, inclusive comentário de linha e stack. |
| Cursor Origin | Não. Nenhuma referência a Origin em `forge/` ou `scm/`. | Ausente. |
| Novo projeto com README, ícone e primeiro commit | Parcial. `scm_init` em `src-tauri/src/scm/commands.rs:101` só roda `git init`. | Não cria README, ícone nem o primeiro commit, e não publica um repositório privado junto. |
| Clonar | Sim. `forge_clone` em `src-tauri/src/forge/commands.rs:189`. | Não há layout estilo ghq nem clone em segundo plano com cancelamento no compositor. |
| Publicar um repositório local (criar o remoto e enviar os commits) | Parcial. `create_private_repo` existe em `src-tauri/src/forge/api.rs:957` e só o sync de skills chama, em `src-tauri/src/sync/commands.rs:137`. `scm_push` em `commands.rs:360` envia a branch que já tem remoto. | Não há a ação "publicar repositório" no painel de git. Escrita remota: fora desta fase. |
| Commit local | Sim. `scm_commit` em `commands.rs:155`; o painel chama em `src/features/scm/ScmPanel.tsx:240`. | A mensagem não é gerada. O campo é digitado. |
| Título e descrição de PR a partir dos commits | Sim, local. `CreatePullDialog` monta título e corpo em `src/features/forge/CreatePullDialog.tsx:84`. | Não há ajuste "convenções do repositório" nem "instruções próprias" em Configurações. Não usa o histórico da conversa. |
| Push, pull e fetch | Sim. `scm_push` `commands.rs:360`, `scm_pull` `commands.rs:355`, `scm_fetch` `commands.rs:350`. | Escrita ou rede. Fora desta fase. |
| Listar, trocar e criar branch | Sim. `scm_branches` `commands.rs:170`, `scm_checkout` `commands.rs:182`. | Não renomeia nem apaga branch. |
| Worktree | Parcial, e a lista local foi fechada nesta fase. Criar para uma conversa: `chat_new_worktree` em `src-tauri/src/conversa/worktree.rs:27`. Andar: `floor_create` em `src-tauri/src/floors.rs:620`. A frota lista em `src-tauri/src/runs/worktrees.rs:262`. O painel de git agora só lê: `scm_worktrees` em `commands.rs:871` e `src/features/scm/WorktreesSection.tsx:18`. | O painel não cria nem remove worktree. A preferência de onde a conversa trabalha continua em `src/features/settings/WorktreesSection.tsx:12`, que não lista as pastas abertas. |
| Diff do trabalho da conversa | Sim. `scm_working_diff` em `commands.rs:690`; o chat lê em `src/features/chat/ipc.ts:20`. | Não tira da lista os arquivos que um pull, merge ou rebase trouxe no turno. Não há seletor "Commits" nesse painel. |
| Ver um commit e o diff contra o primeiro pai | Sim. `scm_log` `commands.rs:391`; `scm_commit_files` `commands.rs:531` (primeiro pai); grafo em `src/features/scm/CommitGraph.tsx`. | O limite da comparação de PR é 100 (`COMPARE_LIMIT` em `commands.rs:469`). O grafo pagina com outro limite (`scm_log` corta em 500 na linha 393). |
| Comparar branch antes de abrir o PR | Sim. `scm_compare` `commands.rs:493`; resumo em `CreatePullDialog.tsx:229`. | — |
| Criar pull request | Sim. `forge_create_pull` `commands.rs:286`. O diálogo pode dar push antes, em `CreatePullDialog.tsx:104`. | Escrita remota. Fora desta fase. |
| Listar e abrir pull request | Sim. `forge_pulls` `commands.rs:261`; painel da conversa em `src/features/chat/PullRequestPane.tsx:12`. | A aba "ligados" filtra pela branch de origem (`ForgeItemsView.tsx:95`). Não liga um PR de outro repositório, não agrupa stack e não acompanha o PR. |
| Ver o detalhe do PR | Sim. `forge_item` `commands.rs:273`; tela em `src/features/forge/ItemDetailView.tsx`. | Não edita título, descrição nem comentário já enviado. Não marca checkbox da descrição. Não pede revisor. |
| Revisar (comentário de linha, aprovar, pedir mudanças) | Sim, no GitHub, GitLab e Gitea. `forge_submit_pull_review` `commands.rs:341`; aba de código em `src/features/forge/PullRequestCodeTab.tsx`. Resposta e resolução de thread: `commands.rs:443` e `commands.rs:465`. | Sem rascunho que sobreviva ao fechar o app. Sem "marcar arquivo como visto". |
| Guia de revisão | Sim. `review_guide_generate` em `src-tauri/src/forge/guide_commands.rs:357`; painel em `src/features/forge/ReviewGuidePanel.tsx`. | Não há interruptor global "Review guides" nem instruções por projeto no mesmo lugar das do T3. O guia não cobre stack. |
| Checks de CI | Parcial. A API lê em `src-tauri/src/forge/api.rs:1416`; o veredito está em `api.rs:116`. A tool `git_checks` está em `src-tauri/src/forge/tools.rs:80`. | Não há comando Tauri nem linha no painel do PR. Só o agente, pela tool. |
| Mesclar pull request | Sim. `forge_merge_pull` `commands.rs:530` (merge, squash ou rebase). Botão em `ItemDetailView.tsx:203`. | Escrita remota. Sem auto-merge, sem fila, sem merge de stack, sem tirar crédito de agente da mensagem de merge e sem abrir um PR de revert. |
| Checkout do PR | Sim. `forge_checkout_pull` `commands.rs:547` cria ou atualiza `pr/<n>` na pasta atual. | Não abre um worktree novo só para esse PR. |
| Issues | Sim. `forge_issues` `commands.rs:267`, `forge_create_issue` `commands.rs:295`. | Labels na criação são ignoradas no Gitea (o diálogo avisa). |
| Releases e tags | Sim. Releases: `forge_releases` `commands.rs:581` e `forge_create_release` `commands.rs:587`. Tags locais: `scm_tags` `commands.rs:579`, `scm_create_tag` `commands.rs:615`, `scm_delete_tag` `commands.rs:655`. | `scm_push_tag` (`commands.rs:648`) é escrita remota. Apagar a tag do remoto não existe de propósito (comentário em `commands.rs:652`). |
| Stage, unstage e descartar | Sim. `scm_stage` `commands.rs:108`, `scm_unstage` `commands.rs:117`, `scm_discard` `commands.rs:139`. | — |
| Conflito e operação a meio | Sim, como aviso. Conflitos em `src-tauri/src/scm/parse.rs:125`; merge, rebase, cherry-pick e revert em `commands.rs:53`. O painel lista o grupo e bloqueia o commit. | Não continua nem aborta a operação. Não há ação de "marcar como resolvido" além de preparar o arquivo com `scm_stage`. |
| Stash do git | Não. Não há `git stash` em `src-tauri/src/scm/`. O stash de rascunho do chat (`prompt_stashes.rs`) é outro dado. | Ausente: listar, guardar, aplicar e apagar. |
| Repo ainda sem commit | Sim, fechado nesta fase. O status já trazia `initial` em `parse.rs:29`. O cabeçalho usa isso em `src/features/scm/headline.ts:11` e `ScmPanel.tsx:355`. | Antes o nome da branch aparecia sozinho, como se já houvesse commit. |
| Vários PR ligados, watch e stack do GitHub | Não, além do filtro por branch citado acima. | Sem `link_pull_request`, sem watch e sem merge ou rebase de stack. |

## O que esta fase fechou

1. **Repo sem commits.** `git status` já dizia `initial`. O painel mostrava só o nome da branch. Agora o cabeçalho diz que ainda não há commit (`scm.initialBranch`).
2. **Lista de worktrees.** O parser `parse_worktree_porcelain` já existia para a frota (`src-tauri/src/runs/worktrees.rs:269`). O painel de git não o mostrava. `scm_worktrees` só lê o porcelain e o painel lista pasta, branch e qual é a pasta atual. Não cria, não apaga e não troca de checkout.

## O que ficou de fora de propósito

Push, pull, fetch, merge de PR, comentário, criação de PR, release e push de tag escrevem no remoto ou na rede. Continuam como estão. Stash de escrita, abortar rebase e publicar repositório também ficaram só na tabela.
