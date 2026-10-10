# Backend — warnings Rust (Melhoria do app v1)

Branch: `cc/mission-af28eea3-9aa7-4161-bb03-089fd86d`.

## Resultado

Warnings observados no Windows com `ags test run rust`:

| Diagnóstico | Antes | Depois |
| --- | ---: | ---: |
| lib | 44 | 0 |
| lib test | 14 (6 duplicados) | 0 |
| Cargo: mesmo arquivo para ags e ccode | 1 | 0 |

Helpers usados apenas por testes agora têm `cfg(test)`; imports e variáveis específicos de Unix têm o mesmo condicionamento de seus consumidores. Foram retirados o campo Reachable.key e o helper window_of sem consumidores de produção. APIs reservadas e itens dependentes de plataforma foram preservados com expectativas pontuais e justificadas. Nenhuma lógica de permissões, contenção de processos ou schema foi alterada.

O alias ccode tem uma entrada própria que reutiliza integralmente o módulo CLI e seu main. Não houve mudança de versão ou remoção do alias.

## Validação

- Baseline `ags test run rust`: passou; 248319 ms.
- Final `ags test run rust`: passou; 68130 ms; 1332 testes lib passaram, 10 ignorados; 40 testes CLI passaram; zero warnings.
- `ags test run tsc`: passou; 16784 ms.
- `ags test run frontend`: passou; 16046 ms.
- `ags test affected --dry-run`: selecionou suite Rust completa pelo arquivo de contenção, embora só anotações tenham mudado nele.
- `ags test affected`: passou, reutilizando o verde na árvore `ecbcf2103566e8004771799a5a5d58af0658ffce`.
- `git diff --check`: passou.

As suites Rust do AGS executam lib e bin ags. A entrada ccode não foi compilada diretamente por essa suite. Linux/CI não foram executados nesta entrega.

## Limitações e tempo

O alvo de 30 minutos foi excedido. A baseline consumiu cerca de quatro minutos; houve atraso interno do agente antes do fechamento. Não há medição confiável do tempo total.

As tentativas de envio ao Orquestrador e QA por `ags peer tell` falham neste terminal com ausência de ADE_TAB_ID. Não foi inventada identidade de outro terminal. A entrega e o commit devem ser encaminhados pelo chat.
