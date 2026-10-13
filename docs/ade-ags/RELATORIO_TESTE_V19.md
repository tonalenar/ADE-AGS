# Relatório de teste V19 (Vigia, chat da equipe e memória, squad E2E)

Build 1.8.7, master b5d7c3a. Só testes: nenhum código do produto foi alterado. A janela do app NÃO foi aberta; o que depende de tela foi conferido por código e sqlite somente leitura. Detalhes: `V19_BACKEND.md`, `V19_FRONTEND.md`, `V19_QA.md`.

## Itens da rodada

| # | Item | Resultado |
|---|------|-----------|
| 1 | Vigia reconhece entrega | **FUNCIONA** na janela observada. Único aviso do Vigia: 12:05:45 (Frontend ocioso, entrega registrada às 11:59:56). Nenhum "travado" depois de relatório final. Ressalva: a missão passou pouco de 22 min; a cobrança de 30 min não foi exercida. "recebido" curto NÃO conta como entrega (FUNCIONA). Ver B1. |
| 2 | Chat da equipe (código) | Parcial: filtros fixos, `@Nome` e chaves i18n FUNCIONAM; negrito/código e VigiaCard FALHAM em casos de borda (F1–F6). |
| 3 | Texto das mensagens | **FUNCIONA**: nomes corretos; maior texto 2020 caracteres (limite 6000). |
| 4 | "Não mostrou atividade" | **FUNCIONA**: stall às 11:57:00 (25 s após o briefing das 11:56:35, ≥ 20 s); 1ª saída do QA às 11:57:05. Nenhum aviso espúrio. |
| 5 | Resumo do Orquestrador | **FALHA parcial**: sempre ≤ 3 linhas; a partir do 3º turno citou integrantes por nome (achado S1, do próprio Orquestrador). |
| 6 | Uma missão, uma branch | **FUNCIONA**: cada integrante commitou só na própria branch; `gh pr list --head 'cc/*' --state open` vazio antes do PR da missão. |
| 7 | Memória | Núcleo Rust FUNCIONA (`memory.rs:1328`, só revisão aprovada atual de entrada ativa). CLI `ags memory get --revision` FALHA (M2). Propostas do QA seguem `proposed`, sem vazar. UI (Enter, origem, prioridade alta) FUNCIONA; M1 foco. |
| 8 | Regressão | `ags test smoke` 9/9; BOM e UTF-16 íntegros ("ação, coração, 漢字"); `ags run status|result|facts --run-id` inexistente/válido/sem valor FUNCIONAM; frontend 1736/1736 em 14,2 s (base 18), tsc verde em 16,1 s (base 23), rust cache verde do mesmo hash (não reexecutado); `ags test affected` verde. |

## Achados por gravidade

**B1 (P2, Backend) — `isFinalReport` aceita progresso longo prefixado com o nome como entrega.** `src/features/missions/vigiaPoke.ts:24,38`: `NOT_A_DELIVERY` é testado na primeira linha ainda com o prefixo do nome; o retorno antecipado por ≥ 100 caracteres vem antes da remoção do nome. Reprodução (Backend): `isFinalReport("Backend: em andamento. Vou executar as suítes e ler o banco; resultados ainda pendentes, nenhum relatório final disponível.","tell","Backend",true)` devolve `true` (esperado `false`); `"recebido"` devolve `false`. Efeito: o integrante sai das cobranças do Vigia antes de concluir. Conferido pelo Orquestrador no código.

**S1 (média) — Orquestrador citou integrantes por nome nos resumos de turno 3–5** (QA, `V19_QA.md` §5). Descumpre a regra do briefing.

**M2 (média) — `ags memory get --revision` não funciona fora de tarefa Lead/Worker.** Saída: `{"error":"As ferramentas MCP de Memória Compartilhada exigem uma tarefa Lead ou Worker"}`. Causa (QA): `cli.rs:641-656` remove `taskId` e `dispatch.rs:214` roteia para `run_orchestrate`, que exige `taskId`. Por isso a regra "revisão antiga/pendente negada" só se verifica pelo teste de unidade Rust, não pela CLI.

**F1 (baixa)** título com caminho `C:\` ou `~/` vira `**\`C:\x.md**` (negrito quebrado). **F2** link markdown e URL mutilados por crases. **F3** rótulo do VigiaCard casa com nome de agente. **F4** "possível laço" sem gravidade. **F5** falha do modelo do Vigia sai como "Travado" vermelho (`vigia.ts:385`). **F6** filtro de agente sobrevive à troca de missão. **M1** foco não volta após cancelar a confirmação do lote. **F8** textos cortados sem tooltip (FleetView, MissionMap, CanvasView, FloorBar, AgentCard). Sem chave i18n crua nas telas revisadas. Detalhes e linhas em `V19_FRONTEND.md`.

## Balanço do Jev (leitura histórica de todo o banco; sem amostra nova nesta missão)

| Provider | Ponto | Linhas | Média ms | Mediana | p95 | Erros | Timeouts |
|---|---|---:|---:|---:|---:|---:|---:|
| jev | memory_approval | 50 | 474,7 | 461,5 | 544 | 0 | 0 |
| jev | mission_gate | 7 | 510,4 | 544 | 618 | 0 | 0 |
| laya_local | memory_approval | 36 | 848,9 | 703,5 | 2006 | 2 | 2 |
| laya_local | mission_gate | 6 | 467,3 | 437 | 633 | 0 | 0 |

Vantagem do Jev na aprovação de memória (menor latência, zero timeouts); sem vantagem no gate de missão. Amostra pequena, períodos distintos: não prova vantagem geral. `decision_human_log` (94 linhas) não tem provider.

## Balanço do Vigia

1 aviso (12:05:45), correto e útil; zero ruído no terminal do QA, zero "[Pasted text #N]" empacado, nenhuma cutucada em quem já entregou. Tempos: briefing → todos trabalhando em ~35 s; primeira delegação em 40 s; missão ativa ~22 min.

## Propostas de memória pendentes (para decidir em "Sugestões de memória")

`qa-test-fixture-math-add`, `qa-test-mock-clock-tick`, `qa-test-dummy-logger-noop`, `qa-test-buffer-string-trim`, `qa-test-color-hex-parser`, `qa-test-array-sort-numeric` (todas banais, escopo missão).
