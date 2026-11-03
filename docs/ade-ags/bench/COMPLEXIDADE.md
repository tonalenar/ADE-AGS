# Bench de complexidade do backend

Gate por razão e orçamento calibrado para três caminhos quentes: o `digest` da saída de terminal, o leitor de transcript do canal e o scrollback do PTY. Ideia do deepseek-harness (MIT), ponto 23 da análise.

## Como roda

```bash
node scripts/bench-rust.mjs
```

- Cada caso é um teste `#[ignore]` em `src-tauri/src/bench/mod.rs`. Ele mede a mesma operação com uma dimensão pequena e com ela 32× maior, e imprime `BENCH {json}`.
- `scripts/bench-rust.mjs` pega o binário de teste da lib (`cargo test --lib --no-run`) e roda cada teste em **N processos frescos** (padrão 5, `--n` muda). Cada caso é julgado pela **mediana**.
- **Gate por razão:** mediana(grande) ÷ mediana(pequeno) ≤ **4×**. Não depende da máquina: pega um O(n²) ou um custo que cresce com o teto.
- **Orçamento:** mediana ≤ `ceil(esperado × ESCALA × 1,25)`. O `esperado` foi medido na máquina de referência. **Não há variável de ambiente para afrouxar**; mudou o desempenho de propósito, meça de novo e atualize `ESPERADO_MS` no mesmo PR.
- Fica fora da suíte normal (`#[ignore = "bench: …"]`): dentro do `cargo test` paralelo, um teste de tempo mede os outros testes. No CI roda num passo próprio, depois do `cargo test`, que já deixa o binário compilado.
- Perfil: o de teste (debug), o mesmo que o CI já compila. Os números absolutos são de debug; a razão vale igual.
- Não gasta cota: nada aqui chama modelo, rede ou o Jev. O `scripts/jev-bench.ts` mede o piloto do navegador e continua à parte; este driver segue a mesma regra de mediana dele (`scripts/bench/core.ts`).

## Casos
| Caso | Dimensão que cresce 32× | O que o gate pega |
|---|---|---|
| `digest/misto` | linhas de um log de build (1.000 → 32.000), custo por linha | `digest` deixar de ser linear |
| `digest/so-erros` | linhas, todas erros distintos (1.000 → 32.000) | O(n²) na agregação de erros |
| `scrollback/ingestao` | teto do scrollback (96 KiB → 3 MiB), mesma saída de 64 MiB | corte do buffer por pedaço, sem a margem em lote |
| `scrollback/fim` | tamanho do buffer (96 KiB → 3 MiB), lendo 64 KiB do fim | `tail_of` voltar a copiar o buffer inteiro |
| `canal-tail/primeira-leitura` | tamanho do transcript (1 MiB → 32 MiB) | ler o arquivo do começo em vez da janela do fim |
| `canal-tail/incremental` | tamanho do transcript, 200 leituras de 16 KiB novos | reler o que já foi lido |

No digest, o caso pequeno roda 4 vezes e o tempo é escalado para 32 rodadas: os dois lados contam o mesmo total de linhas, e a razão é a do custo por linha.

## Números medidos
Máquina de referência: Apple M2, 8 núcleos, macOS, perfil de teste. **A máquina estava carregada** (load average 20–28, outras sessões compilando): numa máquina ociosa os tempos são menores, e a variação entre rodadas chegou a 3× no `digest/misto`.

Calibração (2026-11-02), `node scripts/bench-rust.mjs --n 9 --json`:

| Caso | Pequeno (ms) | Grande (ms) | Razão |
|---|---|---|---|
| `digest/misto` | 749,2 | 751,8 | 1,00× |
| `digest/so-erros` | 391,5 | 435,9 | 1,11× |
| `scrollback/ingestao` | 12,5 | 23,6 | 1,89× |
| `scrollback/fim` | 190,6 | 206,5 | 1,08× |
| `canal-tail/primeira-leitura` | 146,7 | 151,8 | 1,04× |
| `canal-tail/incremental` | 130,2 | 103,8 | 0,80× |

- A razão da ingestão (1,9×) é efeito de cache: os bytes movidos são os mesmos nos dois tetos, mas 3 MiB não cabem no cache. Não é o O(teto) por pedaço, que daria ~32×.
- O bench inteiro, com N = 5, levou 18,5 s nesta máquina.

### O gate achou um O(n²) no `digest`
Na primeira rodada, `digest/so-erros` falhou. `push_unique` (`src-tauri/src/orchestrator/digest.rs`) procurava cada erro novo com uma busca linear na lista dos já vistos: com milhares de erros distintos (um `tsc` quebrado no scrollback de 3 MiB), o digest ficava quadrático. A correção acrescenta um índice `HashMap` texto → posição, com a mesma ordem de aparição e a mesma contagem.

`node scripts/bench-rust.mjs --n 5 --casos so-erros`, mesma máquina e carga:

| | Pequeno (ms) | Grande (ms) | Razão |
|---|---|---|---|
| Antes | 1.980,4 | 26.258,7 | **13,26×** (falha) |
| Depois | 840,5 | 1.026,0 | 1,22× |

Os 26 testes de `orchestrator::` continuam passando.

## Escala do CI
`ESCALA = 3` é um **chute conservador, não medido**: o runner do CI (ubuntu-22.04 x64) nunca rodou este bench. Depois do primeiro run, troque pelo quociente medido (mediana do CI ÷ mediana da referência). Se o orçamento estourar no CI sem a razão estourar, é a escala que está errada, não o código.

## Não verificado
- O bench no CI (o passo existe em `.github/workflows/ci.yml`, mas nenhum PR rodou ainda).
- Números em máquina ociosa e em perfil release.
