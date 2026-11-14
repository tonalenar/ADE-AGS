# Bench de streaming do chat — 2026-11-14

## Coleta

Limite autorizado: uma resposta curta por provedor (cinco turnos). Foram iniciados cinco turnos em uma instância de desenvolvimento com diretório de dados temporário (`ADE_AGS_DATA_DIR`); nenhum dado de `~/.ags/data.db` foi usado. A coleta temporária marcou o início em `phase=working`, cada `delta` emitido pelo backend e commits React da timeline. Essa instrumentação foi removida depois da coleta.

Comando executado para a instância isolada (o diretório foi criado com `mktemp`; a variável de trace pertenceu apenas à instrumentação temporária):

```sh
export ADE_AGS_DATA_DIR="$(mktemp -d /tmp/ade-ags-chat-streaming.XXXXXX)"
ADE_CHAT_STREAM_TRACE=1 bun run tauri dev
```

Em outro terminal, usando o mesmo `ADE_AGS_DATA_DIR`, foi enviada uma mensagem curta por agente:

```sh
ags chat new "Responda em uma frase curta: o streaming está funcionando?" --agent <codex|claude-code|opencode|antigravity|cursor>
```

O tempo do primeiro delta é contado desde `phase=working`, que inclui spawn/handshake do processo. A cadência é a diferença entre timestamps de deltas do backend. O commit React é contado na timeline; não representa uma medição de paint do compositor.

## Resultado real da branch

| Provedor | 1º delta | Deltas por resposta | Cadência dos deltas | Fim do turno | Processo → tela |
|---|---:|---:|---:|---:|---|
| Claude | 1.861 ms | 1 | n/a (um delta) | 1.918 ms | Não coletado; a timeline foi aberta após a resposta |
| Codex | 2.995 ms | 5 | n/d (timestamps intermediários não preservados) | 3.133 ms | Não coletado; a timeline foi aberta após a resposta |
| OpenCode | 1.348 ms | 2 | intervalo mediano e p95: 13 ms | 1.381 ms | Não coletado; a timeline foi aberta após a resposta |
| Antigravity | 5.329 ms | 3 | intervalo mediano e p95: 25 ms | 5.384 ms | Primeiro commit React 32 ms após o primeiro delta; 2 commits para 3 deltas |
| Cursor | Sem delta | 0 | n/a | Erro após 20.176 ms | Não houve texto para mostrar; o provedor retornou limite semanal de uso |

O Cursor respondeu `Weekly usage limit reached` e não foi repetido. Uma resposta curta por provedor foi o teto observado.

## Referência anterior e comparabilidade

As fixtures registradas em 2026-11-09 são capturas reais anteriores, mas não são um A/B controlado: prompts, versões e tamanhos das respostas diferem; Claude e Codex não registram o instante do envio inicial. O OpenCode tem apenas fixture sintetizada. Portanto, seus dados servem como referência histórica de eventos/cadência, não como prova de ganho de latência.

| Provedor | Referência anterior | Branch medida | Comparabilidade |
|---|---|---|---|
| Claude | 2 deltas de texto registrados, intervalo 316 ms; TTFT não disponível | 1 delta; 1.861 ms após `phase=working` | Sem TTFT anterior comparável; resposta diferente |
| Codex | 2 deltas registrados, intervalo 239 ms; TTFT não disponível | 5 deltas; 2.995 ms após `phase=working` | Sem TTFT anterior comparável; resposta diferente |
| OpenCode | Sem captura real anterior | 2 deltas; 1.348 ms após `phase=working` | Antes não medido |
| Antigravity | 4.911 ms do evento `user_input` ao primeiro delta; 3 deltas; intervalos 161 e 30 ms | 5.329 ms após `phase=working`; 3 deltas; mediana/p95 25 ms | Capturas/prompts/modelos diferentes; não demonstra melhora no primeiro turno |
| Cursor | 2.605 ms entre mensagem e primeiro texto; 31 deltas; intervalo mediano 0 ms e p95 297 ms (resolução de 1 ms; há um intervalo de 2.130 ms durante a rodada de ferramenta) | Sem delta em 20.176 ms, limite semanal | Falha de cota, sem comparação de resposta |

O turno real confirma que Antigravity entrega deltas em streaming e a UI os comita logo depois; não foi possível medir o benefício da sessão persistente no segundo turno sem ultrapassar o teto autorizado. O primeiro turno do Antigravity não ficou mais rápido nesta amostra.

## Depois: chat Antigravity por ACP

Na correção do chat, Antigravity passou para `agy acp`, que entrega `agent_message_chunk` e `agent_thought_chunk` pelo adapter ACP compartilhado com OpenCode. A mesma instrumentação temporária marcou `phase=working` e cada delta do backend. Foram usadas duas respostas curtas reais do modelo `gemini-4-hydrogen-medium`, no diretório isolado descrito no relatório da execução; nenhuma resposta adicional foi enviada após estas duas.

| Prompt | 1º delta após `phase=working` | Deltas de texto | Cadência dos deltas de texto |
|---|---:|---:|---|
| Uma frase curta | 2.795 ms | 1 | n/a (um delta) |
| Poema de quatro versos | 2.420 ms | 3 | intervalos 75,1 e 13,8 ms; mediana 44,4 ms e p95 75,1 ms |

No poema, o raciocínio chegou em dois deltas antes da fala, que também chegou em blocos incrementais. O comparativo anterior em stream-json marcou 5.329 ms até o primeiro delta, 3 deltas de texto e intervalo mediano/p95 de 25 ms. As respostas são diferentes e as condições não formam um A/B controlado; os dois TTFTs ACP ficaram entre 2,4 e 2,8 s nesta amostra. A medição termina nos eventos do backend: commit React e paint da tela não foram coletados nesta rodada.
