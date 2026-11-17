/** Modelos de mapeamento salvos e reconhecidos pelo cabeçalho do arquivo. */
import { desc, eq } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client';
import { importMappingTemplates } from '../../db/schema';
import { badRequest, nowIso } from '../../lib/errors';
import { displayName, normalizeName } from '../../lib/normalize';
import { type MappingWarning, effectiveMapping, headerKey, suggestMappingDetailed } from './mapping';
import { type ColumnMapping, FIELD_LABELS, IMPORT_FIELDS, type ImportField } from './types';

/**
 * Associação campo ↔ cabeçalho do arquivo salva por NOME (não por posição),
 * para que o modelo continue válido mesmo quando as colunas mudam de ordem.
 */
export interface ImportMappingTemplate {
  id: number;
  name: string;
  headers: string[];
  mapping: Partial<Record<ImportField, string | null>>;
  createdAt: string;
  updatedAt: string;
}

interface TemplateRow {
  id: number;
  name: string;
  headers: string;
  mapping: string;
  createdAt: string;
  updatedAt: string;
}

function toTemplateDto(row: TemplateRow): ImportMappingTemplate {
  let headers: string[] = [];
  let mapping: Partial<Record<ImportField, string | null>> = {};
  try {
    const parsedHeaders = JSON.parse(row.headers);
    const parsedMapping = JSON.parse(row.mapping);
    if (Array.isArray(parsedHeaders)) {
      headers = parsedHeaders.filter((value) => typeof value === 'string');
    }
    if (parsedMapping && typeof parsedMapping === 'object' && !Array.isArray(parsedMapping)) {
      for (const field of IMPORT_FIELDS) {
        const value = (parsedMapping as Record<string, unknown>)[field];
        if (typeof value === 'string' || value === null) {
          mapping[field] = typeof value === 'string' ? value : null;
        }
      }
    }
  } catch {
    // Modelo corrompido: devolve estrutura vazia em vez de quebrar a listagem.
  }
  return {
    id: row.id,
    name: row.name,
    headers,
    mapping,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listMappingTemplates(db: AppDatabase): ImportMappingTemplate[] {
  return db
    .select()
    .from(importMappingTemplates)
    .orderBy(desc(importMappingTemplates.updatedAt))
    .all()
    .map(toTemplateDto);
}

function normalizeHeaderNames(headers: string[], mapping: ColumnMapping): Record<string, string | null> {
  const stored: Record<string, string | null> = {};
  for (const field of IMPORT_FIELDS) {
    const value = mapping[field];
    if (value === null || value === undefined) {
      stored[field] = null;
      continue;
    }
    const index = Number(value);
    const header = Number.isInteger(index) ? headers[index] : undefined;
    if (!header) {
      throw badRequest(`Modelo inválido: campo "${FIELD_LABELS[field]}" aponta para coluna inexistente.`);
    }
    stored[field] = header;
  }
  return stored;
}

/** Cria ou atualiza (por nome) um modelo de mapeamento. */
export function saveMappingTemplate(
  db: AppDatabase,
  input: { name: string; headers: string[]; mapping: ColumnMapping },
): ImportMappingTemplate {
  const name = displayName(input.name ?? '');
  if (!name || name.length > 80) {
    throw badRequest('Informe um nome para o modelo (até 80 caracteres).');
  }
  if (!Array.isArray(input.headers) || input.headers.length === 0) {
    throw badRequest('O modelo precisa dos cabeçalhos do arquivo.');
  }
  const headers = input.headers.map((header) => String(header));
  const stored = normalizeHeaderNames(headers, input.mapping ?? {});

  const now = nowIso();
  const existing = db
    .select()
    .from(importMappingTemplates)
    .all()
    .find((row) => normalizeName(row.name) === normalizeName(name));
  if (existing) {
    const updated = db
      .update(importMappingTemplates)
      .set({
        name,
        headers: JSON.stringify(headers),
        mapping: JSON.stringify(stored),
        updatedAt: now,
      })
      .where(eq(importMappingTemplates.id, existing.id))
      .returning()
      .get();
    return toTemplateDto(updated);
  }
  const created = db
    .insert(importMappingTemplates)
    .values({
      name,
      headers: JSON.stringify(headers),
      mapping: JSON.stringify(stored),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toTemplateDto(created);
}

export function deleteMappingTemplate(db: AppDatabase, id: number): { removed: true } {
  const removed = db
    .delete(importMappingTemplates)
    .where(eq(importMappingTemplates.id, id))
    .returning({ id: importMappingTemplates.id })
    .get();
  if (!removed) throw badRequest('Modelo de mapeamento não encontrado.');
  return { removed: true };
}

export function findTemplateById(db: AppDatabase, id: number): ImportMappingTemplate {
  const row = db
    .select()
    .from(importMappingTemplates)
    .where(eq(importMappingTemplates.id, id))
    .get();
  if (!row) throw badRequest('Modelo de mapeamento não encontrado.');
  return toTemplateDto(row);
}

/** Reconstrói o mapeamento por índice a partir do modelo salvo por cabeçalho. */
function resolveTemplateMapping(
  headers: string[],
  templateMapping: Partial<Record<ImportField, string | null>>,
): { mapping: ColumnMapping; missing: ImportField[] } {
  const keys = headers.map(headerKey);
  const mapping: ColumnMapping = {};
  const missing: ImportField[] = [];
  for (const field of IMPORT_FIELDS) {
    const headerName = templateMapping[field];
    if (!headerName) {
      // Campo deliberadamente não mapeado no modelo.
      mapping[field] = null;
      continue;
    }
    const index = keys.findIndex((key) => key === headerKey(headerName));
    if (index >= 0) {
      mapping[field] = index;
    } else {
      mapping[field] = null;
      missing.push(field);
    }
  }
  return { mapping, missing };
}

/** Localiza um modelo cujo conjunto de cabeçalhos coincide com o arquivo. */
function autoMatchMappingTemplate(
  db: AppDatabase,
  headers: string[],
): ImportMappingTemplate | null {
  const signature = headers.map(headerKey).sort().join('|');
  const candidates = listMappingTemplates(db);
  for (const template of candidates) {
    const templateSignature = template.headers.map(headerKey).sort().join('|');
    if (templateSignature === signature) return template;
  }
  return null;
}

/**
 * Aplica um modelo (explícito ou detectado pelo formato do arquivo) sobre a
 * sugestão automática. Campos do modelo ausentes no arquivo recorrem à própria
 * sugestão, nunca à posição das colunas.
 */
export function applyTemplateMapping(
  db: AppDatabase,
  headers: string[],
  templateId: number | undefined,
): { mapping: ColumnMapping; warnings: MappingWarning[]; appliedTemplate: { id: number; name: string } | null } {
  const suggestion = suggestMappingDetailed(headers);

  let template: ImportMappingTemplate | null = null;
  if (templateId !== undefined) {
    template = findTemplateById(db, templateId);
  } else {
    template = autoMatchMappingTemplate(db, headers);
  }
  if (!template) {
    return { mapping: suggestion.mapping, warnings: suggestion.warnings, appliedTemplate: null };
  }

  const resolution = resolveTemplateMapping(headers, template.mapping);
  const mapping = effectiveMapping(resolution.mapping, suggestion.mapping);
  const warnings: MappingWarning[] = [
    {
      level: 'info',
      field: null,
      message: `Modelo "${template.name}" aplicado automaticamente. Revise o mapeamento antes de importar.`,
    },
    ...suggestion.warnings,
  ];
  if (resolution.missing.length > 0) {
    warnings.push({
      level: 'warning',
      field: null,
      message: `Campos do modelo sem coluna correspondente neste arquivo: ${resolution.missing
        .map((field) => FIELD_LABELS[field])
        .join(', ')}. Confira o mapeamento.`,
    });
  }
  return { mapping, warnings, appliedTemplate: { id: template.id, name: template.name } };
}
