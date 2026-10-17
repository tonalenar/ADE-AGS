# Auditoria 2026-10-17 (parte 2) — performance do app e computer use com o Jev

Só leitura. Os números saíram de:
- um build do Vite numa pasta temporária, com medição do tamanho de cada módulo;
- `~/.ags`, lido sem escrever;
- `data.db` aberto em modo somente leitura;
- os relatórios de bench em `docs/ade-ags/bench/`.

Cada achado foi conferido no código (arquivo:linha).

## Resumo

| Área | Situação | Maior alavanca |
|---|---|---|
| Carregamento (frontend) | O arquivo principal (entry) tem **1,64 MB** (489 KB gzip). Com o React e o CSS, são ~2,3 MB parseados antes da primeira tela. | As traduções dos 3 idiomas são **35% do entry**. Markdown, sweetalert2 e o piloto do navegador também entram sem precisar. |
| Custo contínuo (frontend) | O título das conversas é relido a cada 20 s, lendo o transcript inteiro. O TeamFeed reprocessa todo o markdown a cada render. Todas as terminais re-renderizam a cada quadro do paneo do canvas. | `memo` e paradas com a janela oculta. |
| Custo contínuo (backend) | O pet relê **764 MB de transcripts** na primeira passada e repete a cada 60 s. O `scrollback_of` copia 3,5 MB para olhar só o fim. O lock global do SQLite fica preso durante git e varreduras de disco. | Leitura incremental, `tail_bytes` e soltar o lock antes de IO. |
| Disco | **~33 GB recuperáveis**: 18,5 GB de `incremental/` do cargo, 14,5 GB de worktrees (23 delas não podiam ser limpas) e 390 MB de backups manuais. O banco tem 51% de páginas livres. | `CARGO_INCREMENTAL=0` para os agentes, limpar `target/` de missão encerrada e `VACUUM`. |
| Binário | Sem `[profile.release]`: 40,2 MB. `ags.exe` e `ccode.exe` são cópias idênticas. Há 62 crates com mais de uma versão (duas de `reqwest`). | `lto="thin"`, `codegen-units=1`, `strip`. |
| Jev: acerto | O bench dá 54/54 locais e 16/16 públicas, com 0 falso feito. **Mas:** o bench não limpa o site entre rodadas (o P03/P04 nunca testou "adicionar ao carrinho"); 29% dos cliques saíram com p < 0,9; "done" é aceito com qualquer p. | Corrigir a medição antes de mexer nas regras. |
| Jev: velocidade | Locais levam 129 s: 46% ação, 34% Jev, 20% espera fixa. 34–36% das consultas só confirmam "acabou?". Há uma espera fixa de ~470 ms em cada `act`. | Tirar a espera quando nada está em voo e confirmar o fim por `--expect`, que juntos dão ~40% de folga. |

## 1. Performance do frontend

O que já está bom e não se mexe:
- chunks e rotas carregados sob demanda;
- `LazyTerminal`, e WebGL só nas terminais visíveis;
- terminal oculta para de desenhar;
- leitura do PTY em blocos de 64 KB;
- timers compartilhados;
- todo `listen()` tem limpeza.

### Ganhos rápidos

1. **Só o idioma ativo no boot.** `src/i18n/index.ts:3-5` importa os 3 JSON de forma estática. Proposta: `import()` do idioma ativo e do `en` de fallback. Ganho: **~380 KB** do entry, 23%.
2. **Markdown sob demanda.** `react-markdown` e `remark-gfm` entram por `UpdateNotifier.tsx:7` e `SkillPalette.tsx:7`. Ganho: ~156 KB.
3. **sweetalert2 sob demanda.** Entra pelo `AlertaToast` do neogestify. Ganho: ~79 KB.
4. **Piloto do navegador e painel do bot sob demanda.** `cliBridge.ts:10` puxa `agentBridge` e `jevPilot`; `AppShell.tsx:38` monta o `BotPanel` de forma estática.
   - Somando os itens 1 a 4, o entry cai de **1,64 para ~0,9 MB**.
5. **Títulos de conversa a cada 20 s.**
   - `ConversationList.tsx:150-170` chama `session_title` para cada aba aberta.
   - No Rust, `title.rs:338` faz `read_to_string` do transcript inteiro, que pode ter vários MB.
   - Não para com a janela oculta.
   - Proposta: só com a janela visível, só se a aba teve saída nova, e cache por (caminho, mtime, tamanho).
