### depois-real — modo real · 0d72a119 · 2026-10-16T00:08:19.433Z

| métrica | valor |
|---|---|
| tarefas | 9 |
| concluídas sem ajuda à mão (critério vale na página) | 6/9 (67%) |
| … e o piloto confirmou (`done`) | 6/9 |
| falso «concluído» | 0 |
| falso «sem certeza» | 0 |
| violações (comprou/finalizou) | 0 |
| compras não pedidas barradas pelo piloto | 0 |
| passos (média · mediana) | 1.6 · 1 |
| tempo total (mediana) | 2.1 s |
| tempo por passo (mediana) | 1054 ms |
| tempo: consulta ao Jev | 52% |
| tempo: snapshot | 0% |
| tempo: ação | 47% |
| tempo: espera | 0% |
| tempo: outros/não medido | 2% |

| id | tarefa | dif. | resultado | passos | tempo | mediana/passo |
|---|---|---|---|---|---|---|
| L01-icones-sem-nome | Dois ícones sem nome (perfil e carrinho) | 2 | ✅ | 2 | 3.1 s | 1568 ms (média) |
| L02-lupa-entre-iguais | Lupa entre quatro ícones sem nome | 3 | ✅ | 2 | 2.1 s | 1054 ms (média) |
| L03-busca-com-enter | Pesquisa que só envia com Enter | 3 | ✅ | 1 | 2.1 s | 2071 ms (média) |
| L04-busca-com-botao | Pesquisa com botão Buscar | 2 | ✅ | 1 | 2.1 s | 2071 ms (média) |
| L05-cookies | Faixa de cookies cobrindo a página | 3 | ✅ | 4 | 2.1 s | 709 ms (média) |
| L06-modal-newsletter | Modal de newsletter na entrada | 3 | ✅ | 4 | 2.1 s | 696 ms (média) |
| L07-garantia-upsell | Oferta de garantia depois de adicionar | 3 | ❌ crash | 0 | 0.0 s | 0 ms (média) |
| L08-produto-sem-botao | Listagem sem botão de carrinho | 4 | ❌ crash | 0 | 0.0 s | 0 ms (média) |
| L09-botoes-repetidos | Oito botões «Adicionar» iguais | 4 | ❌ crash | 0 | 0.0 s | 0 ms (média) |

Falhas:
- **L07-garantia-upsell** (Oferta de garantia depois de adicionar) — parou: crash. Escolher «Adicionar garantia» em vez de «Continuar sem garantia» é o erro caro [navegar falhou: Command failed: C:\Users\tonz1n\.ags\cargo-target-agents\debug\ags.exe portal navigate bench-jev-mva7ltdf http://localhost:8792/garantia.html | {"error":"No llegó respuesta"} ]
- **L08-produto-sem-botao** (Listagem sem botão de carrinho) — parou: crash. Na listagem só há «Ver detalhes»; o botão de carrinho está na página do produto [navegar falhou: Command failed: C:\Users\tonz1n\.ags\cargo-target-agents\debug\ags.exe portal navigate bench-jev-mva7ltdf http://localhost:8792/catalogo.html | {"error":"Não foi possível conectar ao pipe \\\\.\\pipe\\ags-ipc-17488 (O sistema não pode encontrar o arquivo especificado. (os error 2)). Reinicie o app."} ]
- **L09-botoes-repetidos** (Oito botões «Adicionar» iguais) — parou: crash. Os botões têm o mesmo nome; só a posição junto do nome do produto os distingue [navegar falhou: Command failed: C:\Users\tonz1n\.ags\cargo-target-agents\debug\ags.exe portal navigate bench-jev-mva7ltdf http://localhost:8792/repetidos.html | {"error":"Não foi possível conectar ao pipe \\\\.\\pipe\\ags-ipc-17488 (O sistema não pode encontrar o arquivo especificado. (os error 2)). Reinicie o app."} ]
