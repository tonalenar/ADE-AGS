
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

**Prazo configurável:** `STALL_MS` (120 s) é o padrão; `findStalls(pending, probe, stallMs)` aceita outro valor e o watcher lê `localStorage["ags.stallMs"]` (mínimo `MIN_STALL_MS` = 15 s; inválido → padrão).

**Tell sem pedido:** `isAck` reconhece mensagens curtas de cortesia/confirmação (≤ 40 caracteres, ≤ 5 palavras, sem "?", começando por "obrigado", "ok", "valeu", "thanks", "entendido"…) e elas não abrem tarefa pendente. O texto do tell vai no evento `cc-peer-message` (`text`); evento sem texto conta como tarefa.

**Limites conhecidos:** o agente que trabalha e responde sem `ags peer tell` gera um aviso ("trabalhou e se calou") que o orquestrador ignora após `ags peer check`. Reconhecimento de diálogo e de ack é por texto (EN/PT/ES).

**Testes:** `src/features/missions/tests/stalled.test.ts` (26 casos).
