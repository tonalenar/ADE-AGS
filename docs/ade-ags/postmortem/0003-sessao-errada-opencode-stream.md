# 0003 — Aba do Claude Code grava a sessão `opencode_stream`

| Campo | Valor |
|---|---|
| Data do incidente | 2026-10-09 (achado A2 do teste completo v3) |
| Gravidade | alta (resume quebrado em silêncio) |
| Área | descoberta de sessão (`src-tauri/src/session/title.rs`) |
| Correção | `4fe76836` em `dev`; na missão de teste, `69ee16f` na branch do Generalist |

## Resumo de 30 segundos
No Windows, abas do Claude Code gravavam `session_id = opencode_stream`, o nome de uma fixture de teste do próprio repositório. Ao restaurar, o app montava `claude --resume opencode_stream` e a conversa não voltava. A causa era um `PathBuf::join` com caminho absoluto, que descarta a base: a busca de sessão "legacy" virava o worktree inteiro e pegava o `.jsonl` mais novo, a fixture. A correção restringe o fallback a um único componente dentro de `projects`.

## Linha do tempo
| Quando (−03:00) | O quê | Fonte |
|---|---|---|
| 2026-09-28 | A fixture `runs/fixtures/opencode_stream.jsonl` entra no repositório | `a6f66c4e` |
| 2026-10-09 | O teste completo v3 acha `opencode_stream` em `tabs.session_id` e em `session_history` de `~/.ags/data.db` | `RELATORIO_TESTE_COMPLETO.md`, A2 |
| 2026-10-09 15:03 | Relatório publicado | `fdc5f32f` |
| 2026-10-09 15:09 | Correção em `dev`: `claude_legacy_project_dir` só aceita um componente normal dentro de `projects` | `4fe76836` |

## Causa
- `claude_project_dir` (`session/title.rs:188-203`, na época) caía no fallback "legacy" `projects.join(cwd.replace('/', "-"))` quando a pasta `projects/<slug>` ainda não existia, na primeira sondagem logo após abrir a aba.
- No Windows o cwd usa `\`, então o `replace` não mudava nada. Com caminho absoluto, `PathBuf::join` **descarta a base**, e o "legacy" virava o próprio worktree.
- `claude_session_file` (`:205-220`) varria esse worktree recursivamente, inclusive `node_modules` e `target`, e `newest_matching` escolhia o `.jsonl` mais novo. `claude_stream.jsonl` e `opencode_stream.jsonl` tinham o mesmo mtime, e o desempate devolvia `opencode_stream`.
- `Terminal.tsx:307` (`if (knownSessionId) return;`) parava a descoberta, então o valor errado não era corrigido com a aba aberta. Só `resolve_for_archive`, ao fechar a aba, o corrigia.

## Por que cada rede de proteção falhou
| Rede | Por que não pegou |
|---|---|
| Testes | Nenhum teste exercitava um cwd absoluto com `\`; os três testes que cobrem isso entraram com a correção (`4fe76836`). Com `/`, o `replace` produz um nome relativo e o defeito não aparece. |
| CI do Windows | Só roda `cargo check`, não os testes (`.github/workflows/ci.yml`). |
| Validação do id | `isSafeSessionId` aceita `opencode_stream`: o id era seguro, só não era o certo. |
| Descoberta | Parava no primeiro valor e não reconferia. |
| Varredura | Uma busca recursiva no cwd não tinha limite de pasta nem exclusão de `node_modules`/`target`. |

## Guardrails
| Trava | Onde | Estado |
|---|---|---|
| Fallback restrito a um componente normal dentro de `projects`; rejeita `\`, raiz, prefixo, `.` e `..` em qualquer SO | `claude_legacy_project_dir` em `src-tauri/src/session/title.rs` | feito (`4fe76836`) |
| A busca nunca pega transcript de dentro da árvore do projeto | `src-tauri/src/session/test.rs` | feito (`4fe76836`) |
| Corrigir as linhas já gravadas com `opencode_stream` | — | pendente no relatório; não achei commit que o faça (`git log -S opencode_stream`) |
| Testes `#[cfg(windows)]` rodados no CI | — | proposto, não feito (hoje são rodados à mão) |

## O que não se sabe
- Quantas abas de usuários reais ficaram com o id errado. O teste viu duas, em dois worktrees (`1092a83e` e `6429bed1`).
- Que a conversa não é retomada foi inferido do código; não foi reaberto ao vivo (relatório, A2).

## Fontes
- `docs/ade-ags/RELATORIO_TESTE_COMPLETO.md`, seções "Alto › A2" e "Correções".
- Commits `a6f66c4e`, `fdc5f32f`, `4fe76836`.
