# Calibração dos limites do piloto (plano v2, 4.5 — achado D3)

Data: 2026-10-16 · Reproduz com `npx tsx scripts/jev-calibrate.ts --db <cópia do data.db> --out docs/ade-ags/bench/calibracao-limites.md` (não custa consulta ao Jev; a lógica está em `scripts/bench/calibrate.ts` e tem teste).

## O que dá e o que não dá para calibrar

- **Veredito de acerto** só existe nos relatórios do benchmark REAL (`docs/ade-ags/bench/*real*.json`): cada passo traz `p=` e `fim p=`, e a rodada tem o critério verificado **pela página**. O rótulo é **da rodada**, não do passo: uma rodada errada pode ter passos certos (as colunas «de rodadas certas» são um limite superior da precisão do passo).
- O **`decision_shadow_log`** (651 consultas `browser_step`, 99 `browser_vision` neste computador) não tem veredito: mostra a distribuição de p, a concordância entre perguntas, erros e latência.
- O log só guardava a **menor** probabilidade da consulta (operação × alvo) e o **rótulo** do `concluido`, sem a probabilidade. Por isso **não dá para calibrar por pergunta com os dados de hoje**. Desta versão em diante `provider_decision` leva também `|p:alvo_click=0.80,concluido=0.93,operacao=0.90` (`decision_note` em `browse.rs`, com teste); o script já lê esse formato (`perQuestion`). A próxima calibração por pergunta precisa de uma rodada real feita com esta versão.
- A amostra do veredito é pequena: 98 rodadas únicas, 95 passos, 13 paradas, 55 «feito», 25 fotos. Quem muda um limite com isto está decidindo no escuro; por isso a decisão abaixo é **manter** onde os dados não separam.

## Decisão

| limite | hoje | decisão | por quê |
|---|---|---|---|
| `MIN_PROBABILITY` | 0,40 | **manter** | Nenhum passo executado tem p < 0,41 e as 13 paradas estão em 0,26–0,37: o limite cai num vazio dos dados. Baixar para 0,35 libera 8 paradas, só 2 com o critério já cumprido (as outras 6 seriam apostas sem veredito); subir para 0,45–0,50 barra 2 passos, os dois de rodadas certas. |
| `MIN_GOAL_DONE` | 0,75 | **manter** | A maior `fim p` de um passo em que o piloto NÃO concluiu é 0,38 e o menor «feito» da pergunta direta é 0,76: qualquer valor em (0,38; 0,75] aceita os mesmos 41 «feito» com 0 falsos. 0,80 deixa 1 verdadeiro de fora e 0,90 deixa 7. Fica no lado alto do platô porque o falso «feito» custa mais que um passo a mais. Os 2 falsos «feito» do corpus vieram da **operação** `done` (p = 0,83), não da pergunta direta: nenhum limite de p os pega, é o trabalho da verificação (Fase 5, `--expect`). |
| `MIN_FOUND` / `MIN_BOX_CONFIDENCE` | 0,60 / 0,60 | **manter** | Subir para 0,80/0,80 reduz as fotos aceitas de 17 para 12 e a taxa de rodadas certas não melhora (13/17 → 9/12). Sem ganho de precisão, só perde alcance. |

## Achados que mudam outras decisões

- **Latência.** Nas 650 consultas respondidas do log, a latência do cliente é **p50 312 ms, p95 483 ms** (mediana de 1.144 tokens de entrada), já abaixo da meta de 450 ms **na mediana** (a linha de base do benchmark real, `v2-linha-de-base.md`, mediou 305 ms por consulta). Os 460–1.700 ms do plano vêm das rodadas com a Amazon e da época do `concluido` + 3 cabeças de alvo; quem confirma com o corpo cortado é o benchmark real.
- **`concluido` × operação `done` concordam**: 147 + 388 de 547 consultas com as duas respostas; só 12 discordam (2 «sim» sem `done`, 10 «não» com `done`). A pergunta direta quase não acrescenta informação à operação `done`; o corte de executá-la só depois de uma ação que mudou a página (4.2) tira a que não era usada.
- **O piso de HTTP.** Um `HEAD` na raiz de `api.typesafe.ai` leva ~270 ms com a conexão reaproveitada (HTTP/2) e ~407 ms a frio: a rede deste computador até o Jev ocupa a maior parte dos 312 ms de mediana. É o limite do que cortar estado consegue.

