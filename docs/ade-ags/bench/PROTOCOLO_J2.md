# Protocolo J2 — como medir o acerto do piloto do Jev

Este protocolo existe porque **"100%" com dezenas de rodadas não diz quase nada**.

O 54/54 das locais vem de 27 páginas determinísticas, cada uma rodada 2 vezes. As duas repetições são quase a mesma rodada, então a amostra efetiva é de ~27. O intervalo de Wilson para 27/27 vai de **87,5% a 100%**: é isso que dá para prometer.

Para provar 99,99%, seriam precisas **~30.000 rodadas seguidas sem nenhuma falha**. Para 99,99999%, **~30 milhões**. Com ~2,4 consultas ao Jev por tarefa, nenhuma das duas metas é mensurável.

## Meta

| | Meta | Como se lê |
|---|---|---|
| Sucesso em tarefas **nunca vistas** | ≥ 98% | Limite inferior de Wilson ≥ 97% e SPRT "atinge" (H1 p ≥ 98% contra H0 p ≤ 95%, α = β = 5%) |
| Erro silencioso (falso "feito" + violações) | ≤ 0,1% | O teto do IC 95% é o número que vale |
| Travamentos da janela | 0 | — |

O relatório do bench (`scripts/bench/core.ts`, `renderGroups`) já traz por grupo:
- o IC de Wilson do sucesso;
- a decisão do SPRT;
- o teto do IC do erro silencioso.

## Regras da medição

1. **Estado zerado em toda rodada.** No real, o bench faz `portal navigate`, depois `portal reset` (apaga cookies, `localStorage`, `sessionStorage` e o livro-razão dos `act`), depois `portal navigate` de novo. Sem isso, o P03/P04 nunca testava o "adicionar" (0 de 32 rodadas): o carrinho vinha da rodada anterior. O `--no-reset` existe só para comparar com o antigo.
2. **Regras congeladas durante a medição.** Uma regra nova só entra depois. Ajustar a regra e medir na mesma leva é medir o próprio ajuste.
3. **Treino e teste separados.** As 27 locais + 6 públicas atuais são o conjunto de **treino**: todas as regras do piloto foram ajustadas nelas. O número que vale para a meta sai de um conjunto de **teste** que nunca serviu para ajustar nada. O formato: ~100 tarefas geradas por semente (rótulos, ordem dos controles, idioma, atrasos de XHR, ícones sem nome variados).
   - **Pendente:** esse conjunto ainda não existe no repositório. Criá-lo é o próximo passo, e ele não pode ser escrito por quem ajusta as regras.
4. **Quantas rodadas.** Rode até o SPRT decidir ("atinge" ou "não atinge"). Com o piloto perto de 98%, ~300 rodadas no conjunto de teste costumam bastar: 0 a 1 falha dá ≥ 99% com IC ≥ 98%. No real, isso custa ~720 consultas ao Jev; peça o OK de cota antes.
5. **Por classe de erro.** Separe no relatório:
   - alvo errado;
   - objetivo mal interpretado;
   - página dinâmica (XHR, re-render);
   - ícone sem nome ou foto;
   - espera;
   - laço;
   - falso "feito".

   Uma classe com 0 em 300 ainda tem teto de ~1,2% (regra de três: 3/n).
6. **Bench de decisão por replay** (barato, sem página): grave estados com o rótulo certo e reenvie-os N vezes ao Jev. Isso mede a precisão de cada passo isolada do resto (página, espera, foto).

## Como rodar

```bash
# simulado (sem custo): o laço real contra páginas simuladas, com os critérios como --expect
bun scripts/jev-bench.ts --sim --repeat 10 --seed 7 --with-expect --label teste

# real (custa cota): locais + públicas, estado zerado em cada rodada
bun scripts/jev-bench.ts --real --public --demo-login --repeat 4 --with-expect --label teste --max-real 200
```

O `--with-expect` passa ao `act` os `--expect` equivalentes ao critério de cada tarefa. Desde a J3, o piloto confere esses critérios antes de aceitar um "acabou". **No bench, os critérios são o próprio oráculo**: medir com eles mostra o melhor caso. Meça também sem eles, que é o caso do agente que não passa `--expect`.

## Resultado da J1–J7 no simulado

27 locais × 3 rodadas, semente 1, `--with-expect`:

