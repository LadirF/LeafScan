# LeafScan

Digitalizador de documentos que roda no navegador do celular (iPhone e Android), sem loja de aplicativos, **sem limite de páginas e sem marca d'água**. Tudo é processado no próprio aparelho: as fotos não vão para servidor nenhum.

## Como instalar no celular

O app precisa ser aberto por um endereço `https://` (a câmera não funciona abrindo o arquivo `.html` direto do aparelho). Com o GitHub Pages ligado, o endereço é:

**https://ladirf.github.io/LeafScan/**

- **iPhone (Safari):** abra o endereço → botão Compartilhar → **Adicionar à Tela de Início**.
- **Android (Chrome):** abra o endereço → menu ⋮ → **Instalar app** (ou "Adicionar à tela inicial").

Na primeira abertura o app baixa o motor de imagem (OpenCV, cerca de 10 MB). Depois disso ele fica guardado no aparelho e o app abre mesmo sem internet.

## O que faz

- **Câmera com detecção ao vivo:** contorna a folha na tela enquanto você aponta.
- **Captura automática:** fotografa sozinho quando a imagem fica firme, escolhendo o quadro mais nítido. Só volta a disparar quando você vira a página ou tira a folha do quadro. Dá para desligar ("Manual") e usar o botão.
- **Cantos ajustados automaticamente**, com ajuste manual:
  - arraste os cantos ou o meio dos lados;
  - uma **lupa** aparece do lado oposto ao dedo, ampliando o ponto exato que está sendo ajustado;
  - o **ímã** encosta o canto na borda do papel ao soltar (pode ser desligado).
- **Correção de perspectiva** com estimativa da proporção real da folha.
- **Filtros:** Cor mágica (tira sombra e clareia o papel), Original, Cinza e P&B.
- Girar, reordenar e excluir páginas; aplicar o mesmo filtro em todas.
- **Exportar** em PDF (folha A4 ou no tamanho da imagem) ou em imagens JPG, pelo menu de compartilhar do celular (WhatsApp, e-mail, Arquivos, Drive…) ou salvando o arquivo.
- Também importa fotos já tiradas (galeria).

## Bom saber

- As páginas ficam salvas no navegador até você tocar em "Limpar tudo". O iPhone pode apagar os dados de sites que ficam semanas sem uso, então **exporte o PDF logo depois de digitalizar**.
- O PDF guarda as imagens sem recompressão, montado aos pedaços, por isso aguenta documentos longos sem estourar a memória.

## Para quem for mexer no código

Sem etapa de compilação: HTML, CSS e JavaScript (ES modules).

| Arquivo | Conteúdo |
|---|---|
| `index.html` | telas e ícones |
| `css/app.css` | tema "Paper Craft" |
| `js/app.js` | telas, câmera, captura automática, editor com lupa, exportação |
| `js/scanner.js` | visão computacional (detecção, recorte, filtros, ímã) |
| `js/pdf.js` | gerador de PDF próprio |
| `js/db.js` | armazenamento local (IndexedDB) |
| `sw.js` | cache para funcionar sem internet |

Para testar no computador, sirva a pasta por um servidor local (a câmera exige `https` ou `localhost`):

```bash
python -m http.server 8765
```

e abra `http://localhost:8765/`.

Ao publicar uma versão nova, troque `VERSION` em `sw.js` para os aparelhos baixarem os arquivos atualizados.

## Créditos

- [OpenCV.js](https://opencv.org/) (licença Apache 2.0), carregado do jsDelivr.
- Fontes Caveat, Patrick Hand e Nunito (Google Fonts, licença OFL).
- Visual baseado no estilo [Paper Craft](https://ggprompts.com/styles/paper-craft.html).
