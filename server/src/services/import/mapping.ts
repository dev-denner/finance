/** Reconhecimento das colunas pelo cabeçalho (aliases e semelhança) e validação do mapeamento. */
import { categories } from '../../db/schema';
import { normalizeName } from '../../lib/normalize';
import { type ColumnMapping, FIELD_LABELS, IMPORT_FIELDS, type ImportField, REQUIRED_FIELDS } from './types';

/**
 * Cabeçalhos conhecidos por campo (sem acento, minúsculo — passe por `headerKey`).
 * A correspondência não depende da ordem das colunas.
 */
const ALIASES: Record<ImportField, string[]> = {
  purchaseDate: ['data compra', 'data da compra', 'data de compra', 'purchase date'],
  dueDate: [
    'vencimento',
    'data vencimento',
    'data de vencimento',
    'data movimento',
    'data de movimento',
    'dt vencimento',
    'due date',
  ],
  description: ['compra', 'descricao', 'historico', 'description', 'lancamento', 'estabelecimento', 'nome'],
  amount: ['valor', 'valor r', 'amount', 'value', 'total', 'quantia', 'montante'],
  paymentMethod: [
    'pagamento',
    'forma de pagamento',
    'forma pagamento',
    'meio de pagamento',
    'meio pagamento',
    'payment',
    'payment method',
    'conta',
    'cartao',
    'cartao usado',
    'origem',
  ],
  installments: ['parcelas', 'parcela', 'prestacao', 'installments', 'installment'],
  category: ['categorias', 'categoria', 'category', 'categories'],
  transfer: ['transf', 'transferencia', 'transfer', 'transferencia bancaria'],
};

/** Cabeçalho genérico de data, tratado por regra própria (fase 2). */
const GENERIC_DATE_HEADER = 'data';

export function headerKey(value: string): string {
  return normalizeName(value).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface MappingWarning {
  level: 'info' | 'warning';
  /** Campo afetado, quando aplicável. */
  field: ImportField | null;
  message: string;
}

export interface MappingSuggestion {
  mapping: ColumnMapping;
  warnings: MappingWarning[];
}

/**
 * Sugere o mapeamento dos cabeçalhos em três fases:
 *
 * 1. correspondência exata com cabeçalhos específicos de cada campo;
 * 2. coluna genérica "data": quando nenhuma outra coluna de data foi
 *    reconhecida, assume-se vencimento/movimento — primeiro desempate
 *    para compra, se o vencimento já estiver ocupado;
 * 3. semelhança (substring) de baixa confiança, sempre acompanhada de aviso
 *    para confirmação explícita do usuário.
 */
export function suggestMappingDetailed(headers: string[]): MappingSuggestion {
  const mapping: ColumnMapping = {};
  const warnings: MappingWarning[] = [];
  const used = new Set<number>();

  const keys = headers.map(headerKey);

  // Fase 1: correspondência exata com aliases específicos.
  for (const field of IMPORT_FIELDS) {
    let found = -1;
    for (const alias of ALIASES[field]) {
      const index = keys.findIndex((key, i) => key === alias && !used.has(i));
      if (index >= 0) {
        found = index;
        break;
      }
    }
    if (found >= 0) {
      mapping[field] = found;
      used.add(found);
    } else {
      mapping[field] = null;
    }
  }

  // Fase 2: coluna genérica "data".
  const genericIndex = keys.findIndex((key, i) => key === GENERIC_DATE_HEADER && !used.has(i));
  if (genericIndex >= 0) {
    if (mapping.dueDate === null) {
      mapping.dueDate = genericIndex;
      used.add(genericIndex);
      warnings.push({
        level: 'info',
        field: 'dueDate',
        message: `A coluna "${headers[genericIndex]}" foi interpretada como Vencimento (coluna de data genérica). Ajuste no seletor se for outro campo.`,
      });
    } else if (mapping.purchaseDate === null) {
      mapping.purchaseDate = genericIndex;
      used.add(genericIndex);
      warnings.push({
        level: 'info',
        field: 'purchaseDate',
        message: `A coluna "${headers[genericIndex]}" foi interpretada como Data Compra, pois o vencimento já foi reconhecido em outra coluna. Ajuste no seletor se for outro campo.`,
      });
    }
  }

  // Fase 3: semelhança (substring) — baixa confiança, exige revisão.
  for (const field of IMPORT_FIELDS) {
    if (mapping[field] !== null) continue;
    for (const alias of ALIASES[field]) {
      if (alias.length < 4) continue;
      const index = keys.findIndex((key, i) => key.includes(alias) && !used.has(i));
      if (index >= 0) {
        mapping[field] = index;
        used.add(index);
        warnings.push({
          level: 'warning',
          field,
          message: `A coluna "${headers[index]}" foi reconhecida por semelhança como ${FIELD_LABELS[field]}. Confirme ou corrija o mapeamento.`,
        });
        break;
      }
    }
  }

  // Cabeçalhos não utilizados: pista de mapeamento incompleto.
  const unusedHeaders = headers.filter((_, index) => !used.has(index));
  if (unusedHeaders.length > 0) {
    warnings.push({
      level: 'info',
      field: null,
      message: `Colunas sem campo correspondente: ${unusedHeaders.join(', ')}.`,
    });
  }

  return { mapping, warnings };
}

/** Somente o mapeamento (compatibilidade com chamadas existentes). */
export function suggestMapping(headers: string[]): ColumnMapping {
  return suggestMappingDetailed(headers).mapping;
}

export function effectiveMapping(source: ColumnMapping, suggestions: ColumnMapping): ColumnMapping {
  const result: ColumnMapping = { ...suggestions };
  for (const field of IMPORT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      const value = source[field];
      result[field] = value === null || value === undefined || value === -1 ? null : Number(value);
    }
  }
  return result;
}

export function mappingProblems(mapping: ColumnMapping, headers: string[]): string[] {
  const errors: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    const index = mapping[field];
    if (index === null || index === undefined || index < 0 || index >= headers.length) {
      errors.push(`Mapeie a coluna obrigatória "${FIELD_LABELS[field]}".`);
    }
  }
  return errors;
}
