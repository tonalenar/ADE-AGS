# Auditoria do computer use com o Jev — benchmark do piloto

Missão «Auditoria do computer use com o Jev», prioridade 2/3. Este documento é o **esqueleto do relatório**: o
benchmark repetível do piloto (`ags portal act` / `browser_act`) e as colunas ANTES/DEPOIS das correções de
precisão e velocidade. A coluna **ANTES (sim)** está preenchida (rodada local, sem custo, commit `ee2a8e80`). As
colunas **ANTES (real)** e **DEPOIS** esperam as rodadas com o Jev de verdade, que só rodam a pedido do Orquestrador.

## Como rodar

```powershell
bun scripts/jev-bench.ts --list                       # as 20 tarefas, com objetivo e critério
bun scripts/jev-bench.ts --sim                        # o laço real do piloto contra páginas simuladas: sem custo, sem rede
bun scripts/jev-bench.ts --sim --no-visual            # o mesmo, sem a reserva visual (a foto)
bun scripts/jev-bench.ts --sim --verbose              # mostra os passos de cada tarefa
bun scripts/jev-bench.ts --sim --label depois --compare docs/ade-ags/bench/antes-sim.json   # colunas ANTES e DEPOIS
bun scripts/jev-bench.ts --serve                      # só serve as páginas locais (ags open http://localhost:8765/)

# Jev REAL (gasta cota; precisa de um terminal de agente do app e de uma instância aberta). Pede confirmação.
bun scripts/jev-bench.ts --real --only L01-icones-sem-nome,L04-busca-com-botao --max-real 2
bun scripts/jev-bench.ts --real --public --max-real 8 --max-probes 80      # inclui Wikipedia e Amazon
bun scripts/jev-bench.ts --real --public --demo-login --yes                # inclui o SauceDemo (login de demonstração)
```

Cada rodada grava `bench-results/jev-bench-<modo>-<label>.json` (e um `.md` ao lado); `--out` troca o caminho. O
JSON tem uma `TaskRun` por tarefa e o `summary` agregado (ver `scripts/bench/core.ts`). Os testes da lógica pura
estão em `src/features/browser/tests/jevBench.test.ts`.

**Teto do modo real.** `--max-real N` (padrão 5 tarefas) e `--max-probes N` (padrão 60 consultas ao Jev, contadas pelo
pior caso: a soma dos limites de passos); o plano para antes de estourar. Sem `--yes`, pede para digitar `CONFIRMO`;
sem terminal interativo, recusa. As tarefas públicas só entram com `--public`; o SauceDemo, só com `--demo-login`.

## O que se mede

| medida | como se calcula |
|---|---|
| **Concluída sem ajuda à mão** | o critério de sucesso vale na PÁGINA final (URL/texto do `snapshot`) e o critério proibido não vale |
| **Passos** | linhas numeradas do relatório do piloto (campos preenchidos pelo nome, sem o Jev, vêm à parte: `autoFills`); uma parada sem agir conta 0 |
| **Tempo total / mediana por passo** | do começo ao fim do `act`; o passo vai de uma consulta ao Jev à seguinte |
| **Divisão do tempo** | consulta ao Jev (operação+elemento e foto) · `snapshot` · ação · espera (`settle`) · outros/não medido |
| **Falso «concluído»** | o piloto disse `done` mas o critério falhou (ou fez o proibido) |
| **Falso «sem certeza»** | o critério já valia, mas o piloto parou em `unsure`/`stuck` |
| **Violação** | o critério proibido valeu (finalizou compra, assinou, abriu a garantia errada…) |

No **sim** o piloto é medido por dentro (`instrument` embrulha as ações) e o tempo é **virtual**: cada fase soma uma
latência fixa (`SIM_LATENCY` em `scripts/bench/sim.ts`: Jev 450 ms, foto 1400 ms, snapshot 120 ms, clique 90 ms,
espera 250 ms), então o mesmo laço dá sempre o mesmo número. No **real**, só o relatório do `act` está disponível
(ver «Telemetria que falta»): a consulta ao Jev vem dos «NNN ms» das linhas de passo, o tempo por passo é a média
(total ÷ passos) e o resto vai para «outros».

## Limites do sim (leia antes de comparar)

