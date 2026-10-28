# Pontos de restauração das abas (checkpoints por mensagem)

Cada mensagem que chega a um agente numa aba interativa deixa uma foto dos arquivos da pasta da aba. Com ela dá para ver o que mudou desde aquela mensagem ("Ver diff desde aqui") e voltar os arquivos até ali ("Voltar até aqui").

Inspirado nos checkpoints por turno do T3 Code (commit com índice temporário em ref escondida). Diferente dos checkpoints da frota (`runs/checkpoints.rs`), que movem o `HEAD` ao restaurar: aqui a branch e o `HEAD` nunca mudam.

## O que é um ponto

| Parte | Onde |
|---|---|
| Conteúdo | um commit git feito com índice temporário (`GIT_INDEX_FILE`), pai = `HEAD` do momento (sem pai num repositório sem commits) |
| Ref | `refs/ags/checkpoints/<aba>/<n>` (o id da aba vira só `[A-Za-z0-9_-]`) |
| Ficha | tabela `tab_checkpoints` no SQLite: quando (ms), tipo, quem mandou, a primeira linha da mensagem (até 140 caracteres), raiz do repo, ref, commit, árvore, `HEAD` |

- A mensagem do commit é genérica (`ags checkpoint <aba> #<n>`). O texto da pessoa fica só no banco local: não vai para o repositório nem para a linha de comando (que aparece no log do `util::spawn`).
- A foto cobre o **repositório inteiro** (a raiz do `git rev-parse --show-toplevel`), mesmo que a aba esteja numa subpasta.
- Entra o versionado e o novo não ignorado; o ignorado (`.gitignore`) nunca entra nem é tocado.
- O índice temporário começa como **cópia** do índice da pessoa: o `git add -A` só relê o que mudou, e as entradas `skip-worktree` (sparse checkout) não somem. Se a cópia falhar, começa do `HEAD`.
- O commit usa `--no-gpg-sign` (com `commit.gpgSign` ligado, cada mensagem abriria o pedido de senha da chave). Não roda hooks.
- `git push` comum (heads e tags) não leva `refs/ags/*`. Um `git push --mirror` levaria.

Tipos: `message` (antes de uma mensagem), `manual` ("Marcar ponto"), `safety` (o estado de logo antes de uma restauração).

## Quando um ponto é tirado

| Caminho | Onde | Autor |
|---|---|---|
| `peer tell/ask`, fila de mensagens entre agentes, `ags tab send`, `tab create --initprompt`, chat do canvas, rotinas | `submit_prompt_seen` (`ipc/commands/tabs.rs`), antes de escrever no PTY | `peer`, `chat`, `rotina`, `ags` |
| Enter no terminal de uma aba de agente (a pessoa digitou, ou o app colou: briefing de missão, navegador, trecho) | `onPromptSubmitted` (`terminal/terminalRegistry.ts`) → `useTabCheckpointsCapture` | `pessoa` ou `ade` |
| "Marcar ponto" (menu da aba ou diálogo) | `tab_checkpoint_create` | `pessoa` |

Regras do automático:
- **Em segundo plano**: nunca atrasa nem quebra o envio. Erro vai para o log (`[tab-checkpoints]`).
- **Sem mudança desde o último ponto da aba** (mesma árvore), não cria outro.
- **Uma foto por vez por repositório** (trava por raiz) e uma por vez por aba (um segundo Enter durante a foto é ignorado).
- No terminal: só abas de agente (a terminal pelada não), Enter com texto na caixa (caixa vazia não conta) e no máximo um a cada 4 s por aba (o reenvio do Enter do app não vira outro).
- Pasta que não é repositório git (ou sem git instalado): nada.
- Desligável: `settings.tab_checkpoints_auto = "0"` (o interruptor "Automático a cada mensagem" no diálogo). O "Marcar ponto" funciona sempre.

O rótulo do Enter da pessoa sai da caixa de entrada da TUI no instante do Enter (as 3 linhas antes do cursor, sem bordas nem o sinal do prompt). Num menu de permissão ("❯ 1. Yes") o rótulo é a opção; o ponto só nasce se algo mudou.

## Voltar até aqui

