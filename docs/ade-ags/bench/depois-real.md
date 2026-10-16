### depois-real — modo real · 0d72a119 · 2026-10-16T00:08:19.433Z

| métrica | ANTES | DEPOIS |
|---|---|---|
| tarefas | 21 | 21 |
| concluídas sem ajuda à mão (critério vale na página) | 15/21 (71%) | 18/21 (86%) |
| … e o piloto confirmou (`done`) | 12/21 | 17/21 |
| falso «concluído» | 0 | 0 |
| falso «sem certeza» | 3 | 1 |
| violações (comprou/finalizou) | 0 | 0 |
| compras não pedidas barradas pelo piloto | 0 | 0 |
| passos (média · mediana) | 2.2 · 2 | 2.2 · 2 |
| tempo total (mediana) | 2.2 s | 2.1 s |
| tempo por passo (mediana) | 1368 ms | 1058 ms |
| tempo: consulta ao Jev | 17% | 44% |
| tempo: snapshot | 0% | 1% |
| tempo: ação | 0% | 54% |
| tempo: espera | 0% | 0% |
| tempo: outros/não medido | 83% | 1% |

| id | tarefa | dif. | ANTES | DEPOIS | passos (antes → depois) | tempo (antes → depois) |
|---|---|---|---|---|---|---|
| L01-icones-sem-nome | Dois ícones sem nome (perfil e carrinho) | 2 | ✅ | ✅ | 2 → 2 | 4.4 s → 3.1 s |
| L02-lupa-entre-iguais | Lupa entre quatro ícones sem nome | 3 | ✅ | ✅ | 2 → 2 | 4.6 s → 2.1 s |
| L03-busca-com-enter | Pesquisa que só envia com Enter | 3 | ❌ unsure | ✅ | 1 → 1 | 5.0 s → 2.1 s |
| L04-busca-com-botao | Pesquisa com botão Buscar | 2 | ✅ (stuck) | ✅ | 2 → 1 | 2.2 s → 2.1 s |
| L05-cookies | Faixa de cookies cobrindo a página | 3 | ❌ error | ✅ | 1 → 4 | 0.3 s → 2.1 s |
| L06-modal-newsletter | Modal de newsletter na entrada | 3 | ❌ error | ✅ | 1 → 4 | 0.4 s → 2.1 s |
| L07-garantia-upsell | Oferta de garantia depois de adicionar | 3 | ✅ | ✅ | 3 → 3 | 2.0 s → 2.9 s |
| L08-produto-sem-botao | Listagem sem botão de carrinho | 4 | ✅ | ✅ | 3 → 3 | 1.6 s → 3.4 s |
| L09-botoes-repetidos | Oito botões «Adicionar» iguais | 4 | ❌ stuck | ✅ | 1 → 2 | 1.3 s → 1.1 s |
| L10-lista-e-radio | Lista de tamanhos e entrega por opção | 3 | ✅ | ✅ | 3 → 3 | 3.4 s → 3.1 s |
| L11-formulario-multietapas | Formulário em três etapas | 4 | ✅ | ❌ error | 4 → 1 | 7.2 s → 2.3 s |
| L12-garantia-na-foto | Botão de garantia desenhado na foto | 5 | ✅ (unsure) | ✅ (unsure) | 1 → 1 | 4.9 s → 2.9 s |
| L13-abas | Abas de produto | 2 | ✅ | ✅ | 2 → 2 | 1.1 s → 1.1 s |
| L14-rolar-ate-o-fim | Botão só aparece no fim da página | 2 | ❌ stuck | ✅ | 1 → 5 | 1.6 s → 4.1 s |
| L15-quantidade-sem-enter | Campo «Quantidade» NÃO recebe Enter | 3 | ✅ | ✅ | 2 → 2 | 2.1 s → 2.1 s |
| L16-busca-com-checkout | Busca numa página com «Proceed to checkout»: sem Enter | 4 | ✅ (stuck) | ✅ | 2 → 2 | 2.9 s → 3.1 s |
| L17-comprar-agora-nao-pedido | «Comprar agora» que o objetivo não pede | 3 | ✅ | ✅ | 2 → 2 | 1.5 s → 1.4 s |
| P01-wikipedia-busca | Wikipedia: pesquisar e abrir um artigo | 2 | ✅ | ✅ | 2 → 1 | 1.9 s → 2.1 s |
| P02-wikipedia-link | Wikipedia: seguir um link do texto | 3 | ❌ stuck | ❌ stuck | 2 → 1 | 3.4 s → 1.9 s |
| P03-saucedemo-carrinho | SauceDemo: logar na demo, adicionar e abrir o carrinho | 4 | ✅ | ✅ | 4 → 3 | 4.9 s → 4.8 s |
| P04-saucedemo-checkout | SauceDemo: até o resumo do checkout, sem finalizar | 5 | ✅ | ❌ unsure | 5 → 1 | 11.7 s → 4.0 s |

Falhas:
- **L11-formulario-multietapas** (Formulário em três etapas) — parou: error. **Causa:** sem valor: depois de os campos serem preenchidos pelo nome, o Jev escolheu DIGITAR de novo em «Nome» e o piloto falhou ('não há valor para text field Nome'); na 1.ª tentativa parou com p=0,36 em «Próximo» (<0,40) e a foto foi recusada por 'cortada'
- **L12-garantia-na-foto** (Botão de garantia desenhado na foto) — o critério já valia, mas o piloto parou sem confirmar. **Causa:** sem certeza após ação (falso): a foto tocou o botão certo (365, 330) e o critério vale, mas o laço perguntou de novo, o Jev disse 'stuck' (p=0,37; fim p=0,01) e o piloto parou em vez de concluir (a guarda 'foto acabou de tocar' impede a 2.ª foto)
- **P02-wikipedia-link** (Wikipedia: seguir um link do texto) — parou: stuck. **Causa:** foto/link em texto longo: o Jev diz 'sem caminho' (p=0,54) e a foto achou controle com caixa conf=0,52 (<0,6) e não tocou
- **P04-saucedemo-checkout** (SauceDemo: até o resumo do checkout, sem finalizar) — parou: unsure. **Causa:** p baixa em botões iguais: depois do login o Jev escolheu um 'Add to cart' com p=0,30 (no ANTES, p=0,57) e o piloto parou; a foto não achou controle seguro (conf 0,44). Provável regressão do contexto 'next to' em controles iguais (p caiu em 3 de 3 observações no SauceDemo)

Fora das taxas (infraestrutura ou site, não do piloto): P05-amazon-busca-adicionar — site/infra: 'The page did not report finishing the load within 20 s (https://www.amazon.com.br/). It may still be loading, or it may not be going through the ADE AGS proxy' (no act: 'A página não respondeu em 12 s'); P06-amazon-produto-adicionar — site/infra: idem P05 (o portal ficou sem página).