O sim roda o `runPilot` **de verdade** (guardas de ambiguidade, reserva visual, repetição, limite de passos), mas o Jev
é uma **heurística**: pontua pelas palavras do objetivo, fecha obstáculos, e diz `done` por um oráculo (o critério).
Ele mede o **laço e as páginas**, não a qualidade do Jev: uma melhora no sim prova que o laço deixou de tropeçar, não
que o Jev acerta mais. Serve de regressão sem custo e de contraprova das correções em `jevPilot.ts`. A precisão do Jev
só aparece no `--real`.

As 14 páginas simuladas (`scripts/bench/sim.ts`) espelham as fixtures HTML (`scripts/bench-fixture/`); o teste confere
que cada nome simulado existe no HTML e que o critério não vale na página inicial. Elas **não** foram abertas em
navegador nesta entrega (a instância de debug é do integrante Visual): a primeira rodada real é também a validação das
fixtures — em especial a L14 (o botão nasce por `IntersectionObserver`) e a L12 (o botão é uma área sem nome sobre um SVG).

## Tarefas e resultados

`ANTES (sim)` e `ANTES (sim, sem foto)` vêm de `docs/ade-ags/bench/antes-sim*.json`. As colunas reais ficam vazias até a
primeira rodada com o Jev.

| id | tipo | dif. | objetivo | critério | passos | ANTES (sim) | ANTES (sim, sem foto) | ANTES (real) | DEPOIS |
|---|---|---|---|---|---|---|---|---|---|
| L01-icones-sem-nome | local | 2 | Abra o carrinho de compras: é o ícone do carrinho no canto superior direito da página. | texto «CART OPENED» | ≤6 | ✅ | ❌ unsure | — | — |
| L02-lupa-entre-iguais | local | 3 | Abra a busca do site: clique na lupa no topo da página. | texto «SEARCH OPEN» | ≤6 | ✅ | ❌ unsure | — | — |
| L03-busca-com-enter | local | 3 | Pesquise por tênis no campo de busca da loja. | URL contém `q=tenis` e texto «Resultados para: tenis» | ≤6 | ❌ stuck | ❌ stuck | — | — |
| L04-busca-com-botao | local | 2 | Pesquise por tênis na loja. | URL contém `q=tenis` e texto «Resultados para: tenis» | ≤6 | ✅ | ✅ | — | — |
| L05-cookies | local | 3 | Adicione a Mochila Urbana ao carrinho. | texto «Carrinho: 1» | ≤8 | ✅ | ✅ | — | — |
| L06-modal-newsletter | local | 3 | Adicione a Mochila Urbana ao carrinho, sem assinar a newsletter. | texto «Carrinho: 1» · **proibido:** «Inscrição confirmada» | ≤8 | ✅ | ✅ | — | — |
| L07-garantia-upsell | local | 3 | Adicione o Fone Bluetooth ao carrinho, sem a garantia estendida. | texto «Carrinho: 1 · sem garantia» · **proibido:** «com garantia» | ≤8 | ✅ | ✅ | — | — |
| L08-produto-sem-botao | local | 4 | Adicione o Fone Bluetooth ao carrinho. | URL contém `produto-fone` e texto «Carrinho: 1» | ≤8 | ✅ | ✅ | — | — |
| L09-botoes-repetidos | local | 4 | Adicione a Cafeteira ao carrinho. | texto «No carrinho: Cafeteira» | ≤8 | ✅ | ❌ unsure | — | — |
| L10-lista-e-radio | local | 3 | Escolha o tamanho G, a entrega «Retirar na loja» e confirme. | texto «Confirmado: tamanho G, Retirar na loja» | ≤8 | ✅ | ✅ | — | — |
| L11-formulario-multietapas | local | 4 | Preencha o pedido de teste nas três etapas (dados, endereço, revisão) e envie. | texto «Pedido de teste enviado» | ≤12 | ✅ | ✅ | — | — |
| L12-garantia-na-foto | local | 5 | Clique no botão «Garantia estendida» que aparece no meio da foto do produto. | texto «GARANTIA ABERTA» · **proibido:** «COMPRA FEITA» | ≤6 | ✅ | ❌ unsure | — | — |
| L13-abas | local | 2 | Descubra o peso do produto abrindo a aba Especificações. | texto «Peso: 1,2 kg» | ≤6 | ✅ | ✅ | — | — |
| L14-rolar-ate-o-fim | local | 2 | Role até o fim da página e clique em Assinar. | texto «ASSINADO» | ≤8 | ✅ | ✅ | — | — |
| P01-wikipedia-busca | pública | 2 | Pesquise por Alan Turing e abra o artigo. | URL contém `/wiki/Alan_Turing` | ≤8 | n/a | n/a | — | — |
| P02-wikipedia-link | pública | 3 | Abra o artigo sobre Portugal clicando em um link «Portugal» do texto. | URL contém `/wiki/Portugal` | ≤8 | n/a | n/a | — | — |
| P03-saucedemo-carrinho | pública (login demo) | 4 | Entrar com o usuário/senha de demonstração, adicionar a Sauce Labs Backpack e abrir o carrinho; não finalizar. | URL contém `/cart.html` e texto «Sauce Labs Backpack» · **proibido:** URL `checkout-complete` | ≤12 | n/a | n/a | — | — |
| P04-saucedemo-checkout | pública (login demo) | 5 | Idem, até o resumo do checkout (Overview), com dados fictícios; NÃO clicar em Finish. | URL contém `checkout-step-two` · **proibido:** URL `checkout-complete` | ≤15 | n/a | n/a | — | — |
| P05-amazon-busca-adicionar | pública | 4 | Pesquisar por caneca e, no primeiro resultado, Adicionar ao carrinho; não finalizar. | texto «adicionado ao carrinho» / «added to cart» · **proibido:** URL de compra/checkout ou «finalizar pedido» | ≤10 | n/a | n/a | — | — |
| P06-amazon-produto-adicionar | pública | 5 | Pesquisar por livro, abrir o primeiro resultado e Adicionar ao carrinho na página do produto; não finalizar. | idem P05 | ≤12 | n/a | n/a | — | — |

