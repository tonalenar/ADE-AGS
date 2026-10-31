# Computer use: núcleo comum e simulador iOS

## Uso

```sh
ags sim act iPhone "Abra Geral nos Ajustes" --expect "text:Armazenamento do iPhone" --steps 8 --timeout 115
ags sim act iPhone "Preencha o campo já focado" --fill "screen=exemplo" --expect "text:exemplo"
```

A chamada exige a sessão do PTY emitida pela ADE e PID descendente no socket de credencial. Flags não substituem a identidade; sessão e alcance são revalidados durante o laço. O nome/id precisa identificar um nó iOS conectado ao terminal chamador. O aparelho precisa estar ligado. Um UDID isolado não concede alcance. Apenas um `act` pode usar o aparelho por vez.

Em Ajustes → Decisões, é necessário habilitar Jev, o piloto do navegador e a reserva visual. Nada é ligado automaticamente. O comando usa somente o provedor e a URL configurados, sem fallback para outro serviço. O transporte visual existente usa `jev-preview`; provedores sem suporte a imagem são recusados antes de capturar. A CLI instalada só terá o comando depois de uma atualização autorizada; o código novo não altera o app instalado.

- `--steps`: 1–15, padrão 8.
- `--timeout`: segundos, 10–1.800, padrão 115. O prazo é conferido entre fases, inclusive depois de OCR/diálogos. Uma operação nativa já iniciada tem prazo próprio (até 60 s no `simctl`) e pode terminar depois do orçamento. A CLI reserva mais 75 s para esse encerramento.
- `--fill screen=valor`: um preenchimento no campo **já focado**. O modelo não gera texto. Usa o teclado US ASCII do HID existente; texto vazio, caracteres não suportados e controles (inclusive Enter/Tab) são recusados antes de agir. Não limpa automaticamente conteúdo anterior e não envia Enter.
- `--expect text:trecho`: repetível, todos os trechos precisam aparecer no OCR local. `url:`, `count:` e `absent:` são recusados antes de agir: ainda não existe árvore AX no iOS. A verificação é textual e pode falhar por OCR.

A resposta JSON inclui `text` legível, como no `portal act`, e `report` com status, ações/tentativas, contagem de observações e chamadas ao decisor. O exit 0 da CLI indica que o relatório foi obtido; confira `report.status` para saber se o objetivo foi atingido. `done` exige expectativas locais satisfeitas; a conclusão do Jev sem expectativas é `unverified`. Limite, incerteza e falha não são apresentados como sucesso. O resumo também aparece na conversa do nó do simulador, sem valores digitados.

## Laço e integração

`computer_use::run` recebe `Request`, `Surface` e `Decider`. O núcleo é independente do HID, do OCR e do transporte HTTP. Há também um adaptador `JevDecider` de texto para o protocolo `browse::pick` existente; o iOS usa seu decisor visual.

A implementação iOS (`computer_use/ios.rs`) faz:

