# Visualizador de mídia do chat

O chat abre anexos de imagem e arquivos de vídeo reconhecidos pela extensão (MP4, MOV, M4V, WebM, MKV e AVI) em um diálogo sobreposto. A galeria é compartilhada entre o composer e as faixas de anexos das mensagens montadas da conversa. Miniaturas e setas navegam pela galeria; Esc fecha o diálogo e devolve o foco a quem o abriu.

O visualizador oferece zoom por controles, teclado e roda com Ctrl/Cmd, ajuste à tela, arraste com zoom, download, controles nativos de vídeo e captura do quadro atual como imagem. A barra inferior permite desenhar, desfazer/refazer, limpar, registrar comentários numerados com coordenadas normalizadas e redimensionar mantendo proporção. “Anexar imagem resultante” salva e coloca a imagem atual no composer; marcas e comentários são achatados no PNG e os comentários seguem como contexto com coordenadas.

## Limites desta entrega

- Capturar um quadro cria uma imagem temporária no visualizador. Ela entra no composer quando a pessoa usa “Anexar imagem resultante”.
- Marcas e comentários são achatados ao baixar ou anexar a imagem resultante.
- Remoção de fundo está desabilitada. Ainda não há helper macOS com Vision.
- “Apagar” seleciona a ferramenta de desenho, mas ainda não produz máscara nem envia instrução de inpainting.
- Redimensionamento cria uma prévia PNG no visualizador; a imagem redimensionada entra no composer por “Anexar imagem resultante”.
- A galeria agrega anexos de mensagens que estão montadas na conversa. Imagens Markdown avulsas em resultados de ferramentas ainda não entram nela.
- O seletor mostra Imagem/Vídeo/Tudo; a lista é filtrada, mas o filtro não altera o envio dos anexos.

A referência visual foi a captura fornecida pelo usuário. A REA não foi usada: observar a janela do ChatGPT em execução poderia expor conversas reais, então não foi acessada.
