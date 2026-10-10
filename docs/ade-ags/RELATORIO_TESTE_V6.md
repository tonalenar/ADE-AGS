# Relatório de teste v6 (squad E2E)

Data: 2026-10-10 · Versão instalada: ags 1.8.7 · master 036844d · Missão a022ad05-0f0d-44a2-92a2-3afebbf32e7f
Equipe: Orquestrador (Claude Code), Backend (Codex), Frontend (Claude Code), QA / Tests (Antigravity).
Nenhum código do produto foi alterado; nenhuma escrita em `~/.ags/data.db`; nada tocado em Contas, chaves ou Ajustes > Decisões.

## Resumo

Nenhum achado bloqueante ou alto. Dois achados (1 médio, 1 baixo) e várias verificações que **só o usuário pode fazer** na interface real (agentes não abrem a janela do app).

## Achados

### [MÉDIO] pt-BR: placeholder `{session}` traduzido na dica de argumentos de retomada
- Arquivo: `src/i18n/locales/pt-BR.json:174` (`settings.tuis.resumeArgsHint`). Aparece em Novo agente > TUI personalizada (`CustomAgentForm.tsx`, campo `resumeArgs`, placeholder `--resume {session}`).
- pt-BR: "Deve incluir {sessão}. por exemplo --resume {sessão} ou retome {sessão}". en/es mantêm `{session}` e `resume`.
- Efeito: a dica ensina o usuário pt-BR a digitar `{sessão}` e `retome`, que não são o placeholder nem o subcomando. Confirmado por leitura do JSON e do código (Frontend e Orquestrador); o comando de retomada com `{sessão}` não foi executado.
- Correção sugerida: manter `{session}` e `resume` sem traduzir.

### [BAIXO] `peer tell` normal bloqueia o CLI por ~3,5–4,7 s
- Reprodução: num terminal de integrante, cronometrar `ags peer tell "<destino>" "<texto novo>"`. Resposta `sent:true` correta, mas após 3685 ms e 3676 ms (Orquestrador), 4090 e 4741 ms (Backend), 3,5–4,7 s (QA). Controle `ags peers`: 27–61 ms. Reenvio de texto idêntico ao anterior: 57 ms (provável curto-circuito de duplicata).
- Esperado pela missão: "sem atraso perceptível". Entrega funciona; só a latência do CLI.
- Hipótese do QA (por leitura de código, não medida): soma de esperas de confirmação em `peers.rs`/`tabs.rs` (silêncio do PTY 1500 ms, `ECHO_QUIET` 250 ms, confirmação até 1500 ms com polling de 250 ms). Estado ocioso do destino não foi controlado em todas as medições. Pode ser o preço da nova confirmação de entrega; decidir se é aceitável.

### [BAIXO] Textos idênticos ao inglês (revisão pendente)
es: 137 chaves, pt-BR: 73 (filtro grosseiro; muitos podem ser nomes próprios/comandos). Não revisado um a um.

## Itens de fiscalização da missão

### `peer tell` confere a entrega — OK
- Destino ocupado (QA enviou `/status` ao Frontend e logo um `tell --file`): 1º envio `sent:false, unconfirmed:true` com a nota de reenvio; após fechar o diálogo, reenvio do mesmo arquivo `sent:true`, **sem recusa de duplicata**. Backend viu o mesmo comportamento com destino ativo (sent:false/unconfirmed:true, 4272 ms; reenvio sent:true/queued:true).
- `--file` com aspas duplas/simples, acentos, `$HOME`, `${USER}`, crase e bloco de crases: íntegro, confirmado pelos receptores (Orquestrador, Frontend).

### Suítes (via `ags test`, sem cargo/vitest/tsc crus)
| Suíte | Resultado | Tempo | Linha de base | 2ª execução |
|---|---|---|---|---|
| rust | passou (lib 1359 ok, 10 ignorados; bin ags 40 ok) | 127,7 s | ~136 s | cache, 0 ms |
| frontend | passou (197 arquivos, 1651 testes) | 13,9 s | 18 s | cache, 0 ms |
| tsc | passou | 16,9 s | 23 s | cache, 0 ms |