| | Antes | Depois |
|---|---|---|
| Sucesso | 63/81 (78%) | 67/81 (83%) |
| Falso "feito" | 3 | **0** |
| "Verificado" errado | 3 | **0** |
| NÃO CONFERE | 12 | 2 |
| Consultas ao Jev por tarefa | 2,7 | 2,2 |
| `act` p50 | 1.997 ms | 1.813 ms |

As falhas que restam no simulador (N05, N07, N08, N10, e a N09 que oscila) são limitações dele: o simulador não tem a guarda semântica nem o livro-razão do app, e não espera as opções do autocomplete.

O número que vale é o do **real**, com o estado zerado.

## Primeiras rodadas reais (2026-10-17, app 1.8.7 instalado, commit 7731866a)

| | Conjunto original (v1+v2, portões) | Conjunto de TESTE (sementes 1–20) |
|---|---|---|
| Sucesso | **31/31 (100%)**, IC 95% 89,0–100% | **88/100 (88%)**, IC 95% 80,2–93,0% |
| Erro silencioso (falso "feito" + violações) | 0/31 (teto 11,0%) | 0/100 (teto 3,7%) |
| "Verificado" errado | 0 | 0 |
| SPRT (meta ≥ 98% contra ≤ 95%) | rodar mais | não atinge |
| `act` p50 · p95 | 1.151 · 6.615 ms | 1.112 · 3.402 ms |
| Consultas ao Jev por tarefa | 1,6 | 1,3 |

Arquivos: `original-real-j1.{json,md}` e `teste-real-v1.{json,md}`. As sondas da Amazon (P05, P06) ficaram fora dos portões: o site entregou um desafio anti-robô.

**A diferença entre os dois conjuntos é o tamanho do ajuste fino ao conjunto de desenvolvimento.** As 12 falhas do teste são todas paradas honestas (nenhum falso "feito"), em duas classes:

1. **Botão coberto** (5 de 20 em `adicionar`). A faixa de cookies ou o modal cobre o produto. O Jev, vendo a falha no histórico, escolhe o mesmo botão coberto de novo, e o piloto para por repetição. No L05/L06 ele escolhia "Recusar". **Correção:** o piloto tira o que cobre a página. Ele toca o controle de recusar ou, sem ele, o de fechar (PT, EN, ES); nunca aceita nem assina. Depois o Jev escolhe de novo (`coverDismiss`).
2. **Ícone sem nome** (7 de 20 em `icone`). Quatro tarefas com alvos diferentes receberam da foto o MESMO ponto, o meio do grupo de ícones. A foto sai da tela, e o nó do bench no canvas desenha a página de 1920 px em ~400 px. Os ícones chegam ao Jev com ~10 px. **Correção:** abaixo de 3/4 do tamanho da página, o nó é enquadrado (com zoom acima de 100%) só pelo tempo da foto.

As sementes 1–20 já foram vistas por quem ajustou o piloto. A próxima medida do teste usa **sementes novas**:

```bash
bun scripts/jev-bench.ts --real --set teste --seeds 21-40 --with-expect --yes --max-real 100 --max-probes 900 --label teste-real-v2
```

## Segunda rodada do teste: sementes novas 21–40 (2026-10-17, app com o #208 instalado, dev 896a499e)

| | Teste v1 (sementes 1–20, antes) | Teste v2 (sementes 21–40, depois) |
|---|---|---|
| Sucesso | 88/100 (88%), IC 80,2–93,0% | **95/100 (95%)**, IC 88,8–97,8% |
| Erro silencioso | 0/100 | 0/100 (teto 3,7%) |
| `adicionar` (botão coberto) | 15/20 | **20/20** |
| `icone` (sem nome, pela foto) | 13/20 | 15/20 |
| `act` p50 · p95 | 1.112 · 3.402 ms | 1.017 · 3.100 ms |
| SPRT (meta ≥ 98%) | não atinge | rodar mais |

Arquivo: `teste-real-v2.{json,md}`. As 5 falhas que restam são todas `icone`, todas paradas honestas. Agora a foto sai nítida: os pontos variam com o alvo. Mas o toque cai num ícone VIZINHO do certo. O piloto tenta um segundo vizinho e para. Próximo passo provável: perguntar ao Jev, com uma foto recortada e ampliada só da faixa dos ícones, ou numerar os candidatos na foto e fazer uma pergunta de escolha. A próxima medida usa as sementes 41–60.

