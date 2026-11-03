# 0001 — Vigia avisa "sem tarefa há 29 milhões de minutos"

| Campo | Valor |
|---|---|
| Data do incidente | 2026-10-09 |
| Gravidade | alta (achado A1 do teste completo v3) |
| Área | Vigia (`src/features/missions/vigia.ts`) |
| Correção | `a842cd67` em `dev`; na missão de teste, `4ae51fb` na branch do QA |

## Resumo de 30 segundos
A camada de regras do Vigia comparava o início da missão, gravado em **segundos**, com `Date.now()`, em **milissegundos**. A diferença dava cerca de 1,8e12 ms, então "sem tarefa há mais de 5 min" era verdade desde o primeiro ciclo. O Orquestrador recebeu "sem tarefa há 29829610 min" no mesmo instante em que delegava. Os três lembretes e o "Parei de insistir" se esgotavam em cerca de 12 min, e o Vigia se calava justo quando um travamento real poderia acontecer. A correção converte na borda (`missionStartMs`), com um teste de início realista.

## Linha do tempo
| Quando (−03:00) | O quê | Fonte |
|---|---|---|
| 2026-10-09 10:15 | Primeira versão do Vigia | `583a2551` |
| 2026-10-09 13:54 | Entra a camada de regras sem modelo, com `startedAt` comparado a `now` | `f820602f` (`vigia.ts`, `now - startedAt >= UNTASKED_MS`) |
| 2026-10-09 | A missão "Teste completo v3 (squad Opus)" vê o aviso nos primeiros 30 s | `docs/ade-ags/RELATORIO_TESTE_COMPLETO.md`, A1 |
| 2026-10-09 15:03 | Relatório publicado | `fdc5f32f` |
| 2026-10-09 15:07 | Correção em `dev`: `missionStartMs` converte segundos para ms | `a842cd67` |
| 2026-10-09 15:12 | Relatório atualizado com as correções dos 4 altos | `f91118a6` |

## Causa
- `missions.started_at` é epoch em segundos. O próprio Rust multiplica por 1000 (`src-tauri/src/missions/active.rs:55` e `startcheck.rs:67`, na época), e a UI também (`MissionOverview.tsx:237`).
- O Vigia usava `startedAt: mission.startedAt ?? now` (`vigia.ts:193`, na época) e comparava com `now = Date.now()`.
- Os dois são `number` no TypeScript: nada distingue segundos de milissegundos.

## Por que cada rede de proteção falhou
| Rede | Por que não pegou |
|---|---|
| Tipos | `startedAt: number` aceita as duas unidades. |
| Teste | `vigiaWatchdog.test.ts` usava `startedAt: 0`. Com zero, segundos e milissegundos dão o mesmo resultado, e o caso real nunca foi exercitado (relatório, A1, "Por que os testes não pegam"). |
| Ponto único de conversão | O Rust e a UI já convertiam, cada um no seu lugar (`active.rs:55`, `startcheck.rs:67`, `MissionOverview.tsx:237`); não havia um helper comum que o Vigia pudesse usar. |
| CI | Passou: os testes passavam. |
| O próprio Vigia | O aviso absurdo ("29 milhões de minutos") não tinha checagem de sanidade, e o teto de 3 lembretes fez o defeito sumir depois de 12 min. |

## Guardrails
| Trava | Onde | Estado |
|---|---|---|
| Conversão na borda, num ponto só | `missionStartMs` em `src/features/missions/vigia.ts` | feito (`a842cd67`) |
| Teste com início realista em segundos | `src/features/missions/tests/vigiaWatchdog.test.ts` | feito (`a842cd67`) |
| Regra escrita para quem mexe no Vigia | [docs/agentes/VIGIA.md](../../agentes/VIGIA.md) ("`startedAt` da missão vem em segundos…") | feito |
| Unidade no nome do campo (`startedAtSec`/`startedAtMs`) ou tipo marcado | — | proposto, não feito |
| Duração impossível (maior que a idade do app) vira erro em vez de aviso | — | proposto, não feito |

## O que não se sabe
- Se alguma missão real, fora do teste v3, recebeu esses avisos entre 13:54 e 15:07. O repositório não registra.

## Fontes
- `docs/ade-ags/RELATORIO_TESTE_COMPLETO.md`, seções "Alto › A1" e "Correções".
- Commits `583a2551`, `f820602f`, `fdc5f32f`, `a842cd67`, `f91118a6`.
- `docs/agentes/VIGIA.md`, "Histórico das decisões".
