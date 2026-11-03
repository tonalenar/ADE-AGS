# 0002 — O HMR do Vite derrubou PTYs de missão

| Campo | Valor |
|---|---|
| Data do incidente | não registrada (antes de 2026-10-17) |
| Gravidade | alta (terminais e agentes de uma missão em andamento perdidos) |
| Área | terminal, frontend em modo dev |
| Correção | não há correção de código; a trava é de processo |

## Resumo de 30 segundos
Com uma missão rodando, uma mudança de frontend chegou ao app em uso pelo HMR do Vite, e os PTYs da missão caíram (`AGENTS.md` §2.1). O mecanismo documentado: desmontar `<Terminal>` mata o PTY, e vários módulos do front guardam estado de módulo que um HMR reinicia. Desde então a regra é não atualizar nada que o app em uso carrega enquanto houver missão, e testar na instância isolada.

## Linha do tempo
| Quando | O quê | Fonte |
|---|---|---|
| antes de 2026-10-17 | PTYs de missão derrubados por HMR. Data, missão e mudança não registradas | `AGENTS.md` §2.1 ("o HMR do Vite já derrubou PTYs de missão") |
| 2026-10-17 | A auditoria proíbe atualizar o app com a missão `d7b03196` (CredPro) rodando, "risco de HMR derrubar os PTYs" | `docs/ade-ags/AUDITORIA_2026-10-17.md`, "Restrições para executar" (`dca2f2b1`) |
| 2026-10-17 | O estado do Vigia passa a ser guardado, porque "um HMR ou reabrir o app" repetia avisos | `5865f4d1`; comentário em `src/features/missions/vigia.ts` (`WATCH_STORE_KEY`) |
| 2026-10-20 | A regra entra no `AGENTS.md` (regras de ouro) e os módulos frágeis no `FRONTEND.md` | `3a0491f0` |
| 2026-10-22 | A regra entra na tabela "Formas de se machucar" | `5d7e02d7` |

## Causa
- Desmontar `<Terminal>` mata o PTY ([AGENTS.md](../../../AGENTS.md) §2.1).
- `tabs/store.ts`, `layout/layoutStore.ts`, `canvas/store.ts`, `terminal/terminalRegistry.ts`, `missions/terminals.ts` e `tabs/persistence.ts` guardam estado de módulo. Um HMR de um deles, ou de quem os importa, recria esse estado com o app em uso ([FRONTEND.md](../../agentes/FRONTEND.md), "Pontos frágeis").
- O Vite em modo dev serve o próprio checkout: uma mudança commitada ou copiada nele chega ao app em uso sem reinstalação (por isso a regra fala em "checkout, HMR, instalação", `AGENTS.md` §2.6).

## Por que cada rede de proteção falhou
| Rede | Por que não pegou |
|---|---|
| Separação de ambientes | A instância isolada (`scripts/dev-local.ps1`, com `ADE_AGS_DATA_DIR` próprio) só existe desde 2026-10-15 (`7603f3f4`). Se o incidente foi antes ou depois dela, não está registrado. |
| Intuição de "só frontend" | A regra precisa dizer "nem mudança 'só de frontend'" (`AGENTS.md` §2.1): o risco óbvio é a reinstalação, e o do HMR não é. |
| Testes e CI | Nenhum teste roda o app em uso com HMR. É uma falha de operação, não de lógica. |
| Persistência | O estado de missão no front (o do Vigia, por exemplo) vivia só em memória, e o HMR o perdia junto. |

## Guardrails
| Trava | Onde | Estado |
|---|---|---|
| Regra de ouro: com missão rodando, nada que o app carrega é atualizado | [AGENTS.md](../../../AGENTS.md) §2.1 e §2.6 | feito (`3a0491f0`, `5d7e02d7`) |
| Lista dos módulos com estado de módulo | [FRONTEND.md](../../agentes/FRONTEND.md), "Pontos frágeis" | feito (`3a0491f0`) |
| Instância de debug isolada para testar | `scripts/dev-local.ps1`, [DEV_LOCAL.md](../DEV_LOCAL.md) | feito (`7603f3f4`) |
| Estado do Vigia sobrevive a HMR e reabertura | `ags.vigia.watches.v1` em `vigia.ts` | feito (`5865f4d1`) |
| Aviso automático quando um HMR vai atingir um módulo com estado de terminal e há missão ativa | — | proposto, não feito |

## O que não se sabe
- A data, a missão, a mudança que disparou o HMR e quantos PTYs caíram. O repositório só registra a lição, não o incidente. Quem viu pode completar este postmortem.

## Fontes
- `AGENTS.md` §2.1 e §2.6; `docs/agentes/FRONTEND.md`, "Pontos frágeis".
- `docs/ade-ags/AUDITORIA_2026-10-17.md`, linhas 67 e 166.
- Commits `7603f3f4`, `5865f4d1`, `dca2f2b1`, `3a0491f0`, `5d7e02d7`.