6. **TeamFeed.**
   - `ChatMarkdown.tsx:75` não usa `memo` e recria os plugins a cada render.
   - `TeamFeed.tsx:269` renderiza todos os itens.
   - Proposta: `memo`, plugins como constantes do módulo, e só os últimos ~150 itens.
7. **Terminais.** `Terminal` não usa `memo` e recebe callbacks inline (`TerminalPanel.tsx:94-104`). O paneo do canvas (`CanvasView.tsx:219-232`) re-renderiza as N terminais a cada quadro.
8. **Blur sobre fundo opaco.**
   - `backdrop-blur-xl` em `ActivityRail.tsx:131`, `SideHead.tsx:82`, `StatusBar.tsx:72` e `TabBar.tsx:83`, sem efeito visual, com animações dentro.
   - No canvas, blur de 30 px sobre as terminais vivas (`CanvasDock.tsx:66`, `CanvasToolbar.tsx:57`).
9. **Mascote sempre animado.**
   - O `PetCard` (`Pet.tsx:327`) tem animações infinitas e um `feGaussianBlur`, o que faz repintar o tempo todo.
   - `cursorLook.ts:46-63` chama `getBoundingClientRect` a cada movimento do mouse.
   - Proposta: `still` quando ocioso, como a StatusBar já faz.
10. **Prévias do canvas.** Há um intervalo de 1,5 s por nó, com `setLines` sempre (`CanvasView.tsx:963, 993-998`). Proposta: um relógio só, comparar antes de setar, pausar fora da tela.

### Estrutural

- **A. neogestify-ui-components.** O `@source` em `App.css:8` gera classes de toda a biblioteca, provavelmente inflando o CSS de 298 KB.
- **B. PTY.** `tauri::ipc::Channel` com bytes, no lugar de um evento JSON por pedaço.
- **C. Canvas.** Viewport não controlado e um único transform no contêiner.
- **D. Scrollback.** 5.000 linhas são ~12 MB por terminal; para TUIs, avaliar 2.000–3.000.
- **E. Explorer.** A árvore não é virtualizada.
- **F. Janela minimizada.** Confirmar se o WebView2 marca `document.hidden` ao minimizar; se não marcar, usar os eventos de janela do Tauri.

## 2. Performance do backend

### Ganhos rápidos

1. **Disco (~33 GB).**
   - `cargo-target-agents` tem 24,4 GB, dos quais **18,5 GB são `debug/incremental`**: 52 cópias de ~1,1 GB, uma por caminho de worktree, que não se reaproveitam. Proposta: `CARGO_INCREMENTAL=0` junto do `CARGO_TARGET_DIR` dos agentes (`floors.rs:120, 263-276`) e uma faxina de `incremental/`.
   - Worktrees: 71 pastas, 14,5 GB. **Bug, corrigido nesta onda:** `missions/cleanup.rs:242, 367` não aceitavam `done_without_delivery`, então 23 worktrees nunca podiam ser limpas. Proposta seguinte: apagar `target/` e `node_modules` reais de missão encerrada.
   - Backups: 293 MB de `data.db.antes-*` e `*.bak` manuais, mais 97,8 MB em `backups/`. Os 5 `data.vNN-*.backup` do app (`connection.rs:177`) nunca são rotacionados; manter os 2 últimos.
2. **Banco com 51% livre** (13,7 de 27 MB).
   - A causa é a coluna `tabs.scrollback`: 5,75 MB em 13 linhas, regravada a cada 20 s.
   - Proposta: `VACUUM` quando a fração livre passar de 30%, `auto_vacuum=INCREMENTAL` e `PRAGMA optimize` ao fechar.
3. **Lock global do SQLite durante IO.**
   - `mission_cleanup` (`cleanup.rs:304`), `ags worktrees list/prune` (`ipc/commands/missions.rs:502, 509`) e `conflicts.rs:124-168` seguram o `Mutex<Connection>` durante git e varreduras de GBs.
   - Enquanto isso, o autosave, o IPC e o Vigia param.
   - Proposta: ler as linhas, soltar o lock, rodar o git e reabrir o lock só para gravar.
