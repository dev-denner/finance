/** Prévia da importação: nada é gravado. */
import type { AppDatabase } from '../../db/client';
import { suggestCategory, type CategorySuggestionAlternative } from '../category-matching';
import { normalizeName } from '../../lib/normalize';
import { detectBillCandidates, detectCandidates } from './candidates';
import { assertValidCategoryDecisions, buildDecisionsMap, effectiveCategoryName, effectivePaymentMethodName, lookupNames } from './decisions';
import { fileComparable, loadDatabaseComparisons, probableDuplicateKey, transactionFingerprint } from './duplicates';
import { type MappingWarning, effectiveMapping, mappingProblems } from './mapping';
import { parseRowFields, rawMap } from './parse-row';
import { applyTemplateMapping } from './templates';
import { type ColumnMapping, DEFAULT_TRANSFER_TOLERANCE_DAYS, type DuplicateCounterpart, type DuplicateInfo, type ImportOverrides, type ImportPreview, type PreviewOptions, type PreviewRow } from './types';
import { readWorkbook } from './workbook';
import type { FileProfile } from './profiles';

/** Aviso da prévia quando o formato do banco foi reconhecido. */
function profileNotice(profile: FileProfile): MappingWarning {
  return {
    level: 'info',
    field: null,
    message: `Formato reconhecido: ${profile.label}. As colunas foram mapeadas sozinhas e as descrições do banco resumidas (ex.: "Pix enviado - Fulano").`,
  };
}

