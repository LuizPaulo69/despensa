# Despensa

Leitor de código de barras de produtos de supermercado com controle de estoque de casa.
Roda no navegador do celular, instalável na tela inicial, e guarda tudo no próprio aparelho.

## Como usar

1. Abra o link no celular e toque em **Ligar câmera**.
2. Aponte para o código de barras. A leitura é confirmada com vibração e um bipe.
3. Produto conhecido abre com os dados prontos; produto novo é buscado no Open Food Facts;
   se não estiver lá, você dá o nome uma vez e ele fica salvo.
4. Na aba **Despensa**, a lista mostra o que tem em casa, com marcação do que está acabando
   e do que está perto de vencer.

**Compra rápida** (chave na aba Escanear): produto já conhecido entra com +1 sozinho, sem parar
para preencher nada. É o modo para passar o carrinho inteiro de uma vez.

## O que está guardado onde

| Onde | O quê |
|---|---|
| IndexedDB do navegador | catálogo de produtos e estoque — só neste aparelho |
| Open Food Facts | consulta de nome/marca/foto pelo código, sem cadastro nem chave |
| Nada | nenhum dado seu é enviado para servidor nenhum |

Limpar os dados do navegador apaga a despensa. Em **Ajustes** existe backup em JSON
(restaurável) e planilha CSV que o Excel em português abre direto.

## Rodar na sua máquina

A câmera só funciona em HTTPS ou em `localhost` — abrir o `index.html` direto do disco
(`file://`) não dá acesso à câmera.

```sh
npx serve .        # ou qualquer servidor estático
```

Testes das regras puras (dígito verificador, UPC-E, parse de preço, CSV, import/export):

```sh
node --test tests/core.test.mjs
```

Ícones do PWA (só precisa rodar se mudar o desenho):

```sh
node tools/gen-icons.mjs
```

## Como está montado

| Arquivo | Papel |
|---|---|
| `core.js` | regras puras, sem DOM nem rede — é o que os testes cobrem |
| `app.js` | câmera, IndexedDB, telas |
| `sw.js` | funciona offline; nunca guarda resposta da base pública |
| `tools/gen-icons.mjs` | gera os PNGs do ícone com o zlib do Node |

A leitura usa o `BarcodeDetector` do próprio navegador quando existe (Chrome, Android,
Samsung Internet). No Safari/iPhone e no Firefox, que não têm essa API, o app baixa o ZXing
sob demanda — funciona, só é mais lento.

Dois anteparos contra leitura errada: o código precisa ser lido igual duas vezes seguidas, e o
dígito verificador do GTIN tem que fechar.

## Limites conhecidos

- O Open Food Facts cobre bem alimentos. Limpeza, higiene e marca própria de mercado
  frequentemente não estão lá — nesses casos o cadastro manual é o caminho normal, não um erro.
- Código que começa com `2` é interno da loja (balança, granel): não identifica produto fora
  daquele mercado, então vai direto para cadastro manual, sem gastar consulta.
- O estoque vive neste navegador, neste aparelho. Outro celular é outra despensa — a ponte
  entre eles é o backup JSON.
