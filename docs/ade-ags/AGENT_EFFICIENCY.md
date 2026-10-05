
## Ponto 1 — Agente parado

**Problema:** o orquestrador manda uma tarefa com `ags peer tell` e, se o agente para por algum motivo, espera para sempre.

**Como funciona** (`src/features/missions/stalled.ts`, ligado em `watcher.ts`):

1. `peer_tell` e `peer_ask` (Rust) emitem `cc-peer-message { kind, fromTabId, toTabId, atMs }`.
2. `applyMessage`: um `tell` do orquestrador (aba `Orquestrador`) a um membro abre uma tarefa pendente; qualquer mensagem *do* membro (tell ou ask) a fecha. Um `tell` novo reinicia o relógio e o aviso. `ask` não abre tarefa (já espera sozinho).
3. A cada 5 s, `findStalls` avalia as pendentes. O silêncio conta desde o máximo entre a tarefa, a última saída do agente (`lastOutputAt`, novo em `terminal/activity.ts`) e a última digitação do usuário (`lastInputAt`). Passados `STALL_MS` = 120 s, avisa.
4. O aviso (`stallMessage`, PT-BR) vai ao orquestrador por `pasteIntoTab`, só quando ele não está no meio de um turno (senão tenta no tic seguinte). Traz nome, há quanto recebeu a tarefa, há quanto está parado, se chegou a trabalhar e a última linha da tela. Uma vez por tarefa.

**Sem falso alarme:**

| Situação | Tratamento |
|---|---|
| Pensando/executando (saída contínua) | `activeTabIds`: o relógio só corre com a aba quieta (`QUIET_MS`) |
| Espera aprovação/resposta do usuário | `isWaitingForUser` reconhece o diálogo nas últimas 8 linhas |
| Usuário digitando na aba | `lastInputAt` reinicia o relógio |
| Aba fechada | descartada da lista |

**Limites conhecidos:** um `tell` que não pede nada (ex.: "obrigado") também fica pendente; o agente que trabalha e responde sem `ags peer tell` gera um aviso ("trabalhou e se calou") que o orquestrador ignora após `ags peer check`. O plazo ainda não é configurável. Reconhecimento de diálogo é por texto da tela (EN/PT/ES).

**Testes:** `src/features/missions/tests/stalled.test.ts` (21 casos).

## Ponto 2 — Peer ask com prazo e gargalos

`ags peer ask "Backend" "pedido" --timeout 30` mantém o prazo configurável (10–3600 s; padrão 600 s). O orçamento inclui a espera para o destino ficar quieto e a espera do eco antes do Enter. Se o destino permanece ocupado, retorna `sent: false`, `finished: false`, `status: "busy"`, sem enviar uma segunda tarefa. Após envio, o prazo devolve a resposta disponível com `sent: true`, `status: "timed_out"`; não interrompe o agente. O transporte da tela/IPC e o polling podem acrescentar pequena latência ao prazo.

`ags peer check "Backend" --lines 100` consulta a tela atual e o parcial da última pergunta para o destino, sem reenviar o prompt. Qualquer peer conectado pode consultar durante a espera. `askStatus` contém `state` (`waiting`, `finished`, `timed_out`, `busy`), `fromTabId`, `sent`, `finished` e `elapsedMs`. O estado descreve a espera da pergunta, não certifica o estado atual da TUI: depois de timeout, `reply` continua permitindo ler o resultado mais recente. O histórico de consultas é volátil, limitado a 256 destinos; sem pergunta prévia, `askStatus` é nulo. Em TUIs de tela alternativa, o parcial é a tela visível, pois não existe scrollback incremental.

`ags mission timings <id>` inclui `summary.bottlenecks`, ordenado por `waitingMs` decrescente. Cada agente traz número de perguntas, solicitantes distintos, soma e máximo da espera, timeouts e soma de spans `turn`. Esperas simultâneas de dois solicitantes contam duas vezes: são dois agentes bloqueados, não tempo de relógio da missão. Não se soma `peer_ask` ao tempo de turno do agente. Agentes sem destino identificado não entram no ranking. A medição usa os spans persistidos existentes, sem alegar causalidade ou estimar tokens/custos ausentes.

Todos os turnos passam por um único `TurnTracker`: o briefing registra `detail: "briefing"` uma vez; Enter no terminal, `peer ask`, `peer tell`, recruit e `tab send` iniciam os próximos turnos. Saída sustentada detecta ainda turnos iniciados fora desses caminhos. `activitySnapshot()` apenas lê timestamps, preservando a lógica de atividade do ponto 1. O watcher continua medindo com a barra lateral recolhida. Cinco segundos sem saída encerram o span na última saída observada; fechamento da aba/missão descarrega o turno observado. Submissões sem saída não criam spans e deixam de ser acompanhadas após 20 minutos.

Limites: inferência por silêncio segue a heurística existente, portanto uma pausa longa pode dividir um turno. Duas submissões com saída separadas por menos de 5 s permanecem no mesmo turno; os 1,5 s do Rust são a preparação para enviar, enquanto o término do turno usa 5 s em ambos os lados. Uma nova submissão sem saída anterior reinicia o início, evitando contar um Enter perdido até 20 minutos depois. Eco nos primeiros 600 ms é descartado pela atividade; uma resposta inteira nesse intervalo pode não ser medida. O polling é de 1 s e a coleta precisa da janela da missão aberta. Totais `byKind` podem superar 100% do `wallMs`, pois há agentes em paralelo e espera dentro de turnos. A tela de gargalos no QG pertence ao ponto 4; este ponto entrega a API e o contrato TypeScript, sem novos textos visuais. A baseline histórica é registrada pelo QA antes da integração.

Testes focados: `cargo test --lib missions::timings`, `cargo test --lib ipc::commands::peers`; Vitest cobre briefing único, turnos seguintes, respostas curtas, saída tardia, redraw de inicialização e fechamento. No Windows: `node node_modules/typescript/bin/tsc --noEmit` e `node node_modules/vitest/vitest.mjs run` (sem `npx`).