`ags test affected --dry-run` e `affected`: nada a testar (árvore sem alterações de código); isso valida a seleção vazia, não a invalidação de cache com código alterado.

### `ags test smoke` (QA, no próprio terminal)
9 de 9 passaram, 0 falhas, 0 puladas: app responde, tab output, tab inexistente recusada, missão inexistente recusada, peers, índice de memória, `--file` íntegro (92 chars), `--file` inexistente com erro claro, `peer tell` a destino inexistente recusado.

### CLI
Passaram: `app status`, `tab list`, `tab output`, `mission status`, `mission timings`, `peers`, `peer check`, `memory index|open|search|suggest`. Nota: o shell das ferramentas do Codex não herdou `ADE_TAB_ID` (efeito do ambiente/sandbox Codex no Windows, já conhecido).

### Laya (modo sombra), somente leitura
- Configuração (SELECT restrito): ligada, provedor `laya_local`, `http://localhost:8000`, modelo `multilingual`, timeout 2000 ms, os quatro pontos ligados.
- `decision_shadow_log`: **1 linha** (id 1, `mission_gate`, 390 ms, sem erro, heurística e Laya concordam: `gate=entregar`), gravada **antes** da missão (ts 1791631942, início 1791632064). Contagem no início e no fim da missão: 1. **Linhas gravadas durante a missão: 0.**
- Latência 390 ms (alvo < 2 s); erros 0; timeouts 0; concordância 1/1 (amostra mínima, não generalizar). Nenhuma linha de memória, sonho ou frota.
- Por que não houve linhas de memória: segundo o Backend (leitura de código, `src-tauri/src/memory/review.rs:241,343`), `memory_approval` só dispara ao abrir a revisão das propostas, não no `memory suggest`. Não tratado como bug. Gerar amostras exigiria abrir a revisão na interface (só leitura), o que ficou para o usuário.
- A tabela guarda `state_hash` (64 caracteres), nunca o texto.
- Impacto no tempo da missão: nenhuma espera ou timeout atribuível à Laya.
- A tela Decisões (relatório) não foi aberta por agentes.

### Tempos da missão (`ags mission timings`, coleta final)
Tempo total (wall) 562 s; até todos trabalhando 33 s; turno mais longo 421 s (Backend, briefing); boot de 5 terminais 12,8 s no máximo; testes 158 s no total (rust 127,7 s). Gargalos: nenhum apontado. Houve um `start_stalled` do QA no boot (≈29 s), recuperado com um Enter.

### Vigia, laço do Codex e bordas
- Nenhum aviso `[Vigia]` de laço; nenhum Codex em "Working" com tela parada por mais de 8 min (Backend ativo ~5 min). O botão do olho não foi ligado por agentes (interface real); o Vigia que acompanhou a missão enviou avisos de ociosidade corretos.
- Abas restauradas sem foco ficam em PTY adiado (conhecido); ao receber `tab send` iniciam sem tela em branco. Claude, Codex, Antigravity e Shell operaram. `ags window list`: janela principal com 9 abas.

### Locales
en/es/pt-BR: 0 chaves faltantes ou divergentes, 0 valores vazios, todas as chaves estáticas usadas no código existem.

## Não verificado por agentes (conferência do usuário na interface real)
Telas Missões, Squads, Configurações (Contas, Painel de memória, Decisões), Histórico, Frota, Canvas (contorno fino com halo, alças, portas, minimapa, dock, painéis), Novo agente; texto cortado sem tooltip; botões sem rótulo; botão do Vigia e seus avisos; relatório da Laya na tela. **Esc em popup aberto**: só por leitura de código (`RouteModal.popupOwnsEscape`, testes em `src/shared/tests/routeModalEscape.test.tsx`); comportamento real não verificado.

## Conhecidos, não relatados
Antigravity sem retomar sessão; janela maximizada com bounds nulos; abas em segundo plano sem PTY; erro de sandbox do Codex (`helper_unknown_error`); laço do Codex gpt-6.1-sol (não ocorreu).
