# Portal com Chrome real

O Portal (o navegador do canvas) tem dois modos. O de sempre passa a página pelo proxy local (`src-tauri/src/preview`). O **Chrome real** mostra um Chrome de verdade, com um perfil só do app. Liga-se pelo globo na barra do Portal, e a escolha fica salva no canvas (`Portal.realChrome`).

Serve para os sites que recusam navegador embutido, como a conta Google, e para os que estranham as páginas reescritas pelo proxy.

## Como funciona

| Peça | Onde | O que faz |
|---|---|---|
| Chrome controlado | `real_browser/mod.rs` (`ensure_browser`) | `--remote-debugging-port=0`, perfil `<dados>/real-browser-profile`. Janela fora da tela. |
| Uma janela por Portal | `real_browser_open` (`Target.createTarget` com `newWindow`) | O Chrome só desenha a aba ativa de cada janela. Com várias abas numa janela, os outros Portais congelavam. |
| Tela | `Page.startScreencast` → evento `real-browser-frame` → `RealBrowserView` | Quadro JPEG na resolução da tela (`deviceScaleFactor` = zoom × `devicePixelRatio`). |
| Mouse e teclado da pessoa | `RealBrowserView` → `real_browser_send` (`Input.*`) | Só `Input.*`, `Page.navigate`, `Page.reload` e o tamanho; nada que leia cookie ou rode script. |
| Zoom | `pageMetrics` (`realBrowser.ts`) | Como o do Chrome: menos px CSS, mais densidade. |
| Barra de rolagem | `--enable-features=OverlayScrollbar` | Fina, sem setas, sem reservar largura. Medido no Chrome 155: `FluentOverlayScrollbar` sozinha não muda nada. |
| Fora da barra de tarefas | `real_browser/win.rs` | `WS_EX_TOOLWINDOW` em cada janela nova (`SetWinEventHook`). |
| Fim junto com o app | `terminal::containment::ProcessGroup` | Job Object com `KILL_ON_JOB_CLOSE`: não sobra Chrome órfão segurando o perfil, nem num fechamento à força. |

A conexão CDP fica no Rust. O Chrome não é aberto com `--remote-allow-origins`, então nenhuma página fala com a porta de depuração.

## Login (Google e afins)

A porta 0 faz o Chrome se declarar automatizado: `navigator.webdriver` (ver [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver)). Por isso o Google recusa o login nesse Chrome ("esse navegador pode não ser seguro"). A tentativa ainda marca o perfil, que passa a ser recusado até num Chrome comum (medido).

O app **não esconde** a automação: não usa porta fixa nem `--disable-blink-features=AutomationControlled`. O login segue o que o Google pede ([2020](https://developers.googleblog.com/2020/08/guidance-for-our-effort-to-block-less-secure-browser-and-apps.html)): a senha é digitada num navegador completo, que mostra o endereço, sem passar pelo app.

1. Numa página de login do Google (`isGoogleSignIn`), o Portal mostra um aviso no lugar da página: lá não se digita.
2. **Entrar numa conta** (o boneco na barra) fecha o Chrome controlado. Em seguida abre o mesmo perfil num **Chrome comum**, sem porta de depuração e sem nenhuma flag a mais.
3. A janela desse Chrome fica **em cima do Portal**, como janela *com dono* (o app é o dono). É a relação entre processos que o Windows suporta ([Raymond Chen](https://devblogs.microsoft.com/oldnewthing/20130412-00/?p=4683)); `SetParent` não é usado.
   - Fica sempre acima do app, minimiza junto e não tem botão na barra de tarefas.
   - Acompanha o Portal a cada quadro e quando a janela do app se move.
   - Some quando o Portal sai de vista.
   - A barra do Portal some; vale a do Chrome.
4. **Terminei o login** fecha a janela como o X dela (o Chrome grava a sessão). Fechar a janela tem o mesmo efeito: o perfil roda com `background_mode` desligado.
5. O Portal reabre o perfil já com a conta.

## Agentes e Jev

O piloto (`page/runtime.ts` + `picker.ts`, o mesmo script que o proxy injeta) roda no Chrome real assim:
- **Injeção:** `Page.addScriptToEvaluateOnNewDocument`, antes dos scripts da página.
- **Ponte:** `real_browser::BRIDGE` repassa as mensagens do piloto ao app por `Runtime.addBinding`. A função do binding sai do `window` antes de a página rodar.
- **Ordens do app:** chegam por `real_browser_post` (`Runtime.evaluate` → `postMessage`).

`snapshot`, `navigate`, `history`, `screenshot` (`Page.captureScreenshot`) e `act` funcionam sem mudar o laço do Jev.

**Cliques e teclas de verdade.** O piloto continua achando o elemento e o ponto livre (`aim`), e pede o toque (`input:request`). O Rust executa por `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent` ou `Input.insertText` e responde `input:done`. Os eventos chegam ao site com `isTrusted`. Fora do Chrome real, ou sem resposta em 5 s, ficam os eventos sintéticos de sempre.

Medido em `httpbin.org/forms/post`:
- `act` preencheu o telefone (`--fill`), marcou "Large" e "Onion" e concluiu em 1,4 s.
- `click`, `input` e `keydown` chegaram com `isTrusted=true`.

## Limites conhecidos

- Só Windows tem o encaixe da janela de login e a saída da barra de tarefas. Nos outros sistemas, a janela de login abre como janela comum (`win` vazio).
- O modo celular (resolução emulada, toque) ainda não vale no Chrome real: a página ocupa o Portal.
- Sites com verificação anti-robô (Cloudflare) podem pedir confirmação no Chrome controlado, porque ele se declara automatizado.
- O "Escolha" e o "Anotar" do Portal (selector e anotação) não foram testados no Chrome real.