4. **Pet.**
   - `pet.rs:128` chama, a cada 60 s, o `agent_account_usage` completo.
   - A primeira passada lê **269 JSONL, 764 MB**, com `read_to_end`; o maior tem 143 MB.
   - Proposta: `BufReader` linha a linha, somar só o delta de offset, rodar a cada 10 min e pular quando a janela está minimizada.
5. **`scrollback_of`** (`pty_manager.rs:864`).
   - Clona até 3,5 MB com o lock `PTY_BUFFERS`, que também bloqueia os leitores de PTY.
   - Quem chama só quer de 4 a 64 KB: `peers.rs:228`, que repete a cada 250 ms; `tabs.rs:354`; `vigia.rs:35`.
   - Proposta: `tail_bytes(id, n)`.
6. **Perfil de release.**
   - Proposta: `lto="thin"`, `codegen-units=1`, `strip=true`. **Não** usar `panic="abort"`: o código se recupera de mutex envenenado em 113 pontos.
   - `ags.exe` e `ccode.exe` podem ser um só arquivo (hardlink ou shim).

### Estrutural

- **7. Scrollback persistido pelo Rust.** Gravar só os ~512 KB finais, comprimidos com `flate2`, fora de `tabs`. Hoje são ~15 MB a cada 20 s, ida e volta pelo webview.
- **8. Saída do PTY em lote.** Janelas de ~16 ms com `Channel`.
- **9. Flags do WebView.** `tauri.conf.json:23` desliga o estrangulamento em segundo plano (`--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`), então todos os polls rodam a todo vapor com a janela minimizada. Proposta: tirar as flags ou checar `document.hidden` nos polls que não são de terminal.
- **10. Duplicatas de crates.** O app usa `reqwest` 0.12 e o Tauri usa 0.13; subir o app para 0.13 tira uma pilha HTTP do binário.

### Verificado e sem gargalo

- As migrações a cada abertura custam ~8 ms.
- WAL, handshakes, rotinas, notifier e watchdog são baratos.
- As consultas quentes têm índice.
- Os PRAGMAs estão certos.

## 3. Computer use com o Jev

### Estado medido

Fonte: `docs/ade-ags/bench/v2-final6-depois-real-*.json` e as rodadas `final2…6`, 326 rodadas no total.
- Locais: 54/54. Públicas: 16/16.
- Falso feito, violações e travamentos: 0.
- Passo: p50 486 ms, p95 1.635 ms. Consulta ao Jev: p50 306 ms.
- Foto: 1,0 a 1,5 s cada.

### Onde ainda erra (ou passa por sorte)

- **O bench não limpa o estado do site.** `scripts/jev-bench.ts:237` só navega. Desde a `final3`, **0 de 32** rodadas do P03/P04 clicaram em "Add to cart": a mochila já estava no carrinho. O 16/16 mede outra tarefa.
- **Decisões perto do piso.**
  - 29% dos cliques (120 de 412) saíram com p < 0,9.
  - O comentário em `jevPilot.ts:545` dá acertos entre 0,43 e 0,56 e erros entre 0,20 e 0,32: a folga é de ~0,1.
  - Cada correção até aqui abriu uma janela de p (`MIN_ADVANCE` em `:554`, `cartAdvance` em `:579`), o que não generaliza.
- **"done" aceito com qualquer p.** `lowP` exclui "done" (`jevPilot.ts:1209`). Depois de uma ação do Jev, só o `goalContradiction` (`:1219-1229`) segura, e ele cobre apenas carrinho e página de erro.
  - O L16 concluiu com p entre 0,42 e 0,57.
  - O P02 deu falso feito com p entre 0,83 e 0,86, pego só porque havia `--expect`.
- **Foto.** 18 de 29 foram úteis (~62%). O log não registra qual alvo o texto tinha escolhido (`jevPilot.ts:1211`).
- **Laço.** Só a mesma ação seguida conta como laço (`jevPilot.ts:1239-1247`); um ciclo A→B→A→B gasta o orçamento.

### Onde gasta tempo

