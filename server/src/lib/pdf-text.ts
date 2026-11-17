/**
 * Texto de um PDF agrupado em linhas pela altura (pdfjs-dist). Usado pela
 * importação de NFC-e e pela leitura da linha digitável de boletos.
 */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { badRequest } from './errors';

export interface PdfTextLine {
  y: number;
  parts: Array<{ x: number; text: string }>;
}

/** Teto de trechos de texto: o limite de caracteres sozinho não barra um PDF com milhares de trechos de um caractere. */
const MAX_TEXT_ITEMS = 20_000;

export interface PdfTextLimits {
  maxPages: number;
  maxChars: number;
  /** Mensagem quando o PDF não tem páginas ou passa de `maxPages`. */
  pagesError: string;
  /** Mensagem quando o texto passa de `maxChars`. */
  textError: string;
}

export async function readPdfTextLines(buffer: Buffer, limits: PdfTextLimits): Promise<PdfTextLine[]> {
  // Só o texto interessa: sem os avisos de fontes padrão não embutidas (verbosity 0 = só erros).
  const loadingTask = getDocument({ data: new Uint8Array(buffer), verbosity: 0 });
  const document = await loadingTask.promise;
  try {
    if (document.numPages < 1 || document.numPages > limits.maxPages) throw badRequest(limits.pagesError);
    const lines: PdfTextLine[] = [];
    // Índice por faixa de altura: uma linha a menos de 1 ponto de y está na faixa de y ou numa vizinha.
    // Evita comparar cada trecho com todas as linhas (quadrático num PDF muito fragmentado).
    const buckets = new Map<number, number[]>();
    let totalChars = 0;
    let totalItems = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        totalChars += item.str.length;
        totalItems += 1;
        if (totalChars > limits.maxChars || totalItems > MAX_TEXT_ITEMS) throw badRequest(limits.textError);
        const y = Math.round(item.transform[5]! * 2) / 2;
        const bucket = Math.floor(y);
        // A primeira linha criada que fica a menos de 1 ponto (mesma regra de antes, sem varrer todas).
        let lineIndex = -1;
        for (const key of [bucket - 1, bucket, bucket + 1]) {
          for (const index of buckets.get(key) ?? []) {
            if (Math.abs(lines[index].y - y) < 1 && (lineIndex === -1 || index < lineIndex)) lineIndex = index;
          }
        }
        if (lineIndex === -1) {
          lineIndex = lines.push({ y, parts: [] }) - 1;
          const list = buckets.get(bucket);
          if (list) list.push(lineIndex);
          else buckets.set(bucket, [lineIndex]);
        }
        lines[lineIndex].parts.push({ x: item.transform[4]!, text: item.str });
      }
    }
    return lines;
  } finally {
    await loadingTask.destroy();
  }
}
