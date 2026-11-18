/** Gravação do lote (tudo ou nada) e histórico de importações. */
import { desc, eq } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client';
import { categories, importBatches, importMappingTemplates, paymentMethods, transactions } from '../../db/schema';
import { badRequest, HttpError, nowIso } from '../../lib/errors';
import { persistCategoryAlias } from '../category-matching';
import { normalizeName } from '../../lib/normalize';
import { ensureLookup } from '../lookups';
import type { TransferCandidate } from '../transfer-detection';
import { insertTransferRecord } from '../transfers';
import { confirmedBillCandidates } from '../bill-payment-detection';
import { payBillsWithOneTransaction } from '../bills/bulk';
import { payBill } from '../bills/payments';
import { detectBillCandidates, detectCandidates } from './candidates';
import { assertValidCategoryDecisions, buildDecisionsMap, effectiveCategoryName, effectivePaymentMethodName, lookupNames } from './decisions';
import { loadDatabaseComparisons, transactionFingerprint } from './duplicates';
import { effectiveMapping, mappingProblems } from './mapping';
import { parseRowFields, rawMap } from './parse-row';
import { applyTemplateMapping, findTemplateById } from './templates';
import { type ColumnMapping, DEFAULT_TRANSFER_TOLERANCE_DAYS, type ImportOptions, type ImportSummary, type TransferDecision } from './types';
import { readWorkbook } from './workbook';

