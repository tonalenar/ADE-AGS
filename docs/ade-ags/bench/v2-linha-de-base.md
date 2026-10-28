# Linha de base do benchmark v2 (16/10/2026, antes das Fases 1–5)

Código: `ee709f56` (dev com a Fase 0). Instância de debug isolada (`ADE_AGS_DATA_DIR` próprio), Jev real. Semente 1.

| conjunto | rodadas | sucesso | falso «feito» | falso «parou» | travamentos | consulta p50 · p95 | passo p50 · p95 | arquivo |
|---|---|---|---|---|---|---|---|---|
| locais (27 tarefas × 2) | 54 | 47/54 (87%) | 2 | 3 | 0 | 305 · 341 ms | 1007 · 2999 ms | `v2-base-real-locais` |
| públicas (Wikipedia + SauceDemo × 2) | 8 | 6/8 (75%) | 1 | 0 | 0 | 304 · 374 ms | 522 · 1171 ms | `v2-base-real-publicas` |
| sondas Amazon (fora dos portões) | 2 | 0/2 | 0 | 0 | 0 | 299 · 305 ms | 1480 · 1508 ms | `v2-base-real-sondas` |
| simulado, 3 sementes × 3 repetições | 81 cada | 67% | 24 | 0 | 0 | 459 ms (modelo) | 753 ms | `v2-base-sim-1..3` |

Consultas ao Jev nesta linha de base: ~185 (locais ~162, públicas ~27, sondas ~2). Total da missão até aqui ≈ 525 (340 anteriores + 185).

Observações:
- A mediana por consulta já está ≤ 450 ms nesta instância (305 ms); a meta D2 precisa ser confirmada no pior caso (p95) e com bytes/tokens medidos (o relatório do `act` ainda não os traz; Fase 4.2).
- Travamentos 0 com a janela visível e sem a Amazon aberta: a Fase 1 precisa medir com janela minimizada e Amazon.
- Falhas locais: anúncios (N01), filtro lento (N04), autocomplete (N06), quantidade (N09). Públicas: P02 (página longa com links parecidos). Detalhes nos `.md` ao lado.
