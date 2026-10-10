# Melhoria do app v1 (squad E2E)

Missão de correções de baixo risco, uma melhoria por commit, cada uma com teste.

## Backend (commit 9c593ac)
- Warnings do crate Rust: 44 -> 0 na lib, 14 -> 0 nos testes, 1 -> 0 no alvo `ccode` (agora `src/bin/ccode.rs`, mesmo CLI).
- Nenhum código em uso foi removido. Detalhes em `BACKEND_WARNINGS.md`.

## Frontend (commits 6ec986c e a03e2ff)
- Esc em `RouteModal.tsx`: cede o Esc a controle focado com `aria-expanded=true`. Em campo de texto comum o Esc continua fechando a tela (desenho documentado). Teste: `routeModalEscape.test.tsx`.
- `aria-label` em 5 botões só de ícone que já tinham tooltip (SideHead, MissionsSection, WorkspacesPanel, SkillPalette, CustomAgentForm). Teste: `iconButtonsAria.test.ts`.
- Varredura i18n: 3 locales com 2774 chaves idênticas, nenhuma chave crua, nenhuma chave nova. Texto cortado sem tooltip: nenhum caso claro, nada alterado.

## QA
- `ags test smoke` no terminal do QA: 9/9 passaram, 0 falhas, 0 pulados.
- Diffs revisados: escopo respeitado e com teste em ambos os branches. `ags test affected` verde nos dois.

## Integração
- `ags test run rust`, `tsc` e `frontend` verdes no branch integrado (mesma árvore).
- Nada de schema, instalador, CI, permissões, segurança ou versões foi alterado.

## Tempo
Meta de 30 min. O Backend passou do alvo (cerca de 30 min só até o primeiro commit); o total da missão ficou acima da meta.
