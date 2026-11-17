/** Transferências e pagamentos de contas a pagar sugeridos a partir das linhas do arquivo. */
import type { AppDatabase } from '../../db/client';
import { categories } from '../../db/schema';
import { normalizeName } from '../../lib/normalize';
import { detectTransferCandidates, fileParty, loadUnlinkedDatabaseParties, type TransferCandidate } from '../transfer-detection';
import { detectBillPaymentCandidates, loadOpenBillsForMatch, type BillPaymentCandidate } from '../bill-payment-detection';
import type { ParsedImportValues } from './types';

function buildFileParties(
  rows: { rowNumber: number; values: ParsedImportValues }[],
  classifications: Map<string, string | null>,
) {
  return rows
    .map((row) =>
      fileParty(row.rowNumber, {
        purchaseDate: row.values.purchaseDate,
        dueDate: row.values.dueDate,
        description: row.values.description,
        amountCents: row.values.amountCents,
        paymentMethod: row.values.paymentMethod ?? '',
        transfer: row.values.transfer,
        category: row.values.category,
        classification: classifications.get(normalizeName(row.values.category)) ?? null,
      }),
    )
    .filter((party): party is NonNullable<typeof party> => party !== null);
}

function loadCategoryClassifications(db: AppDatabase): Map<string, string | null> {
  const rows = db
    .select({
      normalizedName: categories.normalizedName,
      classification: categories.classification,
    })
    .from(categories)
    .all();
  return new Map(rows.map((row) => [row.normalizedName, row.classification ?? null]));
}

export function detectCandidates(
  db: AppDatabase,
  fileRows: { rowNumber: number; values: ParsedImportValues }[],
  toleranceDays: number,
): TransferCandidate[] {
  const classifications = loadCategoryClassifications(db);
  const fileParties = buildFileParties(fileRows, classifications);
  if (fileParties.length === 0) return [];
  const databaseParties = loadUnlinkedDatabaseParties(db);
  return detectTransferCandidates([...fileParties, ...databaseParties], { toleranceDays });
}

export function detectBillCandidates(
  db: AppDatabase,
  fileRows: { rowNumber: number; values: ParsedImportValues }[],
): BillPaymentCandidate[] {
  const parties = buildFileParties(fileRows, new Map());
  if (parties.length === 0) return [];
  return detectBillPaymentCandidates(parties, loadOpenBillsForMatch(db, parties));
}
