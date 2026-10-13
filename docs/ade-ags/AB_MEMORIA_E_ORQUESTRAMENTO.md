# Teste A/B: a memória ajuda? o squad compensa?

Objetivo: parar de achar e medir. Dois testes independentes, com a mesma tarefa em cada braço.

## Como marcar

Ponha o marcador no começo do título da missão: `[AB:<grupo>:<braço>] resto do título`.

| Teste | Braços | O que muda |
|---|---|---|
| Memória | `com-memoria` e `sem-memoria` | `sem-memoria` sai sem a memória aprovada e sem o resumo de missões anteriores (`abArm.ts`). `com-memoria` é a missão normal. |
| Squad | `solo` e `squad` | Só marca o grupo. Quem monta a diferença é você: `solo` é uma missão com um único agente; `squad` usa o squad de sempre. |

O grupo (`mem-1`, `sq-1`…) liga os dois lados do par. Os dois lados devem ter o MESMO objetivo, escrito igual.

## Que tarefas usar

- Pequenas e com resultado checável por teste ou por `git diff` (um bug com teste que falha, um ajuste de texto com asserção).
- Que dependam de algo já decidido na memória (uma convenção, uma decisão, um arquivo de contrato). Sem isso a memória não tem o que acrescentar e o teste não prova nada.
- Na mesma branch base e com o mesmo estado do repositório: reverta o resultado do primeiro lado antes de rodar o segundo.

Sugestão de 3 pares para começar (cada um roda nos dois braços):
1. Mudar uma convenção documentada na memória (ex.: formato de uma mensagem).
2. Corrigir um bug cuja causa foi registrada em uma missão anterior.
3. Acrescentar um teste seguindo uma regra do projeto que só está na memória.

## O que se mede (`node scripts/ab-report.mjs [grupo]`)

- Entregue (missão `done` e aplicada) ou não.
- Duração (início ao fim da missão).
- Leituras de memória pedidas pelos agentes (buscas e aberturas, do registro de uso).
- Classe de falha, quando houve.

Complementos que o script não mede e você anota: se o resultado passou nos testes, quantos retrabalhos o orquestrador pediu e se a equipe repetiu um erro que a memória já evitava.

## Como ler

- Menos de 3 pares por braço é indício, não prova. O relatório avisa.
- Se o braço `sem-memoria` aparecer com leituras de memória, ele ficou contaminado (o agente achou `ags memory` por conta própria): descarte o par.
- Para a memória "valer a pena": o braço `com-memoria` entrega mais ou igual, em menos tempo ou com menos retrabalho, e os agentes de fato leram (leituras maiores que zero). Se entregam igual e ninguém leu, a memória não estava ajudando.
- Para o squad "compensar": mesma entrega com tempo e custo aceitáveis. Se `solo` entrega igual e bem mais rápido, o orquestramento não compensou para aquele tipo de tarefa.