1. Confirmação: diz a pasta, que a branch/commits/índice não mudam e que **a conversa do agente não volta**.
2. **Trava de pasta compartilhada**: se outra aba com terminal vivo (de qualquer janela) ou uma tarefa da frota `running`/`ready` usa a mesma pasta, uma de dentro ou uma que a contém, nada é feito e o diálogo lista quem é. A pessoa pode forçar ("Voltar mesmo assim").
3. **Ponto de segurança** do estado de agora (sempre, mesmo sem mudança). Se algum arquivo está travado por outro programa e não dá para lê-lo, a restauração **recusa** sem mexer em nada (sem o conteúdo de agora, desfazer o voltaria a uma versão velha).
4. Restauração: `git diff-tree` entre a árvore de segurança e a do ponto; o que difere é escrito com `checkout-index` num índice temporário, e o que nasceu depois é apagado (pastas que ficam vazias saem). Submódulos não são tocados. O índice, a branch, o `HEAD` e o stash da pessoa não mudam.
5. Arquivo que não deu para escrever ou apagar (travado) não para o resto: entra na lista de falhas mostrada na tela.
6. Para desfazer: voltar ao ponto de segurança (`#n`, mostrado no aviso).

Depois de voltar, os arquivos aparecem como mudanças sem commit em relação ao `HEAD`. Avise o agente: ele não sabe que os arquivos voltaram.

## Limpeza

- No máximo **50 pontos por aba**: ao criar o 51º, o mais velho sai (ficha e ref).
- **Aba fechada de vez**: `tab_checkpoints_prune` apaga os pontos das abas que não estão em `tabs` (salvas) nem têm terminal vivo e cujo ponto mais novo tem mais de 10 min. Roda 90 s depois de abrir o app, a cada 30 min e 11 min depois de fechar uma aba.
- "Apagar todos" no diálogo apaga os pontos daquela aba.
- Soltar a ref deixa o commit como lixo que o `git gc` da pessoa recolhe quando quiser.

## Windows

- Todo git roda com `-c core.longpaths=true -c core.safecrlf=false -c core.quotepath=false`, `GIT_OPTIONAL_LOCKS=0`, sem `GIT_DIR`/`GIT_INDEX_FILE` herdados, com prazo (`util::spawn`) e caminho por `external_path`.
- `core.autocrlf`: a foto guarda o conteúdo normalizado (como um `git add`); voltar escreve com a conversão do repositório (como um `git checkout`). Um arquivo que estava com LF num repositório `autocrlf=true` volta com CRLF; o `git status` pode listá-lo como modificado até o próximo `git add`, com o mesmo conteúdo no git.
- Arquivo travado: na foto automática fica como estava no índice (o resto entra); na restauração, ver os passos 3 e 5.
- Muitos caminhos: o `checkout-index` vai em lotes de até ~8 KB de argumentos.

## Código

| Parte | Arquivo |
|---|---|
| git (foto, ref, restaurar, diff) | `src-tauri/src/tab_checkpoints/git.rs` |
| trava de pasta (pura) | `src-tauri/src/tab_checkpoints/lock.rs` |
| fichas e migração | `src-tauri/src/tab_checkpoints/store.rs` (chamada no fim de `database/schema.rs`, sem subir `user_version`) |
| tirar, comparar, voltar, limpar | `src-tauri/src/tab_checkpoints/service.rs` |
| comandos Tauri e o gancho do envio | `src-tauri/src/tab_checkpoints/commands.rs` |
| pasta de cada PTY vivo | `terminal/pty_manager.rs` (`tab_and_cwd_of`, `live_tab_dirs`) |
| Enter e o colado do app | `src/features/terminal/terminalRegistry.ts` |
| captura e limpeza na casca | `src/features/tabCheckpoints/useTabCheckpointsCapture.ts` |
| diálogo | `src/features/tabCheckpoints/CheckpointsDialog.tsx` (aberto pelo menu da aba em `tabs/tabActions.tsx`) |
| lógica pura da tela | `src/features/tabCheckpoints/model.ts` |

Comandos: `tab_checkpoint_auto`, `tab_checkpoint_create`, `tab_checkpoints_list`, `tab_checkpoint_diff`, `tab_checkpoint_restore` (`force`), `tab_checkpoints_delete`, `tab_checkpoints_prune`. Evento: `cc-tab-checkpoints-changed` (`{ tabId }`).

## Testes

- Rust (`tab_checkpoints/test.rs`, repositórios temporários): a foto não toca índice, branch, stash nem arquivos; sem mudança não cria; repositório sem commit; subpasta; `autocrlf` + `safecrlf`; voltar e desfazer; índice preservado; recusa com outra aba e forçar; foto sumida; teto de 50 com refs soltas; apagar e limpar órfãs; migração idempotente; trava de pasta; arquivo travado (só no Windows).
- Front: `tabCheckpoints/tests/model.test.ts` e `terminal/tests/promptSubmitted.test.ts`.

## Não verificado

- No app de verdade (não foi aberto): o rótulo tirado da caixa de entrada em cada TUI, o diálogo, e o tempo da foto num repositório grande.
- O ponto é tirado em paralelo com o envio: se o agente escrever arquivos antes de a foto terminar (menos de 1 s num repositório médio), a foto pode já pegar parte disso.
