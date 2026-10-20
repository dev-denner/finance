import type { AppDatabase, DatabaseHandle } from '../src/db/client';
import { createDatabase, runMigrations } from '../src/db/client';
import { ensureLookup } from '../src/services/lookups';
import { createTransaction, type TransactionWriteInput } from '../src/services/transactions';

export function createTestDatabase(): DatabaseHandle {
  const handle = createDatabase(':memory:');
  runMigrations(handle);
  return handle;
}

export function seedTransaction(
  db: AppDatabase,
  input: TransactionWriteInput & {
    category?: string;
    payment?: string;
    dueDate: string;
    amount: string;
  },
) {
  const category = ensureLookup(db, 'category', input.category ?? 'Mercado');
  const payment = ensureLookup(db, 'payment', input.payment ?? 'Pix');
  return createTransaction(db, {
    purchaseDate: input.purchaseDate ?? input.dueDate,
    dueDate: input.dueDate,
    description: input.description ?? 'Lançamento de teste',
    amount: input.amount,
    categoryId: category.id,
    paymentMethodId: payment.id,
    installmentNumber: input.installmentNumber ?? null,
    installmentTotal: input.installmentTotal ?? null,
    transfer: input.transfer ?? null,
  });
}

export function csvBuffer(content: string): Buffer {
  return Buffer.from(content, 'utf8');
}

export function makeCsv(rows: string[], header = 'Data Compra;Vencimento;Compra;Valor;Pagamento;Parcelas;Categorias;Transf') {
  return csvBuffer([header, ...rows].join('\r\n'));
}
