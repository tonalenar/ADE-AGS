# Relatório — Teste completo v5 (squad E2E)

Versão testada: ADE AGS / CLI 1.8.7, build 4ba67e4 (merge do PR #154; o briefing citava 575573d, um merge anterior — não é divergência real). Nenhum código do produto foi alterado.

## Resumo
Nenhum bug bloqueante, alto ou confirmado de gravidade média no produto. Dois itens baixos (um estático, um de fluxo de mensagens) e uma limitação de cobertura importante: **a UI real (Missões, Squads, Configurações/Decisões, Histórico, Frota, Canvas, Novo agente) não foi exercitada ao vivo**; o Frontend só conseguiu revisão estática e o QA não trouxe evidência de interação com a janela. Essa parte segue pendente de olho humano.

## Achados

### Médio (observado, fora do produto-alvo direto)
1. **`peer tell` devolve `sent:true` mas a mensagem se perde quando o destino está rodando um slash command.** Repro: com o Frontend (Claude Code) executando `/auto-mode-setup`, `ags peer tell Frontend --file tarefa.txt` retornou `sent:true`; a tarefa nunca apareceu na tela dele (ficou "aguardando delegação"). Reenviar o mesmo arquivo retornou `duplicate:true` ("já entregue há pouco") e não enviou; só funcionou com texto alterado. Efeito: integrante parado 4+ min até o aviso do Vigia. Sugestão: confirmar entrega real ou não marcar duplicata se o destino não consumiu a mensagem.

### Baixo
2. **Esc em listbox com foco em opção fecha a tela cheia** (`src/app/RouteModal.tsx:37`, confirmado por leitura de código; não reproduzido ao vivo). Só `document.activeElement` com `aria-expanded="true"` poupa a tela; se o foco estiver numa opção (`role="option"`) de um popup com foco móvel, o Esc fecha a rota inteira. Comboboxes com foco no input e `aria-activedescendant` não são afetados. Repro: tela cheia > abrir seletor > mover foco para uma opção > Esc.
3. **`peer ask` do Backend ficou ~4 min 25 s sem resposta** (`orchestratorStall` 264,7 s nos timings) porque o Orquestrador estava em turno longo; minhas respostas entraram na fila ("O destino está trabalhando"). Comportamento esperado do enfileiramento, mas o pedido era só uma confirmação de integridade; vale o Vigia/aviso distinguir ask trivial.
4. i18n (info): `es.json` tem 321 valores idênticos ao pt-BR com texto (en: 72); não conferidos um a um — candidatos a tradução faltando.

### Descartado após conferência
- QA: "scripts referenciam `/tmp` no Windows" — comportamento de comandos de agente, não do produto.
- QA: afirmações de "tela cheia/maximizada estável" e "restauração de abas íntegra" baseiam-se em leitura de SQLite/código, não em observação da janela; contam como não verificadas.

## Verificado OK
- i18n: pt-BR, en, es com 2821 chaves cada, nenhuma faltando, placeholders {{x}} consistentes.
- Nenhum `<button>` só de ícone sem aria-label/title/texto (varredura estática; wrappers não cobertos). `RouteModal` já trata Esc com diálogo aberto e `aria-expanded`.
- `ags test smoke` (dentro do terminal do QA): 9/9 passos passaram, 0 pulados, 0 falhas (tab list, tab output, tab/missão inexistentes recusadas, peers, memory index, `--file` íntegro, `--file` inexistente, peer tell a destino inexistente).
- CLI: tab, mission status/timings, memory index/open/search, peers e `peer tell --file` com aspas, acentos, `$HOME` e crase chegaram íntegros; IDs inexistentes dão erro claro (exit 1).
- Cache por suíte: `ags test run frontend` repetido → `cacheHit:true`; mudança só de comentário no frontend não refez o cargo; `ags test affected` pulou o Rust (`skippedAffected`).

## Tempos das suítes (primeira execução, sem cache)
| Suíte | Medido | Base | Variação |
|---|---|---|---|
| rust | 135,7 s (1356 lib + 40 CLI ok, 10 ignorados) | ~164 s | −17% |
| frontend | 23,8 s (197 arquivos / 1649 testes) | 18 s | +32% |
| tsc | 19,6 s | 23 s | −15% |
Frontend e tsc rodaram enquanto o Rust compilava; não é benchmark isolado.

## Vigia (ligado pelo QA)
- ~07:39 avisou que o Frontend estava ocioso aguardando delegação (correto: a tarefa tinha se perdido, ver achado 1).
- Avisou também sobre a entrega estática do Frontend ainda na fila e sobre a espera do Orquestrador pela entrega do QA; os avisos foram úteis e acionáveis. Alguns chegaram depois de a pendência já estar resolvida (avisos sobre Frontend/Backend "sem escrever nada" após minha mensagem de agradecimento pedindo ociosidade) — ruído baixo.
- Codex (Backend): nenhum "Working" prolongado nem laço de raciocínio vazio nesta missão (turnos curtos).
- Aviso "equipe entregou": não observado ao vivo com os três reportando.
(Horários vindos do relato do QA e dos avisos recebidos; não verificados no chat.json.)

## Tempos da missão (`ags mission timings`, snapshot final)
Ativa 800 s; parede 756 s; primeira delegação 37,9 s; equipe trabalhando em 28,8 s; esperas do Orquestrador: 1 stall de 264,7 s; testes: 11 comandos, 198 s, 2 por cache, 9 pulados por affected. Turnos: 17, máx. 356 s.

## Não coberto
Telas ao vivo (texto cortado, botões sem resposta, canvas: halo/alças/portas/minimapa/dock, aviso de privacidade em Decisões, missão iniciada abre canvas, missão falha com "iniciar", Esc em tela cheia real), terminais em branco, restauração de abas e janela maximizada observadas na UI, três idiomas na UI.

## Complemento do QA (leitura de código, não UI ao vivo)
- O QA declarou que a janela Tauri não é acessível a agentes (sem porta CDP; portas 9222/5173 fechadas; handle da janela zerado). Confirma que a UI real não foi exercitada por ninguém.
- Por leitura de código, sem execução: o aviso de privacidade em Decisões (`sendsOffMachine`: provedor ≠ none e URL não local, `settings.decisions.remoteWarn`) existe e nada é salvo sem clicar em Salvar; iniciar missão chama `startMissionInTerminals` e navega para `/workspace`; missão `failed` oferece a ação "retry" nos 3 idiomas; `routeModalEscape.test.tsx` cobre o Esc (o caso de foco em `role="option"` segue como achado baixo 2).
- O QA contou 353 valores iguais entre es e pt-BR (o Frontend contou 321) e os considerou termos idênticos legítimos; divergência de contagem e classificação não verificadas.
- `~/.ags/data.db` não foi alterado (só leitura).
