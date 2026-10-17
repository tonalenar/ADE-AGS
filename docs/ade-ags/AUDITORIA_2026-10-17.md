# Auditoria 2026-10-17 — missões, comunicação, testes e memória

Auditoria só leitura sobre o código (`dev` local, 152 commits à frente de `origin/master`) e o banco real `~/.ags/data.db` (91 missões, 3.587 spans de tempo, 508 mensagens, 493 execuções de teste, 234 memórias). Cada achado abaixo foi conferido no código (arquivo:linha).

## Resumo em uma tela

| Área | O que os dados mostram | Causa principal |
|---|---|---|
| Tempo das missões | Só **26%** do relógio é trabalho de agente. **65%** é espera humana: 44% no meio (decisões pedidas) e 21% depois da entrega (falta clicar em "Finalizar"). | O fim e os pedidos de decisão não notificam o usuário; o relógio mistura espera humana com trabalho. |
| Trabalho real | Só 42% do tempo ocupado tem mais de um agente ativo. O QA é o caminho crítico: 1.130 min de turnos, 285 min trabalhando sozinho. | QA em série, sempre passando pelo Orquestrador; o lead fica bloqueado em `peer ask` (até 600 s) e em `gh pr checks --watch`. |
| Comunicação | O Vigia é 28% do chat, e 34% dos avisos dele são repetidos ("travado" 32× numa missão, "equipe entregou" 9×). 29% dos asks dão timeout (68 min de remetente parado). 11% do texto são regras reenviadas. | O contador do Vigia zera com qualquer mensagem do lead; o estado fica só em memória; o ask é bloqueante; não existe quadro compartilhado. |
| Testes | O cache **funciona**: rust acertou 40 de 44 numa missão. O custo vem de **suítes cheias desnecessárias**: 48 de 60 execuções de rust foram a suíte cheia. | A base do `affected` está fixa em `origin/master` (152 commits atrás); o briefing manda ignorar o cache na última rodada; o gate final só aceita texto. |
| Memória | O briefing injeta **sempre as mesmas 8 memórias**, qualquer que seja o objetivo. Desde 13/10, 7 missões e **0** consultas pelos agentes. 98% das propostas são aprovadas, 47 delas em menos de 1 min. | Há 35 memórias "fixas" para 10 vagas, e o BM25 nunca entra. Um workspace único para todos os projetos. Sem lição automática de falhas. |

## 1. Missões — onde vai o tempo

Amostra: 17 missões bem medidas, 72,9 h de relógio.

| Fatia | Horas | % |
|---|---|---|
| Trabalho real (união de turno, teste e ask) | 19,1 | 26% |
| Lacunas de 30 min ou mais no meio (lead aguardando decisão do usuário) | 32,4 | 44% |
| Depois da entrega, até o "Finalizar" | 15,3 | 21% |
| Coordenação curta | ~6 | 9% |

Exemplos: a 729fb4ea levou 635 min de relógio para 124 min de trabalho; a bbe782a6, 615 para 113. Em ambas, uma única lacuna de 440–510 min foi a noite inteira esperando o "Finalizar".

O início **não** é mais gargalo: a primeira delegação sai em 28 s e todos estão trabalhando em 35 s (medianas).

### Gargalos

- **M1. A entrega não avisa ninguém.**
  - O "equipe entregou" vai só para o chat (`missions/vigia.rs:172-183`).
  - O notifier só dispara quando o status já é done/failed (`notifier.rs:154`), e esse status depende do clique.
  - O diálogo pede à mão o resultado de teste e o PR (`missions/delivery.rs:98`), que o app já conhece.
- **M2. Decisões no meio da missão.**
  - O briefing proíbe PR e merge sem pedido (`terminals.ts:203`, `:246`).
  - O Vigia detecta o "posso…?" (`vigiaClosing.ts:91-110`), mas só lembra o lead; não avisa o usuário.
- **M3. Lead bloqueado.**
  - O briefing ensina `peer ask` "e ESPERA", com padrão de 600 s (`terminals.ts:254`, `peers.rs:876`), e `gh pr checks --watch` (`terminals.ts:270`).
  - Medido: o `orchestrator_stall` respondido por `peer_tell` dura 851 s em média.