## Terceira rodada do teste: sementes 41–60 (2026-10-17, app com o #210, dev c6f2fb31)

| | v1 (1–20) | v2 (21–40) | **v3 (41–60)** |
|---|---|---|---|
| Sucesso | 88/100 | 95/100 | **94/100** (IC 87,5–97,2%) |
| Erro silencioso | 0 | 0 | **0** (teto 3,7%) |
| `adicionar` | 15/20 | 20/20 | 20/20 |
| `icone` | 13/20 | 15/20 | 14/20 |

Arquivo: `teste-real-v3.{json,md}`. As outras quatro famílias fecham 80/80; tudo o que falta está em `icone`. Com 20 tarefas por família, 14 e 15 são o mesmo número. A foto ampliada da barra rodou em 3 tarefas e acertou as 3. Das 6 falhas:

- 2 têm a foto ampliada apontando o mesmo ícone já tocado (o piloto então chuta o vizinho);
- 4 nem chegaram lá: a PRIMEIRA foto apontou o vão entre ícones, o runtime recusou ("mais de um controle perto do ponto") e o piloto parou.

**Correção** (próximo PR): no vão ambíguo entre ícones sem nome, o runtime manda junto a caixa do grupo, e o piloto vai direto à foto ampliada, sem tocar antes. A próxima medida usa as sementes 61–80.

## Quarta rodada do teste: sementes 61–80 (2026-10-17, app com o #211, dev a4a72380)

| | v1 (1–20) | v2 (21–40) | v3 (41–60) | **v4 (61–80)** |
|---|---|---|---|---|
| Sucesso | 88/100 | 95/100 | 94/100 | **97/100** (IC 91,5–99,0%) |
| Erro silencioso | 0 | 0 | 0 | **0** (teto 3,7%) |
| `adicionar` | 15/20 | 20/20 | 20/20 | 20/20 |
| `icone` | 13/20 | 15/20 | 14/20 | **17/20** |
| Foto ampliada acertou | — | — | 3/3 | 5/5 |

Arquivo: `teste-real-v4.{json,md}`. Somando as quatro levas, são 374/400, com 0 erro silencioso em 400 (teto 0,75%). As 3 falhas que restam são todas de ícone, e em todas a foto ampliada não serviu:

- 2 vezes ela apontou o mesmo ícone já tocado ou não teve certeza, e o vizinho chutado também não era o certo;
- 1 vez ela não teve certeza depois de um vão ambíguo.

Próximo passo provável: numerar os ícones do grupo na foto ampliada e perguntar ao Jev qual número é o do objetivo (uma pergunta de escolha, em vez de uma caixa). Próxima medida: sementes 81–100.

## Quinta rodada do teste: sementes 81–100 (2026-10-17, app com o #213, dev 04de2c48)

| | v1 | v2 | v3 | v4 | **v5** |
|---|---|---|---|---|---|
| Sucesso | 88 | 95 | 94 | 97 | **97/100** (IC 91,5–99,0%) |
| Erro silencioso | 0 | 0 | 0 | 0 | **0** |
| `icone` | 13 | 15 | 14 | 17 | 17/20 |
| Decidido pelo selo numerado | — | — | — | — | **10/10 certos** |

Somando as cinco levas: 471/500, com **0 erro silencioso em 500** (teto 0,6%). Arquivo: `teste-real-v5.{json,md}`.

**As 3 falhas não eram de mira.** As três tinham o mesmo objetivo: abrir as notificações (o sino). As capturas salvas mostram o cursor do app em cima do sino logo depois do PRIMEIRO toque, e a foto numerada confirmou o mesmo sino (selo certo). O que falhou foi a verificação:

- o toque pela foto não conferia os `--expect`, embora o piloto os confira depois de qualquer outra ação;
- o atalho "o toque já cumpriu o objetivo" só vale para objetivos "clique em…";
- o Jev de texto, em dúvida (p≈0,4) na página já certa, levava o piloto a tocar o vizinho, desfazendo o acerto (o estado final era "BUSCA ABERTA").

O sino era o ícone com pior taxa nas cinco levas (13/21).

**Correção** (este PR): depois de cada toque pela foto (o primeiro, o da foto ampliada e o do vizinho), o piloto confere os `--expect` e termina se eles passaram a valer. Próxima medida: sementes 101–120.

