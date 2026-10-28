### antes — modo sim · ee2a8e80 · 2026-10-15T23:18:48.365Z

| métrica | valor |
|---|---|
| tarefas | 14 |
| concluídas sem ajuda à mão | 13/14 (93%) |
| falso «concluído» | 0 |
| falso «sem certeza» | 0 |
| violações (comprou/finalizou) | 0 |
| passos (média · mediana) | 2.6 · 2.5 |
| tempo total (mediana) | 2.6 s |
| tempo por passo (mediana) | 910 ms |
| tempo: consulta ao Jev | 60% |
| tempo: snapshot | 14% |
| tempo: ação | 7% |
| tempo: espera | 19% |
| tempo: outros/não medido | 0% |

| id | tarefa | dif. | resultado | passos | tempo | mediana/passo |
|---|---|---|---|---|---|---|
| L01-icones-sem-nome | Dois ícones sem nome (perfil e carrinho) | 2 | ✅ | 2 | 2.9 s | 1440 ms |
| L02-lupa-entre-iguais | Lupa entre quatro ícones sem nome | 3 | ✅ | 2 | 2.9 s | 1440 ms |
| L03-busca-com-enter | Pesquisa que só envia com Enter | 3 | ❌ stuck | 1 | 1.9 s | 950 ms |
| L04-busca-com-botao | Pesquisa com botão Buscar | 2 | ✅ | 2 | 1.9 s | 955 ms |
| L05-cookies | Faixa de cookies cobrindo a página | 3 | ✅ | 3 | 2.4 s | 910 ms |
| L06-modal-newsletter | Modal de newsletter na entrada | 3 | ✅ | 3 | 2.4 s | 910 ms |
| L07-garantia-upsell | Oferta de garantia depois de adicionar | 3 | ✅ | 3 | 2.4 s | 910 ms |
| L08-produto-sem-botao | Listagem sem botão de carrinho | 4 | ✅ | 3 | 2.4 s | 910 ms |
| L09-botoes-repetidos | Oito botões «Adicionar» iguais | 4 | ✅ | 2 | 2.9 s | 1440 ms |
| L10-lista-e-radio | Lista de tamanhos e entrega por opção | 3 | ✅ | 3 | 2.8 s | 910 ms |
| L11-formulario-multietapas | Formulário em três etapas | 4 | ✅ | 4 | 4.3 s | 910 ms |
| L12-garantia-na-foto | Botão de garantia desenhado na foto | 5 | ✅ | 2 | 2.9 s | 1440 ms |
| L13-abas | Abas de produto | 2 | ✅ | 2 | 1.5 s | 740 ms |
| L14-rolar-ate-o-fim | Botão só aparece no fim da página | 2 | ✅ | 5 | 4.2 s | 900 ms |

Falhas:
- **L03-busca-com-enter** (Pesquisa que só envia com Enter) — parou: stuck. O piloto não tem a operação «apertar Enter» (o type do act roda com submit:false): falha esperada até ela existir [O mesmo passo se repetiu sem mudar a página. Continue você.]
