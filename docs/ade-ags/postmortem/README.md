# Postmortems

Um postmortem conta um incidente real: o que quebrou, por que as redes de proteção deixaram passar e qual trava existe agora. Serve para a lição virar regra rastreável, e não só uma linha nos "Pontos de atenção".

A ideia veio do `docs/postmortem/` do deepseek-harness (MIT), ponto 25 da análise do harness.

## Quando escrever
- Algo chegou ao usuário ou a uma missão real: terminal derrubado, dado perdido ou errado, aviso falso em massa, resume quebrado.
- Ou quase chegou, e só não chegou por sorte.
- Bug pego pelo teste ou pela revisão antes do merge não precisa de postmortem.

## Regras
- **Sem culpados.** O texto fala de código, processo e rede de proteção, não de quem errou (pessoa ou agente).
- **Sem fato inventado.** Cada afirmação tem fonte: commit, `arquivo:linha`, relatório, auditoria. O que não está registrado fica em "O que não se sabe", nunca preenchido por dedução.
- **Guardrail com link.** Cada trava aponta para o teste, a regra ou o check que a implementa. Trava proposta e não feita aparece como **proposta**.
- Em PT-BR, sem BOM, como o resto de `docs/`.

## Nome e numeração
`NNNN-titulo-curto.md`, com quatro dígitos e em ordem de escrita, não do incidente. Número não se reutiliza.

## Formato

```markdown
# NNNN — Título

| Campo | Valor |
|---|---|
| Data do incidente | AAAA-MM-DD (ou "não registrada") |
| Gravidade | alta · média · baixa |
| Área | Vigia, terminal, sessão… |
| Correção | commit(s) |

## Resumo de 30 segundos
Três a cinco frases: o que a pessoa viu, a causa e o que mudou.

## Linha do tempo
| Quando | O quê | Fonte |

## Causa
O mecanismo, com `arquivo:linha` do código da época.

## Por que cada rede de proteção falhou
| Rede | Por que não pegou |
(tipos, testes, revisão, CI, Vigia, a própria regra…)

## Guardrails
| Trava | Onde | Estado |
(feito, com link · proposto)

## O que não se sabe
## Fontes
```

## Índice
| # | Título | Área | Gravidade |
|---|---|---|---|
| [0001](0001-vigia-segundos-vs-milissegundos.md) | Vigia avisa "sem tarefa há 29 milhões de minutos" | Vigia | alta |
| [0002](0002-hmr-derrubou-ptys-de-missao.md) | O HMR do Vite derrubou PTYs de missão | terminal | alta |
| [0003](0003-sessao-errada-opencode-stream.md) | Aba do Claude Code grava a sessão `opencode_stream` | sessão | alta |
| [0004](0004-vigia-avisos-repetidos.md) | O mesmo aviso do Vigia 32 vezes numa missão | Vigia | média |