## Sexta rodada do teste: sementes 101–120 (2026-10-17, app com o #214, dev 5ef9153f)

| | v1 | v2 | v3 | v4 | v5 | **v6** |
|---|---|---|---|---|---|---|
| Sucesso | 88 | 95 | 94 | 97 | 97 | **100/100** (IC 96,3–100%) |
| Erro silencioso | 0 | 0 | 0 | 0 | 0 | **0** |
| `icone` | 13 | 15 | 14 | 17 | 17 | **20/20** |
| SPRT (meta ≥ 98% contra ≤ 95%) | não atinge | rodar mais | rodar mais | rodar mais | rodar mais | **atinge** |
| `act` p50 · p95 | 1,1 · 3,4 s | 1,0 · 3,1 s | — | — | — | 1,0 · 3,6 s |
| Consultas ao Jev por tarefa | 1,3 | 1,3 | — | — | — | **1,1** |

Arquivos: `teste-real-v6.{json,md}`. As cinco famílias fecharam 20/20. O selo numerado decidiu 11 toques e acertou os 11. Em 20 tarefas, os `--expect` encerraram o `act` logo depois do toque pela foto.

**Checagem de regressão no conjunto original** (`original-real-j2.{json,md}`): 31/31 nos portões. As sondas da Amazon continuam barradas pela verificação anti-robô do site; não tentamos contornar.

**Para não ler demais este número:**

- O 100% da v6 é **com** `--expect`, o oráculo do bench: é o melhor caso. Um agente que não passa `--expect` depende do "acabou" do Jev.
- O protocolo pede repetir a medida com sementes novas e também sem `--expect`.
- As 600 tarefas de teste somam 571/600 (95,2%), e o erro silencioso segue em **0 de 600** (teto 0,5%).

## Sétima rodada: SEM `--expect`, sementes 121–140 (2026-10-17, app com o #214, dev 32509ea7)

O caso do agente que não passa `--expect`: o piloto só tem o "acabou" do Jev e as guardas do próprio piloto.

| | v6 (101–120, **com** `--expect`) | **v7 (121–140, sem `--expect`)** |
|---|---|---|
| Sucesso | 100/100 (IC 96,3–100%) | **98/100** (IC 93,0–99,4%) |
| Erro silencioso | 0 | **2 falsos "feito"** (teto 7,0%) |
| `icone` | 20/20 | 18/20 |
| Outras famílias | 80/80 | 80/80 |
| `act` p50 · p95 | 1,0 · 3,6 s | 1,2 · 3,6 s |
| Consultas ao Jev por tarefa | 1,1 | **2,1** (sem o atalho dos `--expect`, ele pergunta "acabou?") |

Arquivo: `teste-real-v7-sem-expect.{json,md}`.

**Os 2 falsos "feito" (os primeiros em 700 tarefas) têm a mesma causa.** O objetivo era o perfil. O toque pela foto caiu no vizinho (sino; busca). O Jev de texto disse "concluído" com p = 0,47 e 0,55, e a pergunta "acabou?" deu só 0,09 e 0,12. Sem `--expect`, nada conferia, e o piloto devolveu "FEITO (não verificado)".

**Correção** (este PR): logo depois de um toque pela foto num grupo de ícones sem nome, e sem `--expect`, um "acabou" sem certeza (p < 0,75) passa pela foto numerada da barra (21 de 21 certos até aqui):

- se o selo é o do ícone tocado, vale o "feito", conferido pela foto;
- se o selo é outro, o piloto toca nele e segue;
- sem selo, devolve "sem certeza", nunca "feito".

Próxima medida: sementes 141–160, sem `--expect`.

## Oitava rodada: SEM `--expect`, sementes 141–160 (2026-10-17, app com o #216, dev 2a7c9146)

