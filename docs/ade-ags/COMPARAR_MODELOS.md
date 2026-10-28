# Comparar modelos

O mesmo pedido para vários agentes/modelos ao mesmo tempo, cada um no seu worktree e na sua branch. No fim você vê o que cada um mudou e escolhe qual manter. Inspirado no "send to multiple models" do T3 Code.

## Como usar

1. Abra **Comparar modelos** pelo botão da barra do canvas (ícone de dois painéis, no fim da barra) ou pela paleta (Ctrl+K → "Comparar modelos…").
2. Preencha:
   - **Pasta do projeto**: precisa ser um repositório git com pelo menos um commit para isolar. O diálogo mostra a branch e o commit de onde os worktrees saem, e quantas mudanças sem commit **não** entram.
   - **Pedido**: o texto que todos recebem.
   - **Nome** (opcional): sai da primeira linha do pedido.
   - **Isolar** (padrão ligado). Desligado, todos usam a mesma pasta: só para perguntas de leitura (o diálogo e o próprio pedido avisam).
   - **Modelos**: de 2 a 6. Cada linha tem agente, modelo, esforço e, no Codex, Fast: o mesmo `ModelSelector` dos Squads.
3. **Iniciar comparação** cria os worktrees e abre um terminal por modelo num canvas próprio, lado a lado sob o rótulo "Comparação: <nome>". Cada terminal recebe o pedido quando a TUI fica pronta.

Cada modelo gasta tokens da própria conta: N modelos custam N vezes.

## O que acontece por baixo

| Passo | Onde |
|---|---|
| Validação (2–6, agentes instalados, sem duplicado, repo se isolar) antes de qualquer efeito | `src/features/compare/model.ts::draftProblem`, `src-tauri/src/compare/model.rs::validate_picks` |
| Um worktree por modelo em `~/.ags/worktrees/<8hex>` (ou a pasta de `ADE_AGS_DATA_DIR`), branch `cmp/<slug>-<id>/<pick>`, a partir do `HEAD` da pasta | `compare/commands.rs::prepare_in`, `runs/worktrees.rs::create_named` |
| Base gravada na branch (`branch.<b>.agsbase`), como nas missões | `runs/worktrees.rs::record_base` |
| Setup igual ao das missões: junção de `node_modules`, `CARGO_TARGET_DIR` compartilhado, confiança da pasta no Claude Code | `compare/commands.rs::setup_for` |
| Falha em um worktree desfaz os já criados (limpos) | `prepare_in` |
| Registro em `<ags_home>/comparisons.json` | `compare/model.rs` |
| Abas com o mesmo comando das missões em terminais (`withAutonomy` + `withModel`) | `src/features/compare/start.ts` |
| Canvas `<pasta>#cmp:<id>`: nós lado a lado (até 3 por linha), rótulo de cada nó = agente · modelo · esforço | `src/features/compare/layout.ts`, `canvas/store.ts::compareBoardKey` |
| Entrega do pedido por `sendWhenReady` (o caminho dos briefings). Claude Code recebe as quebras de linha; as outras TUIs, uma linha com ` \| ` | `model.ts::promptFor` |

O pedido vai com uma linha de contexto: com isolamento, a pasta e a branch do agente e "não faça push nem abra PR"; sem isolamento, "pedido só de leitura".

## A barra da comparação

No canto superior esquerdo do canvas da comparação:

- o estado de cada terminal: **iniciando** (o pedido ainda não foi colado), **trabalhando** (saída nos últimos 3 s), **parado** ou **fechado**;
- quando um para, o que ele mudou contra a base: arquivos (rastreados + novos), `+linhas −linhas` e commits (`compare_status`);
- **Ver diff**: `git diff <base>` do worktree (até 512 KiB), o `--stat` e a lista de arquivos novos;
- **Manter este**, **Descartar todos** e, depois de manter um, **Encerrar**.

## Limpeza: nunca apaga trabalho sem confirmação

| Ação | O que faz |
|---|---|
| Manter este | Marca o escolhido. Os outros saem pelo mesmo fluxo de "Descartar". |
| Descartar todos | Ensaia (`dryRun`). Quem está limpo e sem commits sai direto. Quem tem mudanças sem commit ou commits próprios aparece numa segunda confirmação com a lista. |
| Descartar confirmado | Fecha os terminais, desfaz os links do app, commita o que estava sem commit, guarda a ponta da branch em `refs/ags/descartes/<id>/<pick>` e só então remove worktree e branch. Recuperar: `git branch <nome> refs/ags/descartes/<id>/<pick>`. |
| Encerrar (o mantido) | Fecha o terminal e remove o worktree. A **branch fica**. Com mudanças sem commit, pede para commitá-las na branch antes. |
| Sem isolamento | Encerrar só fecha os terminais e esquece a comparação. A pasta não é tocada. |

Travas que nenhuma confirmação desfaz: worktree fora da pasta de worktrees do app, branch que não começa com `cmp/`, worktree numa branch diferente da registrada. Não há `--force` em nenhum `git worktree remove`: o descarte commita antes, e a remoção sai limpa. A branch sai por CAS (`update-ref -d <ref> <sha inspecionado>`): um commit feito no meio do caminho a preserva.

## Comandos Tauri

`compare_check`, `compare_prepare`, `compare_attach`, `compare_list`, `compare_status`, `compare_diff`, `compare_keep`, `compare_remove`, `compare_finish` (`src-tauri/src/compare/commands.rs`; wrappers em `src/features/compare/ipc.ts`). Não há comando `ags` para isso.

## Mudanças laterais

- `withModel` passa `--model` ao OpenCode (antes o modelo escolhido para ele era ignorado nos terminais, inclusive nos de missão).
- `runs/worktrees.rs::add_worktree`: se o `worktree add -b` falha porque a branch já existia, a limpeza não apaga mais essa branch.

## Testes

- Rust (`cargo test --lib compare::`): nomes, validação, numstat, criação em repositório temporário, desfazer em falha, status/diff, remoção sem confirmação, descarte com ref recuperável e junção preservada, trava de caminho, manter + encerrar.
- Front (`bunx vitest run src/features/compare`): slug/rótulo/título, validação, texto por TUI, estados, resumo, limpeza, layout e chave do canvas.

## Não verificado

- O fluxo inteiro no app (abrir as TUIs, colar o pedido, a barra ao vivo, fechar e remover com os terminais recém-fechados no Windows): não medido.
- O diálogo "confia nesta pasta?" de outras TUIs além do Claude Code num worktree novo.

## Limites conhecidos

- Os worktrees saem do último commit: mudanças sem commit da pasta não entram (o diálogo avisa a contagem).
- "Manter" não faz merge: a branch fica para você juntar.
- O estado "iniciando" vive só na memória: depois de reiniciar o app, os terminais aparecem como trabalhando ou parados.
- Sem conta por modelo: cada agente usa a conta padrão da TUI.
