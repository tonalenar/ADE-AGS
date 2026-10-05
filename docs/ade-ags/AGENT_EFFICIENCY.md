# Eficiência entre agentes

## Etapa 11 — ponto 5: menos conversa, mais memória

O briefing de missões em terminais orienta o Orquestrador a consultar os achados e a memória aprovada antes de perguntar de novo. Os integrantes consultam a memória da missão antes de pedir contexto e enviam uma única entrega final concisa, com resultado, decisões, arquivos tocados, testes e bloqueios. Atualizações durante o trabalho ficam reservadas a bloqueios e mudanças de decisão.

### Canais e escopos

- **Handoff Structured v1** registra a entrega entre Tasks do Mission Runtime: resumo, arquivos, testes, decisões, riscos, próximos passos e artefatos. O downstream usa o handoff já recebido; `task_result` recupera detalhes quando necessário. Esse contrato não é uma ferramenta de mensagens do canvas de terminais.
- **Entrega final no canvas** usa uma mensagem `ags peer tell` com os mesmos dados essenciais. Ela é uma passagem de contexto imediata, sem criar uma memória durável.
- **Shared Memory** guarda apenas conhecimento aprovado e útil depois. Use escopo `mission` para decisões e restrições duradouras daquela missão; use `workspace` para conhecimento que vale para o projeto. Uma sugestão só aparece em buscas após aprovação do usuário.

Resultados e arquivos de uma Task não devem ser duplicados em memória durável: use o handoff do Mission Runtime ou a entrega final do canvas. Antes de perguntar, consulte a memória aprovada e o handoff que já estiver disponível; pergunte apenas o dado ausente necessário para decidir ou desbloquear.

### Medição estática de tokens por mensagem

`ags peer tell` não informa tokens de entrada ou saída, e não há tokenizer por provider instalado nesta base. Por isso, a comparação abaixo é um cenário sintético equivalente, não telemetria de uma missão real. A estimativa é `ceil(bytes UTF-8 / 4)`; a contagem exata varia com o tokenizer do provider.

| Antes: esclarecimentos sem formato final | Tokens estimados | Depois: entrega padronizada | Tokens estimados |
| --- | ---: | --- | ---: |
| Integrante: “Terminei a implementação.” | 7 | Integrante: `resultado=implementado; decisões=mantive o contrato atual; arquivos=src/feature.ts; testes=vitest (passou); bloqueios=nenhum` | 32 |
| Orquestrador: “Quais arquivos você alterou e quais decisões tomou?” | 14 | — | — |
| Integrante: “Alterei src/feature.ts; mantive o contrato atual.” | 13 | — | — |
| Orquestrador: “Quais testes executou e houve algum bloqueio?” | 12 | — | — |
| Integrante: “Vitest passou; sem bloqueios.” | 8 | — | — |
| **Total** | **54 em 5 mensagens** | **Total** | **32 em 1 mensagem** |

Nesse exemplo controlado, a conversa cai de 5 para 1 mensagem e de 54 para 32 tokens estimados (−41%). A mensagem individual fica maior para carregar os cinco campos, enquanto o total cai por eliminar pedidos de esclarecimento. O resultado real deve ser medido com usage reportado pelo provider; esta base ainda não registra tokens de mensagens peer.