- **M4. QA em série.** "A cada entrega… avise o QA" (`terminals.ts:269`) cria um salto extra pelo lead. Além disso, o QA só recebe tarefa depois da implementação.
- **M5. Base errada.**
  - A worktree nasce de `origin/master` fixo (`missions/team.rs:71`), que está 152 commits atrás de `origin/dev`.
  - Na 729fb4ea isso gerou, já no minuto 1, uma rodada extra de merge para todos.
- **M6. Enter às cegas aos 25 s** (`terminalRegistry.ts:106-111`). 26 de 32 `start_stalled` são do QA. O `pasteStillPending` (`:253`) não reconhece essa TUI.
- **M7. "Entregou" depende do Vigia.**
  - O Vigia vem desligado por padrão (`vigiaSwitch.ts`).
  - A detecção exige `members.every(hasTask)` (`vigia.ts:127`): um integrante sem tarefa bloqueia o "entregou".
- **M8. Missão CredPro, a que está rodando agora (repo Node em `site api`)**, travou em três tentativas:
  - O diálogo "Do you trust this folder" parou os agentes. **A correção já está no working tree desta branch, sem commit:** `usage/trust.rs` + `missions/team.rs:103`.
  - Um terminal abriu na worktree do QA (325be3d2).
  - O `ags test affected` presume o layout do ADE-AGS.
  - O modelo do Vigia falhou com `os error 267` (pasta com espaço).

## 2. Comunicação entre agentes

Como funciona hoje:
- O envio é só pela CLI (`ags peer tell/ask --file`): duas chamadas por mensagem. O MCP não tem tool de peer (`ipc/mcp.rs:570`).
- A mensagem é colada no PTY com um cabeçalho de cerca de 104 caracteres (`peers.rs:252-260`).
- O ask é bloqueante e devolve até 200 linhas cruas de tela (`peers.rs:906-960`).

Medido em 10 missões (508 mensagens, 325 mil caracteres):
- **Vigia:** 144 mensagens (28%), 49 delas quase idênticas a outra.
  - O contador zera com qualquer mensagem do lead, até um "ok" (`vigia.ts:361-366`).
  - O `doneAt` zera quando o lead fala (`vigia.ts:359`).
  - `watches` e `closingNudges` ficam só em memória (`vigia.ts:222`, `:288`), então um HMR ou reinício repete o aviso.
- **Mensagens grandes e repetidas:** média de 640 caracteres, p90 de 1.621. O lead manda 43% do volume, e 34 mensagens dele passam de 1.500 caracteres. 32,8 mil caracteres são blocos repetidos ("REGRAS…", "MOCK…").
- **Contrato de entrega:** de 121 entregas ao lead, só 3 trazem os campos pedidos pelo briefing (`terminals.ts:343`). O app adivinha o que é entrega por regex e pelo Jev (`vigiaPoke.ts:35-47`).
- **Rajadas sobre o lead:** 71 de 200 mensagens chegaram menos de 60 s depois de outra, cada uma num paste separado.
- **Bug:** na fila, o `forget_sent` recebe o texto já com o aviso de "mensagem velha" (`peers.rs:285`, `:332`). A chave não bate com a de `first_time_for`, e um reenvio legítimo é recusado como duplicado.
- **Recursos prontos e não usados nas missões em terminais:**
  - Structured Handoff v1 (`runs/handoff`): só 6 tasks, nenhuma de missão em terminais.
  - `fact_add`/`facts_read`: só na Frota.
  - `ags swarm note`: 2 linhas, e não há comando de leitura.

## 3. Testes

> Correção em relação ao número preliminar: as "104 execuções repetidas no mesmo hash" eram linhas antigas com `tree_hash NULL` agrupadas juntas. Repetições reais: 26 em 10 dias (~17 min), quase todas por `--force`.

O cache funciona. O custo vem de **árvores novas a cada pequena edição e de suítes cheias sem necessidade**:
- Desde 09/10: tsc 80 execuções em 74 árvores, vitest 76 em 64, rust 52 em 33.
- Na 729fb4ea: os "156 testes" foram 70 execuções reais, somando 18 min (o resto é marcador ou acerto de cache).
- Na bbe782a6: 19 rodadas da suíte rust cheia, somando 25,7 min.
- Rust cheio: p50 de 110 s e p90 de 164 s. Os testes em si levam 42–50 s; o resto é compilação incremental.