export function previewImport(
  db: AppDatabase,
  buffer: Buffer,
  filename: string,
  requestedMapping?: ColumnMapping,
  overrides?: ImportOverrides,
  toleranceDays: number = DEFAULT_TRANSFER_TOLERANCE_DAYS,
  templateId?: number,
  options: PreviewOptions = {},
): ImportPreview {
  const workbook = readWorkbook(buffer, filename);
  const requested = requestedMapping ?? {};
  let mapping: ColumnMapping;
  let headerWarnings: MappingWarning[] = [];
  let appliedTemplate: { id: number; name: string } | null = null;
  if (Object.keys(requested).length > 0) {
    // Mapeamento explícito do usuário tem prioridade sobre modelos.
    mapping = effectiveMapping(requested, workbook.mapping);
  } else {
    const applied = applyTemplateMapping(db, workbook.headers, templateId);
    mapping = applied.mapping;
    headerWarnings = applied.warnings;
    appliedTemplate = applied.appliedTemplate;
    // Formato de banco reconhecido (e nenhum modelo salvo para ele): vale o mapeamento do perfil.
    if (!appliedTemplate && workbook.profile) {
      mapping = workbook.mapping;
      headerWarnings = [profileNotice(workbook.profile)];
    }
  }
  const errors = mappingProblems(mapping, workbook.headers);
  const comparisons = loadDatabaseComparisons(db);
  const fileExact = new Map<string, DuplicateCounterpart>();
  const fileProbable = new Map<string, DuplicateCounterpart>();
  // A duplicidade precisa usar a mesma identidade que será gravada: conta de
  // destino e categoria resolvida pela decisão do usuário.
  const previewDecisions = buildDecisionsMap(options.categoryDecisions);
  const { categoryNames, paymentMethodNames } = lookupNames(db);
  assertValidCategoryDecisions(previewDecisions, categoryNames);

  const duplicateInfo = (
    kind: 'exact' | 'probable',
    counterpart: DuplicateCounterpart,
    reason: string,
  ): DuplicateInfo => ({
    kind,
    source: counterpart.source,
    groupKey:
      counterpart.source === 'database'
        ? `${kind === 'exact' ? 'db' : 'dbp'}:${counterpart.transactionId}`
        : `${kind === 'exact' ? 'file' : 'filep'}:${counterpart.rowNumber}`,
    counterpartRowNumber: counterpart.rowNumber,
    counterpartTransactionId: counterpart.transactionId,
    counterpart,
    reason,
  });

  const rows: PreviewRow[] = workbook.rows.map((row) => {
    const raw = rawMap(row, mapping);
    const override = overrides?.[String(row.rowNumber)] ?? {};
    const merged = { ...raw, ...override };
    const installmentsIndex = mapping.installments;
    const installmentsMeta =
      Object.prototype.hasOwnProperty.call(override, 'installments') ||
      installmentsIndex === null ||
      installmentsIndex === undefined
        ? null
        : (row.meta[installmentsIndex] ?? null);
    const parsed = parseRowFields(merged, { installmentsMeta });

    const categorySuggestion = suggestCategory(
      db,
      parsed.values.category,
      parsed.values.description,
      parsed.values.amountCents ?? 0,
    );

    let duplicate: DuplicateInfo | null = null;
    if (parsed.errors.length === 0) {
      const values = parsed.values;
      const decision = previewDecisions.get(normalizeName(values.category));
      const effectiveCategory = effectiveCategoryName(values.category, decision, categoryNames);
      const effectivePaymentMethod = effectivePaymentMethodName(
        values.paymentMethod,
        options.destinationPaymentMethodId,
        paymentMethodNames,
      );
      const fingerprint = transactionFingerprint({
        purchaseDate: values.purchaseDate as string,
        dueDate: values.dueDate as string,
        description: values.description,
        amountCents: values.amountCents as number,
        paymentMethod: effectivePaymentMethod,
        category: effectiveCategory,
        installmentNumber: values.installmentNumber,
        installmentTotal: values.installmentTotal,
        transfer: values.transfer,
      });
      const probableKey = probableDuplicateKey({
        purchaseDate: values.purchaseDate as string,
        dueDate: values.dueDate as string,
        amountCents: values.amountCents as number,
        paymentMethod: effectivePaymentMethod,
      });

      const exactDatabase = comparisons.exact.get(fingerprint);
      const exactFile = fileExact.get(fingerprint);
      const probableDatabase = comparisons.probable.get(probableKey);
      const probableFile = fileProbable.get(probableKey);

      if (exactDatabase) {
        duplicate = duplicateInfo(
          'exact',
          exactDatabase,
          'Já existe um lançamento com os mesmos dados no banco.',
        );
      } else if (exactFile) {
        duplicate = duplicateInfo(
          'exact',
          exactFile,
          'Linha idêntica já encontrada neste mesmo arquivo.',
        );
      } else if (probableDatabase) {
        duplicate = duplicateInfo(
          'probable',
          probableDatabase,
          'Mesma data, valor e conta de um lançamento já existente; descrição/categoria podem diferir.',
        );
      } else if (probableFile) {
        duplicate = duplicateInfo(
          'probable',
          probableFile,
          'Mesma data, valor e conta de outra linha deste arquivo; descrição/categoria podem diferir.',
        );
      }

      if (!fileExact.has(fingerprint)) {
        fileExact.set(
          fingerprint,
          fileComparable(row.rowNumber, values, {
            paymentMethod: effectivePaymentMethod,
            category: effectiveCategory,
          }),
        );
      }
      if (!fileProbable.has(probableKey)) {
        fileProbable.set(
          probableKey,
          fileComparable(row.rowNumber, values, {
            paymentMethod: effectivePaymentMethod,
            category: effectiveCategory,
          }),
        );
      }
    }

    return {
      rowNumber: row.rowNumber,
      raw,
      values: parsed.values,
      errors: parsed.errors,
      issues: parsed.issues,
      suggestions: parsed.suggestions,
      installmentNote: parsed.installmentNote,
      duplicate,
      categorySuggestion,
    };
  });

  const categorySuggestionGroupsMap = new Map<
    string,
    {
      sourceCategory: string;
      sourceNormalized: string;
      count: number;
      targetCategoryId: number | null;
      targetCategoryName: string | null;
      confidence: 'high' | 'medium' | 'low';
      reason: string;
      method: string;
      ambiguous: boolean;
      alternatives: CategorySuggestionAlternative[];
    }
  >();
  for (const row of rows) {
    // Linhas inválidas não serão importadas; não entram na revisão de categorias.
    if (row.errors.length > 0) continue;
    const suggestion = row.categorySuggestion;
    const key = suggestion.sourceNormalized;
    const existing = categorySuggestionGroupsMap.get(key);
    if (!existing) {
      categorySuggestionGroupsMap.set(key, {
        sourceCategory: suggestion.sourceCategory,
        sourceNormalized: suggestion.sourceNormalized,
        count: 0,
        targetCategoryId: suggestion.targetCategoryId,
        targetCategoryName: suggestion.targetCategoryName,
        confidence: suggestion.confidence,
        reason: suggestion.reason,
        method: suggestion.method,
        ambiguous: suggestion.ambiguous,
        alternatives: suggestion.alternatives,
      });
    } else if (
      existing.targetCategoryId !== suggestion.targetCategoryId ||
      existing.method !== suggestion.method
    ) {
      // Mesma categoria de origem com sugestões divergentes: o grupo é
      // ambíguo e não pode ser aplicado automaticamente.
      existing.ambiguous = true;
      existing.confidence = 'low';
      existing.reason =
        'Linhas desta categoria de origem geraram sugestões diferentes; decida manualmente.';
    }
    const group = categorySuggestionGroupsMap.get(key)!;
    group.count += 1;
  }
  const categorySuggestions = [...categorySuggestionGroupsMap.values()];

  return {
    filename,
    sheetName: workbook.sheetName,
    profile: workbook.profile,
    headers: workbook.headers,
    mapping,
    mappingErrors: errors,
    mappingWarnings: headerWarnings,
    appliedTemplate,
    totalRows: rows.length,
    validRows: rows.filter((row) => row.errors.length === 0).length,
    invalidRows: rows.filter((row) => row.errors.length > 0).length,
    duplicateRows: rows.filter((row) => row.duplicate !== null).length,
    rows,
    transferToleranceDays: toleranceDays,
    categorySuggestions,
    transferCandidates: detectCandidates(
      db,
      rows
        .filter((row) => row.errors.length === 0)
        .map((row) => ({ rowNumber: row.rowNumber, values: row.values })),
      toleranceDays,
    ),
    billCandidates: detectBillCandidates(
      db,
      rows
        .filter((row) => row.errors.length === 0)
        .map((row) => ({ rowNumber: row.rowNumber, values: row.values })),
    ),
  };
}