1. Revalidação de alcance no canvas, UDID, aparelho ligado e prazo.
2. Foto pelo `ops::screenshot` existente, sem tocar no caminho de quadros. `sips` reduz o lado maior a 1.200 pixels na pasta de capturas permitida pelo app.
3. OCR local pelo Vision do macOS, executado pelo Swift do Xcode, sem consulta externa. A API usada é [VNRecognizeTextRequest](https://developer.apple.com/documentation/vision/recognizing-text-in-images).
4. Aplicação das guardas locais antes do provedor e verificação das expectativas.
5. Uma consulta de imagem com escolhas fechadas: clicar, digitar quando há fill local, rolar em cada direção, concluir ou parar; perguntas separadas de caixa, conclusão e risco.
6. Confirmação humana quando necessária na UI existente (`user.ask`).
7. Nova foto antes do HID, inclusive após o diálogo. A revisão usa UDID e hash dos dados de imagem do PNG, ignorando metadados como timestamps. Mudança invalida a decisão sem tocar.
8. Toque em coordenadas normalizadas convertido para pontos do iOS, `type_text` ou `swipe` existentes. A foto seguinte verifica o resultado. Foto e dimensão incompatíveis com o HID são recusadas; rotação ainda não é suportada.

O provedor escolhe somente operações e caixas tipadas. Operações desconhecidas, probabilidades ausentes/inválidas e caixas fora da imagem são recusadas. O núcleo mantém os pisos existentes de 0,4 para ação e 0,75 para conclusão; a caixa usa o piso visual de 0,85. O rótulo é avaliado por probabilidade, nunca pela confiança alternativa de uma escolha.

Não há espera fixa ou repetição automática de mutação depois de erro de transporte. A ação é registrada antes da execução, porque o SO pode aplicar o efeito e só depois retornar erro. A revisão estrita pode parar em telas animadas; a guarda não deve ser desativada. O histórico anticiclo do núcleo vale dentro do `act`, não é um livro-razão persistente entre chamadas.

## Decisão de privacidade e consentimento

Pedir explicitamente `sim act` autoriza o envio da **foto do simulador** ao provedor de Decisões configurado, como parte da tarefa. Isso não autoriza outros apps, arquivos, desktop inteiro ou troca de provedor.

Antes do upload, o OCR passa pelo detector de segredo existente. Rótulos de senha/passcode/cartão/token/CPF e texto mascarado reconhecidos bloqueiam a foto conservadoramente, mesmo quando o campo parece fora de foco. Falha do OCR bloqueia. Essa é detecção **por melhor esforço**: ainda não lê o estado nativo de teclado seguro nem uma árvore de acessibilidade. OCR não é uma garantia de reconhecer todo campo ou segredo; essa limitação precisa permanecer explícita.

`fills` e expectativas não entram no corpo do provedor. Um valor de fill repetido no objetivo é substituído por `[valor local]` antes da decisão; texto/nomes da observação que ainda contêm valores locais bloqueiam a consulta. Depois de qualquer tentativa de digitar, o driver grava **antes do HID** um marcador booleano por UDID em `settings` (`computer_use.ios.private.<udid>`), sem guardar o valor. A partir daí só observa e verifica localmente: não envia outra imagem nesse `act`, inclusive se o HID falhar.

O marcador sobrevive ao reinício do app. Num `act` posterior, a pessoa precisa limpar os dados anteriores e confirmar, na UI, que nenhum fill anterior aparece na foto atual. Uma segunda captura precisa conferir com a revisão mostrada antes de liberar o marcador. Não existe flag CLI para dispensar essa confirmação. Rótulos sensíveis detectados continuam bloqueados mesmo após a resposta humana. Valores dos fills da chamada atual reconhecidos no OCR também impedem upload.

Toda ação sensível ou de efeito incerto pede confirmação **por ação**, sem memória de aprovação. O risco da decisão visual só pode elevar o risco: texto local sensível, clique sem rótulo OCR próximo e digitação também exigem confirmação. Navegação ordinária com rótulo reconhecido e classificação segura, e rolagem ordinária, seguem sem diálogo. Sem resposta, recusa, prazo vencido, revogação de alcance ou revisão alterada, não age. O diálogo apresenta operação, alvo, ponto e caminho da foto local para revisão; o usuário também vê o simulador no canvas. Não há alteração nova de frontend.

O log existente registra `browser_vision`, hash do objetivo, operação, probabilidade, latência e `foto_enviada=true superficie=ios` quando o transporte retorna uma resposta válida. Falha de envio registra `foto_envio_tentado=true`, sem afirmar recebimento. Não guarda pixels, OCR, valores digitados, caminho ou exceção crua. As capturas temporárias são removidas ao substituir/descartar a observação.

## Estado das outras superfícies

| Superfície | Estado |
|---|---|
| Navegador interno do canvas | `jevPilot.ts` / `ags portal act` preservados |
| Simulador iOS | Driver visual + HID e `ags sim act` conectados; AX ainda pendente |
| `real_browser` / `RealBrowserView` | WebView2 filho do Portal no Windows; não é navegador externo do Mac; preservado |
| `desktop_apps` | Gemini Desktop Windows; driver macOS AXUIElement + ScreenCaptureKit ainda pendente |
| Navegador externo Mac | Próxima etapa, como app do driver macOS; não será uma extensão do WebView2 |

## Validação e limites

Testes do núcleo, do parser CLI/IPC, da leitura de decisões visuais e das guardas de revisão/privacidade usam somente mocks. O OCR é compilado com `swiftc -typecheck` e testado localmente sobre uma imagem sintética, sem aparelho ou serviço remoto. Nenhuma consulta real ao Jev, inicialização de simulador do usuário, instalação do app, commit ou push faz parte da validação.

A integração nativa completa (latência, mudanças de foco, teclado, coordenadas e confirmação na UI com um aparelho rodando) ainda exige validação manual isolada. O percurso pago com Jev requer autorização explícita e teto. Não há medição de desempenho nem promessa de taxa de acerto nesta entrega.

### Resultado da rodada iOS

- Código final: 35 testes filtrados da biblioteca aprovados (`computer_use`, visão, parser e contrato IPC), incluindo percurso integrado com resposta Jev simulada → caixa → confirmação humana simulada → HID simulado → expectativa local. Os casos de recusa e revisão alterada não tocam.
- CLI final: 2 testes `sim_act` aprovados (parser/timeout/identidade e rejeição de identidade/sessão forjadas nas flags).
- OCR local: `swiftc -typecheck` aprovado; imagem sintética reconhecida como “Senha Ajustes Safari”, com caixas normalizadas. Nenhum simulador do usuário foi acionado.
- Lint de testes: aprovado, nenhuma violação nova (40 antigas no baseline). Typecheck aprovado; nenhum arquivo de frontend foi alterado.
- A última suíte completa anterior à extração final de helper/teste terminou com `ags test affected`: `passed: true`, Rust 1.870 aprovados / 16 ignorados e CLI 48 aprovados; Babel, TypeScript e frontend verdes. O schema macOS gerado pelo build disparou o plano completo e foi removido da entrega. Após a orientação de encerrar a rodada, só os testes filtrados foram executados; não se repetiu a suíte completa.
- Clippy anterior à extração final: exit 0, com warnings no repositório; não repetido nesta rodada. `git diff --check` aprovado.

Escolha expectativas exclusivas do destino e adapte o texto ao idioma real. Um texto já visível no ponto de partida pode satisfazer a expectativa sem precisar executar o objetivo. Sem expectativa adequada, a conclusão do modelo permanece não verificada.