Causas raiz:
- **T1. A base do `affected` está fixa em `origin/master`** (`testspeed/run.rs:119`, `:144`). Com a missão 120+ commits à frente, o diff inclui `lib.rs` e `Cargo.lock`, e o plano vira suíte cheia **em toda chamada**: 48 de 60 rusts.
- **T2. O briefing manda ignorar o cache.**
  - `floors.rs:254` diz «Essa reutilização não vale na última rodada de correção nem na validação única da integração».
  - `roles.rs:34` diz «mesmo se o affected já estava verde».
  - Isso contradiz `fixrounds.rs:378`. Os leads obedecem ("`--force` x 5").
- **T3. O gate da última rodada é por texto** (`fixrounds.rs:723-729`): um `affected` verde com a mesma chave não conta.
- **T4. `scripts/` inteiro dispara vitest cheio, babel e tsc** (`affected.rs:222`), incluindo fixtures `.html` de bench.
- **T5. O tsc roda sem `--incremental`** (`run.rs:59-63`): 17 s a cada árvore.
- **T6. O layout do ADE-AGS está fixo no código** (`run.rs:55-77`, `affected.rs:268-293`, `scope.rs:13-38`). Num repo Node, todo arquivo vira "não mapeado" e a suíte cheia inclui o rust (`affected.rs:225`, `:263`).
- **T7. Flake** `matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente`: maior parte das 13 falhas de rust, somando 16 min.

## 4. Memória persistente e compartilhada

Fluxo atual:
- **Escrita:** `ags memory suggest` (`terminals.ts:301-309`).
- **Revisão:** sempre humana (`decisions/points.rs:45`).
- **Injeção no briefing:** `missions/mod.rs:732` → Jev ou `memory/search.rs:341`.
- **Consulta:** `ags memory search/index/open`.

O que funciona: o conteúdo de workspace é bom (armadilhas de Windows, sandbox, cargo lock, CI em Linux). Os filtros de segredo e o envelope estão no lugar.

O que não funciona:
- **R1. A seleção do briefing está quebrada** (`memory/search.rs:351-367`).
  - As fixas (`constraint` ou prioridade ≥5) vêm primeiro: são 35 candidatas para 10 vagas. O teto de 2.600 caracteres corta em 8.
  - Resultado com os dados reais: sempre as mesmas 8, entre elas `animacao-mascote-leve`. O BM25 sobre o objetivo **nunca entra**, e cerca de 93% da memória nunca é vista.
  - O caminho do Jev tem o mesmo defeito: `with_pinned` (`decisions/relevance.rs:219`).
- **R2. Os agentes não consultam:** 0 `search`/`open`/`index` desde 13/10.
  - O `ags memory index` devolve só 5 links, sem chaves (`memory/repo.rs:56`).
  - A injeção pelo caminho comum não grava em `memory_usage`.
- **R3. Um workspace único (`default`) para todos os projetos:** a CredPro recebe regras de cargo e Tauri. Há uma proposta pendente, específica do repo Node, que contaminaria o ADE-AGS se aprovada.
- **R4. A revisão virou carimbo:** 223 de 228 aprovadas, com lotes de 29 no mesmo segundo. Entraram notas sintéticas de QA (`qa-v9-01`, `qa-test-fixture-math-add`).
- **R5. Memória de missão é peso morto:** 62 de 64 entradas ativas são de missões encerradas, e só valem para a própria missão (`search.rs:215`).
- **R6. O dream está sem insumo:** 5 execuções, 4 falharam e 1 "não propus nada". As 288 revisões têm `source_run_id` NULL, porque o `suggest` não registra a origem (`memory/dream.rs:128-195`).
- **R7. Higiene:**
  - Cerca de 8 grupos de quase-duplicatas (cerca de 18 entradas).
  - `last_verified` e `ttl_days` são NULL nas 234 entradas: gravados (`lifecycle.rs:389`), nunca lidos.
- **R8. Falhas de teste e rodadas de correção não viram lição:** `testspeed`, `fixrounds` e o Vigia não têm ligação com a memória.
- **R9. O ganho nunca foi medido:** o A/B (`AB_MEMORIA_E_ORQUESTRAMENTO.md`) existe, mas não há nenhuma missão `[AB:` no banco.

## 5. Plano priorizado

### Onda 1 — correções pequenas, ganho alto, risco baixo

