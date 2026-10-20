import { eq, inArray, isNull, or } from 'drizzle-orm';
import type { AppDatabase } from '../db/client';
import { transactions } from '../db/schema';
import { extractInstallmentsFromDescription, formatInstallments } from '../lib/installments';
import { badRequest, nowIso } from '../lib/errors';

export interface InstallmentRecoveryProposal {
  transactionId: number;
  description: string;
  dueDate: string;
  currentNumber: number | null;
  currentTotal: number | null;
  proposedNumber: number;
  proposedTotal: number;
  previous: string | null;
  conflict: boolean;
  reason: string;
}

function buildProposal(row: {
  id: number;
  description: string;
  dueDate: string;
  installmentNumber: number | null;
  installmentTotal: number | null;
}): InstallmentRecoveryProposal | null {
  if (row.installmentNumber !== null && row.installmentTotal !== null) return null;
  const match = extractInstallmentsFromDescription(row.description);
  if (!match) return null;

  const currentNumber = row.installmentNumber;
  const currentTotal = row.installmentTotal;
  let proposedNumber = match.number;
  let proposedTotal = match.total;
  let conflict = false;
  let reason = 'Parcelas ausentes; valores recuperados da descrição.';

  if (currentNumber !== null && currentTotal === null) {
    if (currentNumber !== match.number) {
      conflict = true;
      reason = `A parcela atual (${currentNumber}) diverge da descrição (${match.number}/${match.total}).`;
    } else {
      proposedNumber = currentNumber;
      proposedTotal = match.total;
      reason = 'Total de parcelas ausente; recuperado da descrição.';
    }
  } else if (currentNumber === null && currentTotal !== null) {
    if (currentTotal !== match.total) {
      conflict = true;
      reason = `O total atual (${currentTotal}) diverge da descrição (${match.number}/${match.total}).`;
    } else {
      proposedNumber = match.number;
      proposedTotal = currentTotal;
      reason = 'Número da parcela ausente; recuperado da descrição.';
    }
  }

  return {
    transactionId: row.id,
    description: row.description,
    dueDate: row.dueDate,
    currentNumber,
    currentTotal,
    proposedNumber,
    proposedTotal,
    previous: formatInstallments(currentNumber, currentTotal),
    conflict,
    reason,
  };
}

const SELECTION = {
  id: transactions.id,
  description: transactions.description,
  dueDate: transactions.dueDate,
  installmentNumber: transactions.installmentNumber,
  installmentTotal: transactions.installmentTotal,
};

/** Procura lançamentos já gravados com parcelas ausentes/incompletas recuperáveis pela descrição. */
export function findInstallmentRecoveryProposals(db: AppDatabase): InstallmentRecoveryProposal[] {
  const rows = db
    .select(SELECTION)
    .from(transactions)
    .where(
      or(isNull(transactions.installmentNumber), isNull(transactions.installmentTotal)),
    )
    .all();

  return rows
    .map(buildProposal)
    .filter((proposal): proposal is InstallmentRecoveryProposal => proposal !== null);
}

export function applyInstallmentRecovery(
  db: AppDatabase,
  ids: number[],
): { updated: number; skipped: number[] } {
  const unique = [
    ...new Set(ids.filter((id) => Number.isInteger(id) && id > 0)),
  ];
  if (unique.length === 0) throw badRequest('Selecione ao menos um lançamento.');
  if (unique.length > 5000) throw badRequest('Selecione no máximo 5000 lançamentos por vez.');

  const rows = db
    .select(SELECTION)
    .from(transactions)
    .where(inArray(transactions.id, unique))
    .all();

  const proposals = rows
    .map(buildProposal)
    .filter((proposal): proposal is InstallmentRecoveryProposal => proposal !== null);
  const applicable = proposals.filter((proposal) => !proposal.conflict);
  const skipped = unique.filter(
    (id) => !applicable.some((proposal) => proposal.transactionId === id),
  );

  let updated = 0;
  db.transaction((tx) => {
    for (const proposal of applicable) {
      tx.update(transactions)
        .set({
          installmentNumber: proposal.proposedNumber,
          installmentTotal: proposal.proposedTotal,
          installmentSource: 'description',
          installmentOriginal: proposal.previous,
          updatedAt: nowIso(),
        })
        .where(eq(transactions.id, proposal.transactionId))
        .run();
      updated += 1;
    }
  });

  return { updated, skipped };
}