Locais: 129 s no total, sendo 59 s de ação, 44 s de Jev e 26 s de outros.
- **"Outros" é uma espera fixa de ~470 ms por `act`.** `verifyAct` roda `wait idle` (`agentBridge.ts:756`), que exige 400 ms de rede quieta (`page/runtime.ts:1467`) mesmo sem nenhum pedido em voo.
- **Consultas só para confirmar o fim.** São 34–36% delas. O piloto não recebe os `--expect` (`agentBridge.ts:711`), que poderiam confirmar por código.
- **Formulários em série.** Cada campo espera ≥ 100 ms (`runtime.ts:1081`).
- **Reveal da foto.** Espera fixa de 450 ms (`BrowserTab.tsx:364`).
- **Sem cache por `state_hash`** (`decisions/browse.rs:350`).

### Como medir "99,99%" de verdade

**Realismo primeiro:** provar 99,99% exige ~30.000 rodadas seguidas sem nenhuma falha; 99,99999% exige ~30 milhões. Não é mensurável com o bench.

**O que os números atuais garantem:** o 54/54 vem de 27 páginas determinísticas rodadas 2 vezes, então a amostra efetiva é ~27. Pela regra de três, o limite inferior (95%) fica em ≈ 89% nas locais e ≈ 81% nas públicas.

**Meta defensável:**
- Erro silencioso (falso feito + violação) ≤ 0,1%, com intervalo de confiança.
- Sucesso ≥ 98% em tarefas **nunca vistas**, com limite inferior de Wilson ≥ 97%.

**Protocolo:**
- (a) Limpar o estado a cada rodada: cookies, localStorage e livro-razão.
- (b) Regras congeladas e um conjunto de teste separado: ~100 tarefas geradas por semente, variando rótulos, ordem, idioma, atrasos e ícones, que nunca servem para ajustar regra.
- (c) ~300 rodadas no conjunto de teste: 0 a 1 falha dá ≥ 99% com IC ≥ 98%.
- (d) Bench de decisão por replay dos estados gravados, para medir a precisão por passo a custo baixo.
- (e) Parada sequencial (SPRT).
- (f) Wilson por classe de erro no relatório.

## 4. Plano proposto

### Onda P1 — performance, ganhos rápidos

| # | Mudança | Ganho |
|---|---|---|
| P1 | Idioma ativo, markdown, sweetalert2, piloto e bot sob demanda | Entry de 1,64 MB para ~0,9 MB |
| P2 | Títulos de conversa: visível, só com saída nova, cache por mtime no Rust | Fim da releitura de MBs a cada 20 s |
| P3 | Pet: leitura incremental, 10 min, pausa minimizado | Fim dos 764 MB lidos |
| P4 | `tail_bytes` no lugar de `scrollback_of` | Fim de cópias de 3,5 MB a cada 250 ms |
| P5 | Soltar o lock do SQLite antes de git e IO na limpeza e nos conflitos | Fim das travas do app |
| P6 | `CARGO_INCREMENTAL=0` para os agentes; limpar `target/` de missão encerrada; rotacionar backups; `VACUUM` com folga | ~33 GB e −13 MB no banco |
| P7 | `[profile.release]` com thin LTO, `codegen-units=1` e strip | Binário menor e mais rápido |
| P8 | `memo` em TeamFeed, ChatMarkdown e Terminal; mascote parado ocioso; blur trocado por cor opaca | Fluidez com missão rodando |

### Onda J1 — Jev, medição antes de regra

| # | Mudança | Ganho |
|---|---|---|
| J1 | Bench limpa o estado por rodada; P03/P04 com carrinho vazio | Mede de fato o "adicionar" (os números devem cair) |
| J2 | Conjunto de teste por semente, protocolo de ~300 rodadas com Wilson e SPRT | Acerto real com intervalo de confiança |
| J3 | "done" exige p ≥ `MIN_GOAL_DONE` ou um `--expect` que confere | Fecha o vetor de falso feito |
| J4 | `verifyAct` sem os 400 ms quando nada está em voo | −350 a 450 ms por `act` (~20%) |
| J5 | `expects` no laço: passou de falso para verdadeiro, termina sem consultar | −300 a 400 ms em ~35% das consultas |
| J6 | Laço por conjunto de (impressão, operação, alvo) já visitados | Pega ciclos A-B-A |
| J7 | Formulário em lote mais "único submit"; log do alvo do texto na foto | −0,6 a 1 s em formulários |

### Restrições

- Instalar ou atualizar o app fecha os terminais. Só com missão nenhuma rodando e com o OK do usuário.
- As mudanças do Jev que mexem no navegador precisam de rodadas reais do bench antes e depois para valer.