| | v6 (com `--expect`) | v7 (sem, antes do #216) | **v8 (sem, com o #216)** |
|---|---|---|---|
| Sucesso | 100/100 | 98/100 | **99/100** (IC 94,6–99,8%) |
| Falso "feito" | 0 | 2 | **0** |
| `icone` | 20/20 | 18/20 | 19/20 |
| `act` p50 · p95 | 1,0 · 3,6 s | 1,2 · 3,6 s | 1,2 · 5,1 s |

Arquivo: `teste-real-v8-sem-expect.{json,md}`. A conferência do "acabou" pela foto numerada rodou 2 vezes, e os falsos "feito" sumiram.

**A única falha** é o último buraco do mesmo caminho. O Jev de texto não viu caminho depois de um toque certo. A foto numerada confirmou o ícone tocado (selo 2 de 4, p = 1,0), mas o caminho do vizinho tratou a confirmação como "não serviu", tocou o vizinho e desfez o acerto.

**Correção** (este PR): com o ícone confirmado pelo selo, o piloto não toca o vizinho. Ele para com a página como está e devolve a conferência a quem pediu.

**Total nas 800 tarefas de teste:** 768/800 (96%). Erro silencioso: 2 em 800, ambos já corrigidos pelo #216.

**Bug do CI encontrado no caminho:** o teste Rust `memory::repo_sync::tests::pause_discards_the_queue_until_resume` travou o CI até o limite de 30 min uma vez. Na segunda tentativa, passou.

## Nona rodada: SEM `--expect`, sementes 161–180 (2026-10-17, app com o #217, dev a91bdaa1)

| | v7 (sem, antes) | v8 (sem, #216) | **v9 (sem, #217)** |
|---|---|---|---|
| Sucesso | 98/100 | 99/100 | **100/100** (IC 96,3–100%) |
| Falso "feito" | 2 | 0 | **0** |
| Falso "parou" | 0 | 0 | 2 |
| SPRT (meta ≥ 98%) | rodar mais | rodar mais | **atinge** |
| `act` p50 · p95 | 1,2 · 3,6 s | 1,2 · 5,1 s | 1,2 · 5,0 s |

Arquivo: `teste-real-v9-sem-expect.{json,md}`. As cinco famílias fecharam 20/20 **sem o oráculo**. O selo numerado decidiu 14 toques. Ele confirmou o ícone tocado 5 vezes, e em 2 delas o piloto deixou de tocar o vizinho, como o #217 pretendia.

**Os 2 "falsos parou"** são justamente esses 2 casos. A página estava certa, mas o piloto parou com "confira a página" em vez de "feito". **Ajuste** (este PR): quando o selo confirma o ícone tocado, o toque mudou a página e o objetivo é de um passo só, o piloto conclui "feito, conferido pela foto numerada". Num objetivo com mais etapas, continua devolvendo a conferência.

**Total nas nove levas de teste:** 868/900 (88+95+94+97+97+100+98+99+100). O erro silencioso ficou em 2/900, ambos na v7 e já corrigidos. As duas últimas levas (v6 com `--expect`, v9 sem) deram 100/100.

## Décima rodada: SEM `--expect`, sementes 181–200 (2026-10-17, app com #218 e #219, dev 299eead4)

| | v7 | v8 | v9 | **v10** |
|---|---|---|---|---|
| Sucesso | 98 | 99 | 100 | **100/100** (IC 96,3–100%) |
| Falso "feito" | 2 | 0 | 0 | **0** |
| Falso "parou" | 0 | 0 | 2 | **0** |
| SPRT (meta ≥ 98%) | rodar mais | rodar mais | atinge | **atinge** |
| `act` p50 · p95 | 1,2 · 3,6 s | 1,2 · 5,1 s | 1,2 · 5,0 s | 1,1 · 5,0 s |

Arquivo: `teste-real-v10-sem-expect.{json,md}`. É a primeira rodada sem nenhuma falha de nenhum tipo: as 100 tarefas terminaram em "feito" certo, sem o oráculo. O selo numerado decidiu 12 toques. O "feito, conferido pela foto numerada" (#219) entrou em ação 3 vezes, justamente nos casos que na v9 eram "falsos parou".

**Total nas dez levas de teste:** 968/1000. Erro silencioso: 2/1000, ambos na v7 e já corrigidos. As três últimas levas (v6 com `--expect`, v9 e v10 sem) somam 300/300.

**Limites que continuam valendo:**
- O conjunto de teste tem 5 famílias de páginas geradas. Ele não cobre sites reais variados.
- O conjunto original cobre parte disso: 31/31. As sondas da Amazon seguem barradas pela verificação anti-robô do site.
- Para afirmar mais que ~99% com confiança, são necessárias mais levas e mais famílias, não só mais sementes das mesmas.

