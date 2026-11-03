# 0004 — O mesmo aviso do Vigia 32 vezes numa missão

| Campo | Valor |
|---|---|
| Data do incidente | até 2026-10-17 (medido em 10 missões) |
| Gravidade | média (ruído no chat do lead; nenhum dado perdido) |
| Área | Vigia (`src/features/missions/vigia.ts`) e fila de peers |
| Correção | `5865f4d1` |

## Resumo de 30 segundos
A auditoria de 2026-10-17 mediu que o Vigia era 28% das mensagens das missões, e 34% dos avisos dele eram repetidos: o mesmo "travado há N min" saiu 32 vezes numa missão, sempre como "lembrete 1/3". A conta de lembretes zerava com qualquer mensagem do Orquestrador, até um "ok", e o estado vivia só em memória. Agora só uma tarefa nova delegada rearma o aviso, e o estado de cada missão é guardado.

## Linha do tempo
| Quando (−03:00) | O quê | Fonte |
|---|---|---|
| 2026-10-09 | Entra a camada de regras do Vigia, com contagem de lembretes | `f820602f` |
| até 2026-10-17 | Em 10 missões (508 mensagens), o Vigia manda 144 (28%), 49 delas quase idênticas a outra | `docs/ade-ags/AUDITORIA_2026-10-17.md`, linhas 11 e 64 |
| 2026-10-17 07:32 | Correção: só `refreshWatch` (tarefa nova) zera a conta; o estado por missão fica guardado | `5865f4d1` |
| 2026-10-17 07:32 | Auditoria publicada | `dca2f2b1` |

## Causa
- O contador zerava com qualquer mensagem do lead (`vigia.ts:361-366`, na época) e o `doneAt` também (`vigia.ts:359`). Um "obrigado" bastava para o "equipe entregou" voltar a ser enviado: 8 vezes em 13 h (commit `5865f4d1`).
- `watches` e `closingNudges` ficavam só em memória (`vigia.ts:222` e `:288`, na época): um HMR ou um reinício recomeçava a conta (ver [0002](0002-hmr-derrubou-ptys-de-missao.md)).
- Na fila de peers, `forget_sent` recebia o texto já com o aviso de "mensagem velha" (`peers.rs:285` e `:332`, na época). A chave não batia com a de `first_time_for`, e um reenvio legítimo era recusado como duplicado por 10 min.

## Por que cada rede de proteção falhou
| Rede | Por que não pegou |
|---|---|
| Testes | Não havia caso para "aviso → 'ok' do lead → aviso". Ele entrou com a correção: "um 'ok' do Orquestrador não rearma o 'entregou'" (`vigiaWatchdog.test.ts`, `5865f4d1`). |
| Teto de lembretes | Existia (3), mas a conta zerava antes de chegar a ele. |
| Observação | Não havia métrica de volume do Vigia no chat; o número apareceu quando a auditoria contou as mensagens das missões. |
| Persistência | O estado em memória fazia cada recarga parecer uma missão nova. |

## Guardrails
| Trava | Onde | Estado |
|---|---|---|
| Só uma tarefa nova delegada rearma lembretes e o "equipe entregou" | `refreshWatch` em `src/features/missions/vigia.ts` | feito (`5865f4d1`) |
| Estado por missão guardado (`ags.vigia.watches.v1`) | `src/features/missions/vigia.ts` | feito (`5865f4d1`) |
| Testes da sequência com mensagens do lead entre avisos | `src/features/missions/tests/vigiaWatchdog.test.ts` | feito (`5865f4d1`) |
| `forget_sent` usa o texto original | `src-tauri/src/ipc/commands/peers.rs` | feito (`5865f4d1`) |
| "Armado" não sobrevive ao reinício: reabrir o app não repete avisos sem um gesto da pessoa | ponto 15 da análise do deepseek-harness | em andamento em outra frente |

## O que não se sabe
- A data da primeira missão afetada. A medição cobre 10 missões até 2026-10-17, sem o período exato.

## Fontes
- `docs/ade-ags/AUDITORIA_2026-10-17.md`, linhas 11 e 60-68.
- Commits `f820602f`, `5865f4d1`, `dca2f2b1`.
- `docs/agentes/VIGIA.md`, "Histórico das decisões".