| # | Mudança | Arquivos | Ganho estimado |
|---|---|---|---|
| 1 | Seleção do briefing de memória: no máximo 3–4 fixas, o resto por BM25/Jev sobre o objetivo; gravar `injected` com as chaves reais | `memory/search.rs:341`, `decisions/relevance.rs:219`, `missions/mod.rs:732` | A memória relevante passa a chegar |
| 2 | Base da worktree e do `affected` = branch de integração da missão (ou `dev`), com `git fetch` antes | `missions/team.rs:71`, `testspeed/run.rs:119,144` | 5–12 min por missão, mais o fim da rodada de merge inicial |
| 3 | Tirar dos briefings a ordem de ignorar o cache; gate aceita o verde de `test_results` da mesma chave; `--force` só com motivo | `floors.rs:254`, `roles.rs:34`, `runs/fixrounds.rs:723` | 5–13 min por missão |
| 4 | Dedupe do Vigia: "entregou" uma vez enquanto não houver tarefa nova; contador zera só com mensagem ao travado; estado persistido | `vigia.ts:222,288,359-366` | ~30% menos mensagens |
| 5 | Bug `forget_sent` com a chave original | `peers.rs:285,332` | Correção |
| 6 | Entrega notifica o usuário: span `team_delivered` + notificação do sistema; diálogo pré-preenchido com o último verde e o PR; também notificar quando o lead pede decisão | `vigia.rs:172`, `notifier.rs:154`, `delivery.rs:98`, `vigiaClosing.ts` | 21–59% do relógio reportado |
| 7 | tsc `--incremental` por worktree | `testspeed/run.rs:59` | 4–6 min por missão |
| 8 | Commitar a correção do "trust this folder" já feita no working tree | `usage/trust.rs`, `missions/team.rs:103` | Destrava o início |

### Onda 2 — fluxo da equipe

- **9.** Lead com `tell` e fim de turno, em vez de `ask` e espera; timeout padrão de 90 s; evento "CI do PR #n terminou" colado no lead, em vez de `--watch`.
- **10.** QA recebe tarefa no t0 (casos de teste a partir do objetivo); o integrante entrega direto ao QA, com cópia ao lead.
- **11.** `ags peer deliver --file handoff.json`, reaproveitando `runs::handoff::schema()`: grava `kind='handoff'` e o lead recebe uma linha. Substitui a heurística `isFinalReport`.
- **12.** Quadro da missão (`fact_add`/`facts_read` com escopo de missão): regras, mock e decisões publicados uma vez; os tells só referenciam.
- **13.** Memória com um workspace por repositório (raiz git do cwd), migrando as 114 entradas para o ADE-AGS.
- **14.** Detecção do tipo de projeto no `ags test` (Cargo, tsconfig, vitest, `scripts.test`, `node --test`); gate e briefing seguem as suítes detectadas.
- **15.** Lição automática: teste vermelho → verde no mesmo worktree, ou rodada de correção, vira rascunho `finding`; o `suggest` grava a origem (missão, tab, task) para o dream ter fontes.

### Onda 3 — estrutura e medição

- **16.** Mensagem em arquivo (`~/.ags/inbox/<tab>/<id>.md`) e só uma linha colada no PTY; agrupar rajadas de menos de 60 s; tools MCP `peer_tell`/`peer_reply`/`peer_inbox`; ask assíncrono com `reply-to`.
- **17.** Higiene de memória:
  - No fim da missão, promover ou apagar as entradas de missão.
  - Detectar quase-duplicatas.
  - Usar `last_verified` para rebaixar o que não é lido.
  - Na revisão, mostrar o veredito do Jev; propostas de missões de teste ficam com escopo `mission`.
- **18.** Métricas separadas, "início → entregou" e "entregou → finalizada"; o `mission_active` deixa de depender da janela visível (`watcher.ts:106`).
- **19.** Rodar 3 pares do A/B de memória depois do item 1.
- **20.** Corrigir o flake rust; estreitar `scripts/` no `affected` (`affected.rs:222`); Enter do início checado aos 6–8 s com o `pasteStillPending` ampliado (`terminalRegistry.ts:106,253`).

## Restrições para executar

- A missão `d7b03196` (CredPro) está **rodando**: não atualizar o ADE-AGS-app nem reinstalar enquanto ela não fechar (risco de HMR derrubar os PTYs).
- Trabalhar em worktree própria a partir de `dev`; PR com `--repo tonalenar/ADE-AGS`.
- A branch atual (`codex/update-local-current`) tem muito trabalho em andamento, sem commit (desktop apps, Gemini, canvas, trust). Não misturar com as ondas acima.