export function importWorkbook(
  db: AppDatabase,
  buffer: Buffer,
  filename: string,
  options: ImportOptions,
): ImportSummary {
  const workbook = readWorkbook(buffer, filename);
  const requested = options.mapping ?? {};
  let mapping: ColumnMapping;
  let batchTemplateId: number | null = null;
  if (Object.keys(requested).length > 0) {
    mapping = effectiveMapping(requested, workbook.mapping);
    if (options.templateId !== undefined) {
      batchTemplateId = findTemplateById(db, options.templateId).id;
    }
  } else {
    const applied = applyTemplateMapping(db, workbook.headers, options.templateId);
    mapping = applied.mapping;
    batchTemplateId = applied.appliedTemplate?.id ?? null;
    // Mesmo critério da prévia: formato de banco reconhecido sem modelo salvo usa o mapeamento do perfil.
    if (!applied.appliedTemplate && workbook.profile) mapping = workbook.mapping;
  }
  const problems = mappingProblems(mapping, workbook.headers);
  if (problems.length > 0) {
    throw badRequest('Mapeamento de colunas incompleto.', problems.map((message) => ({ message })));
  }

  const databaseComparisons = loadDatabaseComparisons(db);
  const fileFingerprints = new Set<string>();
  const rejected = new Set((options.rejectedRows ?? []).map(Number));
  const includedDuplicateRows = new Set((options.includedDuplicateRows ?? []).map(Number));
  const hasExplicitDuplicateList = options.includedDuplicateRows !== undefined;

  // Decisões de categoria e nomes resolvidos também são usados na impressão
  // digital de duplicidade: o lançamento gravado recebe a categoria/conta de
  // destino, então a reimportação precisa comparar com os mesmos nomes.
  const decisionsMap = buildDecisionsMap(options.categoryDecisions);
  const { categoryNames, paymentMethodNames } = lookupNames(db);
  assertValidCategoryDecisions(decisionsMap, categoryNames);
  const parsedRows = workbook.rows.map((row) => {
    const raw = rawMap(row, mapping);
    const override = options.overrides?.[String(row.rowNumber)] ?? {};
    const installmentsIndex = mapping.installments;
    const installmentsMeta =
      Object.prototype.hasOwnProperty.call(override, 'installments') ||
      installmentsIndex === null ||
      installmentsIndex === undefined
        ? null
        : (row.meta[installmentsIndex] ?? null);
    const parsed = parseRowFields({ ...raw, ...override }, { installmentsMeta });
    return { rowNumber: row.rowNumber, parsed };
  });

  const accepted: typeof parsedRows = [];
  const errors: { rowNumber: number; errors: string[] }[] = [];
  let skippedDuplicates = 0;
  let duplicateRows = 0;
  let invalidRows = 0;
  let explicitRejections = 0;

  for (const row of parsedRows) {
    if (rejected.has(row.rowNumber)) {
      explicitRejections += 1;
      continue;
    }
    if (row.parsed.errors.length > 0) {
      invalidRows += 1;
      errors.push({ rowNumber: row.rowNumber, errors: row.parsed.errors });
      continue;
    }

    const values = row.parsed.values;
    const decision = decisionsMap.get(normalizeName(values.category));
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
    const isDuplicate =
      databaseComparisons.exact.has(fingerprint) || fileFingerprints.has(fingerprint);
    fileFingerprints.add(fingerprint);
    if (isDuplicate) duplicateRows += 1;

    if (isDuplicate) {
      // Com lista explícita de duplicatas aceitas, o servidor é a autoridade:
      // duplicata exata só entra quando o usuário pediu por ela. Sem lista,
      // vale a semântica legada de `skipDuplicates`.
      const mustSkip = hasExplicitDuplicateList
        ? !includedDuplicateRows.has(row.rowNumber)
        : options.skipDuplicates === true;
      if (mustSkip) {
        skippedDuplicates += 1;
        continue;
      }
    }
    accepted.push(row);
  }

  const createdCategories = new Set<string>();
  const createdPaymentMethods = new Set<string>();
  const dates: string[] = [];

  const toleranceDays = options.transferToleranceDays ?? DEFAULT_TRANSFER_TOLERANCE_DAYS;
  const acceptedRowNumbers = new Set(accepted.map((row) => row.rowNumber));
  const candidates = detectCandidates(
    db,
    accepted.map((row) => ({ rowNumber: row.rowNumber, values: row.parsed.values })),
    toleranceDays,
  ).filter((candidate) => {
    const isAccepted = (party: TransferCandidate['outgoing']) =>
      party.source !== 'file' ||
      (party.rowNumber !== null && acceptedRowNumbers.has(party.rowNumber));
    return isAccepted(candidate.outgoing) && isAccepted(candidate.incoming);
  });
  const decisions = options.transferDecisions ?? {};
  const confirmedCandidates: TransferCandidate[] = [];
  const usedParty = new Set<string>();
  let rejectedTransfers = 0;
  let pendingTransfers = 0;

  for (const candidate of candidates) {
    const explicit = decisions[candidate.key];
    const decision: TransferDecision =
      explicit ?? (candidate.confidence === 'high' && !candidate.ambiguous ? 'confirm' : 'pending');
    if (decision === 'reject') {
      rejectedTransfers += 1;
      continue;
    }
    if (decision === 'pending') {
      pendingTransfers += 1;
      continue;
    }
    if (usedParty.has(candidate.outgoing.key) || usedParty.has(candidate.incoming.key)) {
      rejectedTransfers += 1;
      continue;
    }
    usedParty.add(candidate.outgoing.key);
    usedParty.add(candidate.incoming.key);
    confirmedCandidates.push(candidate);
  }

  let confirmedTransfers = 0;

  // Pagamentos de contas: só o que foi confirmado explicitamente na revisão.
  // Calculados sobre todas as linhas válidas, como na prévia, para as chaves
  // coincidirem; linha confirmada que não for gravada sai como pulada.
  const billCandidates = detectBillCandidates(
    db,
    parsedRows
      .filter((row) => row.parsed.errors.length === 0)
      .map((row) => ({ rowNumber: row.rowNumber, values: row.parsed.values })),
  );
  const billDecisions = options.billDecisions ?? {};
  const { confirmed: confirmedBills, conflicts: billConflicts } = confirmedBillCandidates(billCandidates, billDecisions);
  if (billConflicts.length > 0) {
    throw badRequest(
      'Decisões de contas a pagar inconsistentes.',
      billConflicts.map((message) => ({ message })),
    );
  }
  const candidateKeys = new Set(billCandidates.map((candidate) => candidate.key));
  const skippedBillPayments: ImportSummary['skippedBillPayments'] = Object.entries(billDecisions)
    .filter(([key, decision]) => decision === 'confirm' && !candidateKeys.has(key))
    .map(([key]) => ({
      rowNumber: Number(/^file:(\d+):/.exec(key)?.[1]) || null,
      billDescription: '',
      reason: 'A sugestão não vale mais: a conta ou a linha mudou desde a prévia.',
    }));
  const rejectedBillPayments = billCandidates.filter((candidate) => billDecisions[candidate.key] === 'reject').length;
  const pendingBillPayments = billCandidates.length - confirmedBills.length - rejectedBillPayments;
  let linkedBillPayments = 0;

  const batchId = db.transaction((tx) => {
    const batch = tx
      .insert(importBatches)
      .values({
        filename,
        importedAt: nowIso(),
        totalRows: parsedRows.length,
        importedRows: accepted.length,
        rejectedRows: parsedRows.length - accepted.length,
        mappingTemplateId: batchTemplateId,
      })
      .returning()
      .get();

    const insertedIds = new Map<number, number>();

    for (const row of accepted) {
      const values = row.parsed.values;

      // Categoria: aplica decisão do usuário, se houver.
      const sourceCategory = values.category;
      const decision = decisionsMap.get(normalizeName(sourceCategory));
      let categoryId: number;
      let createdCategoryName: string | null = null;

      if (!decision || decision.action === 'reject') {
        const categoryBefore = tx
          .select()
          .from(categories)
          .where(eq(categories.normalizedName, normalizeName(sourceCategory)))
          .get();
        const category = ensureLookup(tx, 'category', sourceCategory);
        if (!categoryBefore) createdCategories.add(category.name);
        categoryId = category.id;
      } else if (decision.action === 'create') {
        const newName = decision.newCategoryName?.trim() || sourceCategory;
        const categoryBefore = tx
          .select()
          .from(categories)
          .where(eq(categories.normalizedName, normalizeName(newName)))
          .get();
        const category = ensureLookup(tx, 'category', newName);
        if (!categoryBefore) createdCategories.add(category.name);
        categoryId = category.id;
      } else {
        // accept / use
        const targetId = decision.targetCategoryId;
        if (targetId) {
          const target = tx.select().from(categories).where(eq(categories.id, targetId)).get();
          if (!target) throw badRequest('Categoria de destino não encontrada.');
          categoryId = target.id;
          if (
            decision.confirmed === true &&
            normalizeName(sourceCategory) !== target.normalizedName
          ) {
            persistCategoryAlias(tx, sourceCategory, target.id);
          }
        } else {
          const categoryBefore = tx
            .select()
            .from(categories)
            .where(eq(categories.normalizedName, normalizeName(sourceCategory)))
            .get();
          const category = ensureLookup(tx, 'category', sourceCategory);
          if (!categoryBefore) createdCategories.add(category.name);
          categoryId = category.id;
        }
      }

      // Forma de pagamento: usa destino quando ausente no arquivo.
      let paymentMethodId: number;
      if (values.paymentMethod === null) {
        if (!options.destinationPaymentMethodId) {
          throw badRequest('Informe a conta/forma de pagamento de destino para linhas sem pagamento.');
        }
        const destination = tx
          .select()
          .from(paymentMethods)
          .where(eq(paymentMethods.id, options.destinationPaymentMethodId))
          .get();
        if (!destination) throw badRequest('Forma de pagamento de destino não encontrada.');
        paymentMethodId = destination.id;
      } else {
        const paymentBefore = tx
          .select()
          .from(paymentMethods)
          .where(eq(paymentMethods.normalizedName, normalizeName(values.paymentMethod)))
          .get();
        const payment = ensureLookup(tx, 'payment', values.paymentMethod);
        if (!paymentBefore) createdPaymentMethods.add(payment.name);
        paymentMethodId = payment.id;
      }

      const inserted = tx
        .insert(transactions)
        .values({
          purchaseDate: values.purchaseDate as string,
          purchaseDateSource: values.purchaseDateSource,
          dueDate: values.dueDate as string,
          dueDateSource: values.dueDateSource,
          description: values.description,
          amountCents: values.amountCents as number,
          paymentMethodId,
          categoryId,
          installmentNumber: values.installmentNumber,
          installmentTotal: values.installmentTotal,
          installmentSource: values.installmentSource,
          installmentOriginal: values.installmentOriginal,
          transfer: values.transfer,
          importBatchId: batch.id,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        })
        .returning({ id: transactions.id })
        .get();
      insertedIds.set(row.rowNumber, inserted.id);

      dates.push(values.dueDate as string);
    }

    const resolveId = (party: TransferCandidate['outgoing']): number | undefined =>
      party.transactionId ?? (party.rowNumber !== null ? insertedIds.get(party.rowNumber) : undefined);

    const transferLinked = new Set<number>();
    for (const candidate of confirmedCandidates) {
      const outgoingId = resolveId(candidate.outgoing);
      const incomingId = resolveId(candidate.incoming);
      if (!outgoingId || !incomingId) continue;
      try {
        insertTransferRecord(tx, {
          outgoingTransactionId: outgoingId,
          incomingTransactionId: incomingId,
          confidence: candidate.confidence === 'high' ? 'high' : 'probable',
          origin: 'import',
        });
        confirmedTransfers += 1;
        transferLinked.add(outgoingId);
        transferLinked.add(incomingId);
      } catch (error) {
        // Apenas rejeições de regra de negócio (conta igual, valor divergente)
        // contam como transferência rejeitada; erro inesperado deve abortar.
        if (!(error instanceof HttpError)) throw error;
        rejectedTransfers += 1;
      }
    }

    for (const candidate of confirmedBills) {
      const transactionId = resolveId(candidate.party);
      const skip = (reason: string) =>
        skippedBillPayments.push({ rowNumber: candidate.party.rowNumber, billDescription: candidate.bill.description, reason });
      if (!transactionId) {
        skip('A linha não foi importada (duplicada ou rejeitada).');
        continue;
      }
      if (transferLinked.has(transactionId)) {
        skip('A linha foi vinculada como transferência.');
        continue;
      }
      try {
        // Transação aninhada (savepoint): uma recusa desfaz só este vínculo.
        if (candidate.groupBills.length > 0) {
          const ids = candidate.groupBills.map((bill) => bill.id);
          payBillsWithOneTransaction(tx as unknown as AppDatabase, ids, { mode: 'link', transactionId, origin: 'import_match' });
          linkedBillPayments += ids.length;
        } else {
          payBill(tx as unknown as AppDatabase, candidate.bill.id, {
            mode: 'link',
            transactionId,
            origin: 'import_match',
          });
          linkedBillPayments += 1;
        }
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        skip(error.message);
      }
    }

    return batch.id;
  });

  dates.sort();

  return {
    batchId,
    filename,
    totalRows: parsedRows.length,
    importedRows: accepted.length,
    rejectedRows: parsedRows.length - accepted.length,
    duplicateRows,
    skippedDuplicates,
    invalidRows,
    explicitRejections,
    createdCategories: [...createdCategories],
    createdPaymentMethods: [...createdPaymentMethods],
    duplicateRowsInPreview: duplicateRows,
    transferCandidates: candidates.length,
    confirmedTransfers,
    pendingTransfers,
    rejectedTransfers,
    billCandidates: billCandidates.length,
    linkedBillPayments,
    pendingBillPayments,
    rejectedBillPayments,
    skippedBillPayments,
    ignoredRows: parsedRows.length - accepted.length,
    firstDueDate: dates[0] ?? null,
    lastDueDate: dates[dates.length - 1] ?? null,
    errors,
  };
}

export function listImportBatches(db: AppDatabase, limit = 50) {
  return db
    .select({ batch: importBatches, templateName: importMappingTemplates.name })
    .from(importBatches)
    .leftJoin(importMappingTemplates, eq(importBatches.mappingTemplateId, importMappingTemplates.id))
    .orderBy(desc(importBatches.importedAt))
    .limit(limit)
    .all()
    .map((row) => ({ ...row.batch, templateName: row.templateName ?? null }));
}
