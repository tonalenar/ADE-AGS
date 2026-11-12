# Autocompact de contexto

Quando o contexto de uma conversa passa do limiar, ao fim do turno a ADE pede ao agente a compactação **nativa** dele, mostra o estado na linha do tempo e segura as mensagens que chegarem durante a compactação. Decisão, regras e tabela dos agentes em [`docs/decisoes/AUTOCOMPACT.md`](../decisoes/AUTOCOMPACT.md).

## Onde está
| Peça | Arquivo |
|---|---|
| Núcleo puro (configuração, cálculo, decisão, reducer de eventos, tabela de agentes) e a cola (gatilho do fim do turno, estado em memória) | `src-tauri/src/conversa/autocompact.rs` |
| Testes | `src-tauri/src/conversa/autocompact_test.rs` |
| Claude Code: `status: compacting` e `compact_boundary` viram eventos; janela de contexto do `result` vai ao último `usage` | `conversa/claude_map.rs` (`compaction_event`, `context_window_of`), `claude.rs` (`Out::Compaction`, gatilho no `Out::Done`, janela de auto-compact no lançamento) |
| Codex: `thread/tokenUsage/updated` dá `context_tokens` e `context_window`; item `contextCompaction` vira evento; gatilho no `turn/completed` | `conversa/codex_map.rs`, `codex.rs` |
| Envio recusado (`Busy`) e `status().working` durante a compactação; trava de envio no pedido automático | `conversa/api.rs` |
| Configuração (`settings` → `chat.autocompact`), tabela de agentes e comando `chat_autocompact_plans` | `autocompact.rs`, `conversa/commands.rs` |
| Tela: Configurações → Chat → Autocompact de contexto | `src/features/chat/autocompact/AutoCompactSetting.tsx` |
| Medidor de contexto do composer | `autocompact/ContextMeter.tsx`, `model.ts` (`contextUsageOf`) |
| Aviso na linha do tempo | `autocompact/CompactionRow.tsx`, chamado pelo `NoticeRow` |
| Fila durante a compactação | `queueRunner.ts` (`stateOf`, `sendNow`), `StructuredConversationView.tsx` |

## Fluxo
1. O turno acaba (`result` do Claude, `turn/completed` do Codex). Se acabou bem, `autocompact::after_turn` roda em segundo plano.
2. `run` lê a configuração, o último `usage` com a janela, a última compactação, os pedidos pendentes e se há turno, e passa tudo a `decide` (pura). Os motivos de não compactar: desligado, sem suporte, o agente compacta sozinho, turno em andamento, já compactando, pedido pendente, sem medida, medida anterior à última compactação, mesma ponta já tentada, abaixo do limiar.
3. Se decidiu compactar: registra a tentativa e o contexto de antes e chama `api::compact_context_inner(automatic)`: `/compact` como linha `user` (Claude) ou `thread/compact/start` (Codex), sob a trava de envio da conversa.
4. Os eventos do agente (ou o aceite do pedido, no Codex) passam por `autocompact::on_event`, que grava o aviso `Notice` `compaction` (o mesmo id vai de «Compactando…» a «Contexto compactado») e emite `item`. O fim do turno fecha uma compactação que ficou aberta, e `phase: idle` acorda quem espera (`ags chat wait`, a fila entre agentes).
5. Uma compactação que não termina deixa de segurar a conversa depois de 10 min (`ACTIVE_TTL_MS`).

## Configuração
`settings` `chat.autocompact`: `{"enabled":true,"agents":{"codex":{"enabled":true,"thresholdPct":80}}}`. Padrão: ligado, 83%, de 50% a 95%. Só a tela altera. O limite em tokens por perfil do Claude Code (Compactação automática do Claude Code) continua valendo e vence o limiar em %.

## Limites conhecidos
- Medida do Codex precisa do `modelContextWindow` do app-server; sem ele não há medidor nem disparo.
- O limiar em % vira a janela de auto-compact do Claude Code só quando a janela do modelo é conhecida (`[1m]` no modelo ou um `result` anterior da conversa); senão vale o padrão do Claude (≈ o mesmo 83%).
- Terminais: nunca digitados pela ADE (ver a decisão).
- A tabela da tela não cobre o Gemini CLI na prática (CLI não instalada aqui); ele compacta sozinho (`/compress`).
