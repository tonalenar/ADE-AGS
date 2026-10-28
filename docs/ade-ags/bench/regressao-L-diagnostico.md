# Regressão das L* na rodada real "depois" — diagnóstico e correção (Decisão, 4.1/4.2)

Data: 2026-10-16 · Rodada real da Decisão em `f02dfe99`, instância isolada própria (`ade-ags-dev-data-dec`), 63 consultas ao Jev (orçamento: 150).

## Causa

1. **O estado que o Jev recebe não mudou** nas L01/L05/L11: montei a consulta da base (`ee709f56`) e a atual sobre as mesmas páginas do simulador e os estados saem byte a byte iguais. Os cortes de estado do 4.2 (texto 1800 B, tabela ≤ 80, rótulo ≤ 90) **não explicam** as quedas e ficam.
2. **O livro-razão por portal vazava entre tarefas.** O benchmark reaproveita o portal; o «clicou Adicionar ao carrinho — carrinho 0→1» de OUTRA tarefa entrava no estado do Jev. Efeitos lidos nos relatórios: «concluído» no 1.º passo com p = 0,43 / 0,51 / 0,95 (L17, L13, L08); repetição do último clique/rolagem da tarefa anterior (L01, L11); e a 2.ª repetição de L07/L17 recusada à toa («já adicionado num act anterior, carrinho 0→1») porque a página nova voltou a 0.
3. **L05**: a regra `modal-cookie` dizia «o controle menos comprometedor» e a 2.ª escolha do Jev repetiu o botão coberto; o piloto parou com «o mesmo passo se repetiu».

## Correções

- `jevPilot.ts`: o histórico de `act` anterior só entra no estado quando a ponte diz `pageChangedSince === false`; a recusa do 2.º «adicionar» por `act` anterior só vale nessa condição (`56008ae3`). A Observação tornou o `prior()` do `portalLedger.ts` tolerante à página (`5a475dd3`).
- «Acabou» no 1.º passo, sem ação do piloto e com p < `MIN_GOAL_DONE`, devolve a página (`unsure`) em vez de «FEITO (não verificado)».
- `browse_rules.rs` (versão `.3`): `modal-cookie` aceita «Accept» quando é o único jeito e proíbe escolher o controle coberto; `ADE_AGS_RULES_OFF=all|id,id` desliga regras sem recompilar (bisecção) e vai no log (`|r:<versão>-off:…`).
- Um controle coberto repetido UMA vez não é «girar em círculos» (`f02dfe99`); na 2.ª repetição o piloto para, como antes.

## Antes / depois (sucesso = critério vale na página e nada proibido)

| tarefa | base (ee709f56) | depois (c3b88a9d) | agora (f02dfe99) |
|---|---|---|---|
| L01 | 2/2 | 0/2 | 1/2 |
| L05 | 2/2 | 0/2 | 2/2 |
| L07 | 2/2 | 1/2 | 2/2 |
| L08 | 2/2 | 1/2 | 2/2 |
| L11 | 2/2 | 1/2 | 2/2 |
| L13 | 2/2 | 1/2 | 2/2 |
| L17 | 2/2 | 0/2 | 2/2 |
| **total L (7 tarefas ×2)** | 14/14 | 4/14 | 13/14 |
| P02 | 0/2 | 0/2 | 0/2 |
| P03 | 2/2 | 1/2 | 1/2 |
| P04 | 2/2 | 1/2 | 2/2 |
| **total P (3 tarefas ×2)** | 4/6 | 2/6 | 3/6 |


Locais (14 rodadas): 13/14 = **93 %** (meta ≥ 87 %), 0 falso «feito», 1 violação (L01). Mediana por consulta ao Jev **292 ms** (p95 327 ms), corpo mediano 4,3 KB, 3,0 consultas por tarefa. Públicas: 3/6.

## O que sobra

- **L01 (1/2)**: no passo 1 o Jev escolhe entre dois ícones sem nome (~50 % perfil = violação); a foto só ajuda depois. Candidatos: tentar a foto ANTES do 1.º clique em ícones sem nome quando o objetivo cita «ícone/canto», e repetir a foto uma vez pedindo o CENTRO do ícone quando o ponto cai no vão (a Observação confirmou que o runtime recusa o vão de propósito).
- **P02 (0/2, igual à base)**: o Jev clica um link «Portugal» do texto que leva a «Império Português» e dá «feito» (fim p = 0,72–0,79, op. done p = 0,70–0,91). Não é regressão (a base também falha); quem pega é o `--expect url:/wiki/Portugal` (Fase 5). A página tem ~100 links: corpo de 20 KB, 16,5 mil tokens, 340 ms de latência, ou seja, o tamanho do corpo quase não pesa na latência.
- **P03 (1/2)**: no SauceDemo o Jev passa por «View details» e fica sem certeza (p = 0,31) na página do produto; a foto não sai porque a senha de demonstração está preenchida (`sensitiveFilled`). Também falha na base em outra repetição; variação do Jev.
