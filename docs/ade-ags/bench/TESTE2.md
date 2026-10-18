# Conjunto de TESTE 2 do protocolo J2

As dez primeiras levas do conjunto de teste (`--set teste`) tiveram as 5 famílias da `loja.html`: adicionar, busca, filtro, ícone e formulário. Elas chegaram a 300/300 nas três últimas levas. A partir daí, mais sementes das mesmas famílias dizem pouco. Para afirmar mais que ~99%, o que falta é **diversidade de páginas**. O conjunto 2 traz 7 famílias que o 1 não cobre, com as mesmas regras:

- é determinístico por (família, semente);
- a página varia entre PT, EN e ES, e o objetivo vem sempre em PT-BR;
- **nenhuma regra do piloto foi ajustada nelas antes de medir**.

| Família | O que a página faz | Variações |
|---|---|---|
| `abas` | Produto com 3–5 abas; o critério é o texto que só a aba certa mostra | Abas em botões ou em links `#` |
| `acordeao` | Perguntas frequentes; a resposta só existe aberta | A pergunta é o botão, ou um botão "+" **igual** ao lado de cada uma (só o vizinho distingue) |
| `paginacao` | 12–24 produtos em páginas de 4–6; o alvo nunca está na primeira | "Próxima" (troca a página) ou "Carregar mais" (acrescenta) |
| `selecao` | Escolher tamanho ou cor e confirmar | `<select>` nativo, ou lista própria (`role=listbox`) aberta por um botão |
| `confirmacao` | Remover um item do carrinho com o modal "tem certeza?" | O "sim" do modal pode ter o **mesmo nome** do "Remover" da lista; o critério exige a contagem certa (remover dois falha) |
| `quantidade` | Pôr N unidades no carrinho | Botões +/− (sem `--fill`), ou campo numérico (com `--fill Quantidade=N`) |
| `menu` | Ir a uma categoria pelo menu da loja | Botão "Categorias" no topo, ou "☰" só com `aria-label` |

São 7 × 20 = 140 tarefas por leva (ids `T2-<família>-NN`). As peças:

- `scripts/bench-fixture/gen/scenario2.js`: os dados, mais o caminho certo (`solve`);
- `render2.js`: o desenho, o mesmo na página e nos testes;
- `loja2.html`: a página.

O teste `src/features/browser/tests/benchTeste2.test.ts` confere, nas 20 sementes de cada família, que o critério é **falso ao abrir** e **vale depois do caminho certo**, num DOM (happy-dom). Também confere que caminhos errados não cumprem: outra aba; remover o item certo e mais um.

## Como medir

O bench real custa cota, e reinstalar o app derruba os terminais: só com o OK de quem usa.

```bash
# sem o oráculo (o caso do agente que não passa --expect)
bun scripts/jev-bench.ts --real --set teste2 --seeds 1-20 --yes --max-real 140 --max-probes 1300 --label teste2-real-v1-sem-expect --out docs/ade-ags/bench/teste2-real-v1-sem-expect.json

# com o oráculo (o melhor caso)
bun scripts/jev-bench.ts --real --set teste2 --seeds 1-20 --with-expect --yes --max-real 140 --max-probes 1300 --label teste2-real-v1 --out docs/ade-ags/bench/teste2-real-v1.json
```

Como no conjunto 1: depois de ver as falhas de uma leva, as sementes dela deixam de ser teste para quem ajustou o piloto. A medida seguinte usa `--seeds 21-40`.

## Primeira rodada real: SEM `--expect`, sementes 1–20 (2026-10-17, app com dev 299eead4)

**135/140 (96%)**, IC 95% 91,9–98,5%. Erro silencioso: **0/140** (teto 2,7%), sem falso "feito" e sem violações. Houve 1 falso "parou". SPRT: rodar mais. `act` p50 · p95: 1,2 · 2,2 s; 2,9 consultas ao Jev por tarefa. Arquivo: `teste2-real-v1-sem-expect.{json,md}`.

| Família | Sucesso | `act` p50 | Consultas/tarefa |
|---|---|---|---|
| `abas` | 20/20 | 0,8 s | 2,0 |
| `acordeao` | 20/20 | 0,8 s | 2,0 |
| `selecao` | 20/20 | 1,6 s | 3,6 |
| `confirmacao` | 20/20 | 1,2 s | 3,0 |
| `quantidade` | 20/20 | 1,0 s | 2,8 |
| `paginacao` | **18/20** | 1,7 s | 3,9 |
| `menu` | **17/20** | 2,2 s | 2,9 |

**As 5 falhas são paradas honestas, em duas classes que o conjunto 1 não tinha:**

1. **"Carregar mais" até o fim** (`paginacao` 15 e 19, ES/EN). O item estava na 4ª leva e eram precisos 3 cliques. O Jev clicou 2 vezes e depois pediu para rolar uma página que nem rola (`scroll 0/1120`). Rolar não mudou nada, e o piloto parou por repetição. Correção provável:
   - quando o item do objetivo não está na página e há um controle de paginação, ele vence uma rolagem que não pode andar.
2. **Falso cognato entre idiomas** (`menu` 12, 17 e 19, todas iguais). O objetivo pede a categoria "Escritório", e a página em espanhol a chama de "**Oficina**", que em português é outra coisa. O Jev não fez a ponte, e a foto também não achou. Correções possíveis:
   - mandar ao Jev o idioma da página (`<html lang>`), pedindo que considere a tradução dos termos do objetivo;
   - ou uma tabela pequena de equivalências para menus e categorias.

As sementes 1–20 do conjunto 2 já foram vistas. Uma correção dessas classes se mede com `--seeds 21-40`.

