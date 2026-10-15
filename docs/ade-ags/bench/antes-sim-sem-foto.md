### antes-sem-foto — modo sim · ee2a8e80 · 2026-10-15T23:18:48.689Z

| métrica | valor |
|---|---|
| tarefas | 14 |
| concluídas sem ajuda à mão | 9/14 (64%) |
| falso «concluído» | 0 |
| falso «sem certeza» | 0 |
| violações (comprou/finalizou) | 0 |
| passos (média · mediana) | 2.1 · 2.5 |
| tempo total (mediana) | 2.1 s |
| tempo por passo (mediana) | 910 ms |
| tempo: consulta ao Jev | 54% |
| tempo: snapshot | 16% |
| tempo: ação | 8% |
| tempo: espera | 22% |
| tempo: outros/não medido | 0% |

| id | tarefa | dif. | resultado | passos | tempo | mediana/passo |
|---|---|---|---|---|---|---|
| L01-icones-sem-nome | Dois ícones sem nome (perfil e carrinho) | 2 | ❌ unsure | 0 | 0.6 s | 570 ms |
| L02-lupa-entre-iguais | Lupa entre quatro ícones sem nome | 3 | ❌ unsure | 0 | 0.6 s | 570 ms |
| L03-busca-com-enter | Pesquisa que só envia com Enter | 3 | ❌ stuck | 1 | 1.9 s | 950 ms |
| L04-busca-com-botao | Pesquisa com botão Buscar | 2 | ✅ | 2 | 1.9 s | 955 ms |
| L05-cookies | Faixa de cookies cobrindo a página | 3 | ✅ | 3 | 2.4 s | 910 ms |
| L06-modal-newsletter | Modal de newsletter na entrada | 3 | ✅ | 3 | 2.4 s | 910 ms |
| L07-garantia-upsell | Oferta de garantia depois de adicionar | 3 | ✅ | 3 | 2.4 s | 910 ms |
| L08-produto-sem-botao | Listagem sem botão de carrinho | 4 | ✅ | 3 | 2.4 s | 910 ms |
| L09-botoes-repetidos | Oito botões «Adicionar» iguais | 4 | ❌ unsure | 0 | 0.6 s | 570 ms |
| L10-lista-e-radio | Lista de tamanhos e entrega por opção | 3 | ✅ | 3 | 2.8 s | 910 ms |
| L11-formulario-multietapas | Formulário em três etapas | 4 | ✅ | 4 | 4.3 s | 910 ms |
| L12-garantia-na-foto | Botão de garantia desenhado na foto | 5 | ❌ unsure | 0 | 0.6 s | 570 ms |
| L13-abas | Abas de produto | 2 | ✅ | 2 | 1.5 s | 740 ms |
| L14-rolar-ate-o-fim | Botão só aparece no fim da página | 2 | ✅ | 5 | 4.2 s | 900 ms |

Falhas:
- **L01-icones-sem-nome** (Dois ícones sem nome (perfil e carrinho)) — parou: unsure. Só a foto distingue o perfil do carrinho (reserva visual) [O elemento que o Jev escolheu (e1) não tem nome e há outros iguais na página: só o texto não os distingue (p=0.60, 450 ms). Continue você, com `snapshot` e `cli]
- **L02-lupa-entre-iguais** (Lupa entre quatro ícones sem nome) — parou: unsure. Menu, lupa, sino e coração são iguais para o texto [O elemento que o Jev escolheu (e1) não tem nome e há outros iguais na página: só o texto não os distingue (p=0.60, 450 ms). Continue você, com `snapshot` e `cli]
- **L03-busca-com-enter** (Pesquisa que só envia com Enter) — parou: stuck. O piloto não tem a operação «apertar Enter» (o type do act roda com submit:false): falha esperada até ela existir [O mesmo passo se repetiu sem mudar a página. Continue você.]
- **L09-botoes-repetidos** (Oito botões «Adicionar» iguais) — parou: unsure. Os botões têm o mesmo nome; só a posição junto do nome do produto os distingue [O Jev não tem certeza do próximo passo (click e1, p=0.40, 450 ms). Continue você, com `snapshot` e `click`, ou diga no objetivo a escolha que falta.]
- **L12-garantia-na-foto** (Botão de garantia desenhado na foto) — parou: unsure. O botão é parte da imagem: não tem nome nem texto, só a foto o mostra [O elemento que o Jev escolheu (e1) não tem nome e há outros iguais na página: só o texto não os distingue (p=0.60, 450 ms). Continue você, com `snapshot` e `cli]