## Tabelas (geradas)

Amostra: 98 rodadas reais únicas · 95 passos executados · 13 paradas «sem certeza» · 55 «feito» · 25 fotos.

### MIN_PROBABILITY = 0.4 (a operação/alvo escolhidos)

| p | passos executados | de rodadas certas | paradas «sem certeza» | …com o critério já cumprido |
|---|---|---|---|---|
| 0.0–0.2 | 0 | — | 0 | 0 |
| 0.2–0.3 | 0 | — | 1 | 0 |
| 0.3–0.4 | 0 | — | 12 | 2 |
| 0.4–0.5 | 2 | 100% | 0 | 0 |
| 0.5–0.6 | 12 | 100% | 0 | 0 |
| 0.6–0.7 | 9 | 89% | 0 | 0 |
| 0.7–0.8 | 1 | 100% | 0 | 0 |
| 0.8–0.9 | 19 | 100% | 0 | 0 |
| 0.9–1.0 | 52 | 79% | 0 | 0 |

| limite | passos barrados | …de rodadas certas | paradas liberadas | …com o critério já cumprido |
|---|---|---|---|---|
| 0.30 | 0 | 0 | 12 | 2 |
| 0.35 | 0 | 0 | 8 | 2 |
| 0.40 | 0 | 0 | 0 | 0 |
| 0.45 | 2 | 2 | 0 | 0 |
| 0.50 | 2 | 2 | 0 | 0 |
| 0.60 | 14 | 14 | 0 | 0 |

### MIN_GOAL_DONE = 0.75 (a pergunta direta «o objetivo já foi atingido?»)

Maior `fim p` entre os passos em que o piloto NÃO concluiu: 0.38.

| limite | «feito» aceitos | falsos | verdadeiros deixados de fora |
|---|---|---|---|
| 0.50 | 41 | 0 | 0 |
| 0.60 | 41 | 0 | 0 |
| 0.70 | 41 | 0 | 0 |
| 0.75 | 41 | 0 | 0 |
| 0.80 | 40 | 0 | 1 |
| 0.90 | 34 | 0 | 7 |

Pela operação `done` (limite = MIN_PROBABILITY): 14 «feito», 2 falso(s) — p 0.83, 0.83.

### MIN_FOUND = 0.6 e confiança da caixa = 0.6 (reserva visual)

| existe ≥ | caixa ≥ | fotos que passariam | de rodadas certas |
|---|---|---|---|
| 0.50 | 0.50 | 18 | 13 |
| 0.60 | 0.60 | 17 | 13 |
| 0.70 | 0.60 | 17 | 13 |
| 0.80 | 0.60 | 17 | 13 |
| 0.60 | 0.70 | 15 | 11 |
| 0.80 | 0.80 | 12 | 9 |

### decision_shadow_log · browser_step

651 consultas, 1 com erro, 650 respondidas · latência p50 312 ms, p95 483 ms · 1144 tokens de entrada (mediana). Já trazem p por pergunta: 0.

| p (a menor da consulta) | consultas |
|---|---|
| 0.0–0.2 | 0 |
| 0.2–0.3 | 15 |
| 0.3–0.4 | 66 |
| 0.4–0.5 | 56 |
| 0.5–0.6 | 68 |
| 0.6–0.7 | 57 |
| 0.7–0.8 | 49 |
| 0.8–0.9 | 93 |
| 0.9–1.0 | 246 |

| | operação = done | outra operação |
|---|---|---|
| concluido = sim | 147 | 2 |
| concluido = não | 10 | 388 |

### decision_shadow_log · browser_vision

99 consultas, 3 com erro, 96 respondidas · latência p50 403 ms, p95 736 ms. Já trazem p por pergunta: 0.

| p (a menor da consulta) | consultas |
|---|---|
| 0.0–0.2 | 0 |
| 0.2–0.3 | 0 |
| 0.3–0.4 | 0 |
| 0.4–0.5 | 0 |
| 0.5–0.6 | 4 |
| 0.6–0.7 | 7 |
| 0.7–0.8 | 10 |
| 0.8–0.9 | 16 |
| 0.9–1.0 | 59 |
