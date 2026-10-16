### dev-atual — modo sim · afecb91c · 2026-10-15T23:24:01.995Z

| métrica | ANTES | DEPOIS |
|---|---|---|
| tarefas | 14 | 14 |
| concluídas sem ajuda à mão | 13/14 (93%) | 13/14 (93%) |
| falso «concluído» | 0 | 0 |
| falso «sem certeza» | 0 | 0 |
| violações (comprou/finalizou) | 0 | 0 |
| passos (média · mediana) | 2.6 · 2.5 | 2.6 · 2.5 |
| tempo total (mediana) | 2.6 s | 2.1 s |
| tempo por passo (mediana) | 910 ms | 710 ms |
| tempo: consulta ao Jev | 60% | 71% |
| tempo: snapshot | 14% | 16% |
| tempo: ação | 7% | 8% |
| tempo: espera | 19% | 5% |
| tempo: outros/não medido | 0% | 0% |

| id | tarefa | dif. | ANTES | DEPOIS | passos (antes → depois) | tempo (antes → depois) |
|---|---|---|---|---|---|---|
| L01-icones-sem-nome | Dois ícones sem nome (perfil e carrinho) | 2 | ✅ | ✅ | 2 → 2 | 2.9 s → 2.7 s |
| L02-lupa-entre-iguais | Lupa entre quatro ícones sem nome | 3 | ✅ | ✅ | 2 → 2 | 2.9 s → 2.7 s |
| L03-busca-com-enter | Pesquisa que só envia com Enter | 3 | ❌ stuck | ❌ stuck | 1 → 1 | 1.9 s → 1.5 s |
| L04-busca-com-botao | Pesquisa com botão Buscar | 2 | ✅ | ✅ | 2 → 2 | 1.9 s → 1.5 s |
| L05-cookies | Faixa de cookies cobrindo a página | 3 | ✅ | ✅ | 3 → 3 | 2.4 s → 2.0 s |
| L06-modal-newsletter | Modal de newsletter na entrada | 3 | ✅ | ✅ | 3 → 3 | 2.4 s → 2.0 s |
| L07-garantia-upsell | Oferta de garantia depois de adicionar | 3 | ✅ | ✅ | 3 → 3 | 2.4 s → 2.0 s |
| L08-produto-sem-botao | Listagem sem botão de carrinho | 4 | ✅ | ✅ | 3 → 3 | 2.4 s → 2.0 s |
| L09-botoes-repetidos | Oito botões «Adicionar» iguais | 4 | ✅ | ✅ | 2 → 2 | 2.9 s → 2.7 s |
| L10-lista-e-radio | Lista de tamanhos e entrega por opção | 3 | ✅ | ✅ | 3 → 3 | 2.8 s → 2.2 s |
| L11-formulario-multietapas | Formulário em três etapas | 4 | ✅ | ✅ | 4 → 4 | 4.3 s → 3.3 s |
| L12-garantia-na-foto | Botão de garantia desenhado na foto | 5 | ✅ | ✅ | 2 → 2 | 2.9 s → 2.7 s |
| L13-abas | Abas de produto | 2 | ✅ | ✅ | 2 → 2 | 1.5 s → 1.3 s |
| L14-rolar-ate-o-fim | Botão só aparece no fim da página | 2 | ✅ | ✅ | 5 → 5 | 4.2 s → 3.4 s |

Falhas:
- **L03-busca-com-enter** (Pesquisa que só envia com Enter) — parou: stuck. O piloto não tem a operação «apertar Enter» (o type do act roda com submit:false): falha esperada até ela existir [O mesmo passo se repetiu sem mudar a página. Continue você.]
