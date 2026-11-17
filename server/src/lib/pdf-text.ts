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
    let totalChars = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        totalChars += item.str.length;
        if (totalChars > limits.maxChars) throw badRequest(limits.textError);
        const y = Math.round(item.transform[5]! * 2) / 2;
        let line = lines.find((candidate) => Math.abs(candidate.y - y) < 1);
        if (!line) {
          line = { y, parts: [] };
          lines.push(line);
        }
        line.parts.push({ x: item.transform[4]!, text: item.str });
      }
    }
    return lines;
  } finally {
    await loadingTask.destroy();
  }
}
