import type { FastifyRequest } from 'fastify';
import { badRequest } from '../lib/errors';

export interface MultipartFile {
  buffer: Buffer;
  filename: string;
}

export interface MultipartForm {
  /** Arquivo enviado no campo `fileField` (padrão `file`); outros campos de arquivo são descartados. */
  file: MultipartFile | null;
  /** Campos de texto, pelo nome. Um campo repetido mantém o último valor. */
  fields: Map<string, string>;
}

/**
 * Lê um formulário multipart com um arquivo e campos de texto. O tamanho é
 * limitado pela configuração global do `@fastify/multipart` (app.ts).
 */
export async function readMultipartForm(
  request: FastifyRequest,
  options: { fileField?: string; defaultFilename?: string } = {},
): Promise<MultipartForm> {
  const fileField = options.fileField ?? 'file';
  const form: MultipartForm = { file: null, fields: new Map() };

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (part.fieldname !== fileField) {
        part.file.resume();
        continue;
      }
      form.file = {
        buffer: await part.toBuffer(),
        filename: part.filename || options.defaultFilename || 'importacao',
      };
      continue;
    }
    form.fields.set(part.fieldname, String(part.value ?? ''));
  }

  return form;
}

/** Interpreta um campo de texto JSON; vazio ou ausente devolve `undefined`. */
export function parseJsonField(value: string | undefined, label: string): unknown {
  if (value === undefined || value === '') return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw badRequest(`${label} inválido.`);
  }
}
