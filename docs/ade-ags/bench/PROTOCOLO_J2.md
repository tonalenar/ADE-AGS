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

