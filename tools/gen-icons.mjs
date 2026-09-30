// Gera os ícones do PWA sem depender de ferramenta gráfica: PNG escrito na mão
// com o zlib que já vem no Node. Rode com: node tools/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const icones = join(raiz, 'icons');
mkdirSync(icones, { recursive: true });

const VERDE = [20, 102, 63];
const CREME = [245, 247, 243];

const tabelaCrc = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = tabelaCrc[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(tipo, dados) {
  const tam = Buffer.alloc(4);
  tam.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tam, corpo, crc]);
}

function png(largura, altura, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8;  // bits por canal
  ihdr[9] = 2;  // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * O ícone é o próprio motivo do app: barras de código de barras.
 * `margem` é a fração de borda vazia — maskable precisa de mais folga, senão o
 * Android corta o desenho ao arredondar.
 */
function desenhar(tamanho, margem) {
  const linha = tamanho * 3 + 1; // 1 byte de filtro + RGB por pixel
  const buf = Buffer.alloc(linha * tamanho);

  // Larguras de barra e de espaço, em unidades, como num EAN de verdade.
  const padrao = [2, 1, 1, 1, 3, 2, 1, 1, 2, 1, 1, 2, 3, 1, 1, 1, 2, 2];
  const unidades = padrao.reduce((a, b) => a + b, 0);

  const borda = Math.round(tamanho * margem);
  const area = tamanho - borda * 2;
  const alturaBarra = Math.round(area * 0.78);
  const topo = borda + Math.round((area - alturaBarra) / 2);

  // Mapa de colunas: true onde tem barra.
  const colunas = new Uint8Array(tamanho);
  let x = borda;
  let pinta = true;
  for (const u of padrao) {
    const larg = (u * area) / unidades;
    if (pinta) {
      for (let i = Math.round(x); i < Math.round(x + larg) && i < tamanho; i++) colunas[i] = 1;
    }
    x += larg;
    pinta = !pinta;
  }

  for (let y = 0; y < tamanho; y++) {
    const base = y * linha;
    buf[base] = 0; // sem filtro
    const dentroBarra = y >= topo && y < topo + alturaBarra;
    for (let px = 0; px < tamanho; px++) {
      const cor = dentroBarra && colunas[px] ? VERDE : CREME;
      const p = base + 1 + px * 3;
      buf[p] = cor[0];
      buf[p + 1] = cor[1];
      buf[p + 2] = cor[2];
    }
  }
  return png(tamanho, tamanho, buf);
}

const saidas = [
  ['icon-192.png', 192, 0.12],
  ['icon-512.png', 512, 0.12],
  ['icon-maskable-512.png', 512, 0.22],
];

for (const [nome, tamanho, margem] of saidas) {
  const arq = join(icones, nome);
  writeFileSync(arq, desenhar(tamanho, margem));
  console.log('gerado', nome, tamanho + 'px');
}
