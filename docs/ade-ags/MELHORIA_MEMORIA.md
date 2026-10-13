# Melhoria da memória (missão a2d1dfc7)

Base: master a86fb2e3 (1.8.7). Sem mudança de schema, instalador, CI, permissões ou versões.

## Já estava corrigido (auditoria desatualizada)
- A1 (parcial): proposta pendente e revisão rejeitada já ficavam ocultas, com envelope de dados (`memory.rs`, commit 5256517b).
- A2: filtro de segredo já valia em `memory_propose`/`memory_update` (caminho comum de escrita, `memory.rs:358`), `memory_promote_fact` (`memory.rs:1085`) e Run Facts (`runs/store.rs:718`); testes com chave/token/senha falsos (5256517b, 70248879).
- M1: soft-delete/exportação (`memory/lifecycle.rs`). M2: compactação de rejeitadas e fila limitada a 256 (5a5ed6ff, `memory.rs:473`, `owner_quota` em `memory.rs:299`).
- A3 (Enter no lote): Enter já pulava contradições/exclusões e o botão tinha autoFocus; restava Enter com foco em Cancelar.

## Corrigido agora
| Item | Commit | Teste |
|---|---|---|
| A1: `memory.get(revision)` só devolve a revisão aprovada atual de entrada ativa (nega antiga, pendente, rejeitada, tombstone para Lead/worker) | 52403760 | `memory/tests.rs` (regressão Lead/Worker) |
| Enter no diálogo de lote só confirma com foco no botão | 9b9b5d16 | `bulkReview.test.ts`, `memoryInbox.test.tsx` |
| Origem em cada proposta (missão, agente, tipo, prioridade) | a21b0285 | `memoryInbox.test.tsx` |
| Aviso visual de prioridade alta | 04f61fb7 | `memoryInbox.test.tsx` |
| `title` em textos cortados, rótulo acessível no Cancelar, chaves nos 3 locales | 2434c9fd | `memoryI18n.test.ts` |

A janela do app NÃO foi aberta (testes em happy-dom).

## Ficou de fora
- M2 residual: o histórico aprovado ainda pode esgotar os 8 MiB; remover exige política de retenção.
- Nome do agente na origem: o backend só envia `actorKind`. `SharedMemoryPanel` não foi revisado.

## QA (uso real)
- Cache: mesma árvore em dois worktrees dá `já verde neste hash`; 1 byte invalida; dois `ags test run` simultâneos sem corrupção.
- CLI `suggest/search/history/index/open/export` ok; proposta pendente não aparece como aprovada para outro agente.
- `ags test smoke`: 9/9. Detalhes: `RELATORIO_TESTE_V18.md`.

## Suítes (árvore bff51602, integração)
- rust: verde (1378 lib + 45 CLI, 10 ignorados). frontend: 204 arquivos, 1728 testes verdes. tsc: verde.

## ags mission timings
Parede ~708 s (≈11,8 min); primeira delegação em 30,5 s; 39 execuções de teste (391 s no total, 12 reaproveitadas do cache); espera do orquestrador 0; gargalos: nenhum.