As seis públicas não têm página simulada: só rodam no real. P03 e P04 pedem `--demo-login` (ver «Pontos de atenção»).
P05 e P06 (Amazon) são **frágeis por natureza** (captcha, A/B, layout): uma falha ali pode não ser do piloto.

## Taxas e tempos

| métrica | ANTES (sim) | ANTES (sim, sem foto) | ANTES (real) | DEPOIS |
|---|---|---|---|---|
| tarefas | 14 | 14 | — | — |
| concluídas sem ajuda à mão | 13/14 (93%) | 9/14 (64%) | — | — |
| falso «concluído» | 0 | 0 | — | — |
| falso «sem certeza» | 0 | 0 | — | — |
| violações | 0 | 0 | — | — |
| passos (média · mediana) | 2.6 · 2.5 | 2.1 · 2.5 | — | — |
| tempo total (mediana) | 2.6 s virtuais | 2.1 s virtuais | — | — |
| tempo por passo (mediana) | 910 ms | 910 ms | — | — |
| tempo: consulta ao Jev | 60% | 54% | — | — |
| tempo: snapshot | 14% | 16% | — | — |
| tempo: ação | 7% | 8% | — | — |
| tempo: espera | 19% | 22% | — | — |
| tempo: outros/não medido | 0% | 0% | — | — |

Tabelas completas por tarefa: [`bench/antes-sim.md`](bench/antes-sim.md) e [`bench/antes-sim-sem-foto.md`](bench/antes-sim-sem-foto.md).
Para preencher DEPOIS: `bun scripts/jev-bench.ts --sim --label depois --compare docs/ade-ags/bench/antes-sim.json`.

## O que o sim já mostra (leitura do laço, sem Jev real)

- **L03 — pesquisa que só envia com Enter: falha por desenho.** O piloto não tem a operação «apertar tecla»: o `type`
  do `act` roda com `submit:false` (`pilotDeps` em `agentBridge.ts`) e as operações oferecidas ao Jev são só
  `click/type/select/scroll/wait/done/stuck`. Sem botão de busca, o piloto digita e fica sem caminho.
- **Sem a reserva visual, quatro tarefas viram «sem certeza»**: L01, L02, L09 e L12 (ícones sem nome, botões
  repetidos, botão desenhado na foto). Com ela (padrão do app), todas se resolvem no sim. No real, depende de a foto
  caber inteira no canvas (`visualShot().complete`) e do Jev apontar o ponto certo.
- **L09 (oito «Adicionar» iguais):** `isAmbiguous` só pega elementos **sem nome**; botões com o MESMO nome passam
  como se o texto os distinguisse. O sim usa um Jev calibrado (p = 0,40 diante de rótulos gêmeos) e por isso cai na
  foto; um Jev real que responda com p ≥ 0,45 clicaria no primeiro «Adicionar» e o piloto diria `done` ou seguiria
  errado. É a tarefa a observar por **falso «concluído»**.
- **L14 (rolar):** o piloto detecta «girar em círculos» pela impressão da página (`fingerprint`: endereço, elementos e
  texto, sem a posição de rolagem). Se o `snapshot` do app lista a página inteira (`all:false` pode mostrar só a janela;
  não verificado), duas rolagens seguidas sem elemento novo viram `stuck`. O sim assume que só a janela aparece.

## Telemetria que falta no relatório do `act`

O relatório (`formatResult` em `jevPilot.ts`) traz só: desfecho, nota, os passos (cada um com `p=` e os ms **da
consulta ao Jev**) e o `snapshot` final. Para o benchmark real medir por fase falta, em `runPilot`/`formatResult`:

1. **Tempo por fase**: somas de `snapshot`, ação (`click`/`type`/`select`/`scroll`/`clickAt`), espera (`settle`), consulta
   ao Jev (já há por passo) e foto (`visual`, que hoje só imprime os ms quando toca). Basta embrulhar as `PilotDeps`
   como faz `instrument()` em `scripts/bench/core.ts` e devolver `timings` em `PilotResult`.
2. **Tempo de cada passo** (hoje o benchmark real só tem a média).
3. **Um bloco legível por máquina** no fim do relatório (uma linha `TEMPOS: {"jev":…,"snapshot":…,"acao":…,"espera":…,
   "foto":…,"consultas":N,"fotos":N}`) ou `--json` no `portal act`, para o runner não depender de regex nos passos.
4. **Quantas consultas ao Jev** o piloto gastou (hoje só se deduz contando linhas) e quando parou sem agir (um `unsure`
   no primeiro passo conta 0 passos, mas gastou uma consulta).

Nada disso foi editado aqui (`jevPilot.ts`/`runtime.ts` são do Orquestrador): o pedido segue por `ags peer tell`.

## Falhas restantes

Preencher depois da primeira rodada real, por classe: (a) sem caminho (stuck), (b) sem certeza (unsure), (c) falso
«concluído», (d) estouro de limite, (e) violação, (f) falha do site/rede (não conta contra o piloto).

| id | classe | causa | correção associada |
|---|---|---|---|
| L03-busca-com-enter | stuck | o piloto não tem a operação «Enter» (`submit:false`) | — |
| _(demais: após a rodada real)_ | | | |

## Pontos de atenção

- **SauceDemo exige login** (usuário/senha de demonstração que o PRÓPRIO site publica na tela de entrada). O pedido era
  «tarefas públicas sem login»: por isso P03/P04 só rodam com `--demo-login`, usam só esses valores via `--fill` (nunca
  vão ao provedor: só os nomes dos campos) e, com a senha preenchida, `sensitiveFilled` bloqueia a foto. P04 para antes de
  `Finish`: `forbid` marca `checkout-complete` como violação. Se preferir tirar o login do escopo, basta excluí-las.
- **Nenhum fluxo faz compra, pagamento ou usa dado pessoal.** Amazon e SauceDemo têm `forbid` (URL de compra/checkout
  concluído) e o objetivo diz «não finalize». O benchmark não mexe em `blockedPurchase`: ele **não existe neste commit** (`grep` em `src/` e `src-tauri/src/` não acha), então a única trava de compra aqui é o `forbid` + o objetivo; quando o Orquestrador a introduzir, vale por cima. `sensitiveFilled` (jevPilot.ts) segue intacto.
- O modo real **não inicia nem fecha** instâncias do app: usa o `ags` do terminal onde roda e cria só um portal
  (`bench-jev`; `--portal <nome>` reaproveita outro).
