# Plano: Módulo 1 — Contas a pagar com recorrência, pagamento vinculado e agenda

Data: 2026-11-11 · Base: `docs/analise-modulos-2026-11.md` · Formato: `.opencode/agents/planner.md`

> **Status (2026-11-12): concluído.** PR1–PR5 mesclados (#6, #7, #8, #9, #10; correção #11) e este PR6 de documentação. O que ficou fora está na seção 8; o registro de cada PR, na seção 9.

## 1. Interpretação do pedido

Evoluir o agendador de contas a pagar de "lista mensal com flag de status" para um módulo com três camadas: **regra de recorrência** (template), **ocorrência** (a conta de um mês) e **pagamento** (vínculo com um lançamento real do Módulo 2). A tela passa a ser orientada ao job "não atrasar": atrasadas, vence hoje, próximos dias.

O Módulo 1 é uma **agenda de pagamentos**, não um razão contábil. A conciliação com o Módulo 2 é bem-vinda, mas **opcional e frouxa**: "Pagar" tem dois modos, *registrar lançamento* (cria movimento no Módulo 2, útil para fatura de cartão, boleto pago da conta própria) e *apenas marcar como paga* (quitada por terceiro, em dinheiro fora do controle, ou simplesmente sem interesse em conciliar). Nenhum fluxo exige o vínculo. Na importação de extratos, lançamentos que parecem pagar uma conta aberta são sugeridos para vínculo, nunca vinculados sozinhos.

Pré-condição (Fase 0, fora deste plano mas bloqueante): fechar a branch `feat/import-installments-category-matching` (31 arquivos pendentes), atualizar o baseline em `AGENTS.md` para 202 testes, e adicionar `scheduled_bills` ao reset (ver R1).

Ambiguidades resolvidas por decisão (seção 4.3), não por pergunta:
1. Manter o nome da tabela `scheduled_bills` (vira "ocorrência") em vez de renomear. Menos churn em migração, testes e README.
2. "AG" (agendado) continua existindo como `scheduled_for` (data em que o pagamento está agendado no banco), não como status.
3. Excluir lançamento vinculado a pagamento é **bloqueado** (mesmo padrão das transferências), não cascateado.

## 2. Critérios de aceite (testáveis)

Modelo e API
- [ ] AC1 — `POST /api/bill-templates` com `{description, amountCents, categoryId, recurrence:{frequency:'monthly', interval:1, dayOfMonth:10}, startDate:'2026-01-10'}` retorna 201 e gera ocorrências até 12 meses à frente da data atual; `GET /api/bills?year=2026&month=3` contém uma ocorrência com `dueDate='2026-03-10'`.
- [ ] AC2 — Template com `dayOfMonth:31` gera `2026-02-28`, `2026-03-31`, `2026-04-30` (clamp de calendário civil; ano bissexto gera `29/02`).
- [ ] AC3 — Chamar a geração duas vezes não duplica ocorrências (índice único `template_id + sequence`).
- [ ] AC3b — Template com `occurrenceCount:6` gera exatamente 6 ocorrências (`sequence` 1..6) mesmo com horizonte de 12 meses; com `endDate` e `occurrenceCount` juntos, vale o que terminar primeiro. Conta avulsa (`templateId` nulo) nunca gera ocorrência futura.
- [ ] AC4a — `POST /api/bills/:id/pay` com `{mode:'external', paidAt, paidCents}` marca `state='paid'` **sem** criar lançamento nem `bill_payments`; `unpay` reabre sem tocar em `transactions`.
- [ ] AC4 — `POST /api/bills/:id/pay` com `{mode:'transaction', paidAt, paidCents, paymentMethodId}` cria **um** lançamento em `transactions` com `amount_cents = -paidCents`, `category_id` da conta, `description` da conta, e um registro em `bill_payments`; a ocorrência passa a `state='paid'`. Tudo em uma transação SQLite: se a inserção do pagamento falhar, nenhum lançamento fica gravado.
- [ ] AC5 — `POST /api/bills/:id/pay` com `{mode:'link', transactionId}` vincula um lançamento existente sem criar outro; recusa (409) se o lançamento já paga outra conta.
- [ ] AC6 — `POST /api/bills/:id/unpay` remove o vínculo e o lançamento **somente se** ele foi criado pelo pagamento (`created_transaction=1`); lançamento pré-existente vinculado (`mode='link'`) é apenas desvinculado.
- [ ] AC7 — `DELETE /api/transactions/:id` e `POST /api/transactions/bulk-delete` retornam 409 com mensagem explícita quando o lançamento está em `bill_payments`.
- [ ] AC8 — `POST /api/bills/:id/skip` marca `state='skipped'`; ocorrência pulada sai de "não pago" no resumo e não aparece em atrasadas.
- [ ] AC9 — `GET /api/bills/agenda?days=7` retorna `{overdue, dueToday, upcoming, summary}`; `overdue` contém apenas `state='open'` com `dueDate < hoje`; `upcoming` contém `hoje < dueDate <= hoje+7`.
- [ ] AC10 — `PUT /api/bill-templates/:id?scope=future&from=2026-06-01` altera o template e regenera ocorrências abertas com `dueDate >= from`, preservando pagas, puladas e qualquer uma com pagamento; `scope=this` altera apenas a ocorrência.
- [ ] AC11 — Rotas de bills validam com Zod via `parseWith`; payload inválido retorna 400 com `issues[].path`.
- [ ] AC12 — Migração converte dados atuais: `''`→`open`, `AG`→`open` + `scheduled_for=due_date`, `PG`→`paid` + `paid_at=due_date` + `paid_cents=amount_cents` + `migrated_payment=1`; `repeated_from_id` preservado; contagem de linhas igual antes e depois.
- [ ] AC13 — `db:reset:data` apaga `bill_payments`, `scheduled_bills` e `bill_templates`; `db:reset:all` não falha por FK com contas cadastradas.

Importação (auto-match)
- [ ] AC14 — Na prévia (`POST /api/imports/preview`), um lançamento do arquivo com valor igual a uma ocorrência aberta, vencimento dentro de ±5 dias e descrição similar (Jaccard ≥ 0,5 ou alias) aparece em `billCandidates` com `confidence:'high'` e `reasons` não vazio; valor igual e data próxima mas descrição diferente → `confidence:'possible'`.
- [ ] AC15 — Duas ocorrências candidatas para o mesmo lançamento → `ambiguous:true` e nenhuma confirmação automática.
- [ ] AC16 — `POST /api/imports` com `billDecisions:{[key]:'confirm'}` grava o lançamento e cria `bill_payments` apontando para ele; `'reject'`/`'pending'` não criam vínculo; ocorrência já paga nunca é candidata.

Frontend
- [ ] AC17 — `/contas` abre em três blocos (Atrasadas, Hoje e próximos 7 dias, Mês) e o estado de mês/filtros fica em `?year=&month=&state=&q=`; voltar da página de lançamentos preserva o mês.
- [ ] AC18 — Botão "Pagar" na linha abre popover com data = hoje, valor = previsto e toggle "Registrar lançamento" desligado (ligado, com select de conta pré-preenchido, quando o template tem conta padrão); confirmar mostra toast com "Desfazer" por 6 s que chama `unpay`.
- [ ] AC19 — Editar ocorrência de template pergunta "Só esta / Esta e as futuras" e envia o `scope` correto.
- [ ] AC20 — Menu lateral mostra badge com `overdue + dueToday` quando > 0.
- [ ] AC21 — `npm run build` e `npm test` verdes; nenhum teste desabilitado; os testes de `status`/`repeat` são substituídos com justificativa no commit (comportamento removido por design).

## 3. Contexto do código

| Arquivo:linha | O que é | Relevância |
|---|---|---|
| `server/src/db/schema.ts:184-215` | `scheduledBills` (status `''/AG/PG`, `repeatedFromId`) | Tabela a estender; check constraint de status precisa ser recriada |
| `server/drizzle/0004_sour_obadiah_stane.sql` | Migração que criou `scheduled_bills` | Referência para a migração de dados |
| `server/src/services/bills.ts:181-305` | `setBillStatus`, `addMonths`, `repeatBill`, `advanceMonth` | Lógica a substituir; `addMonths` duplica `addMonthsIso` de `lib/dates.ts:103` |
| `server/src/services/bills.ts:128-160` | `listBills` carrega tudo e filtra em JS | Trocar por `between` no SQL |
| `server/src/routes/bills.ts:32-62` | `readMultipart(request: any)` | Extrair para módulo comum com `routes/imports.ts` |
| `server/src/routes/bills.ts:101-180` | Rotas sem Zod | Substituir por `parseWith` + schemas em `routes/validation.ts` |
| `server/src/routes/validation.ts` | Schemas Zod existentes (`parseWith`, `optionalYear`, `optionalMonth`) | Padrão a seguir |
| `server/src/services/transactions.ts:391-407` | `createTransaction` (exige todos os campos) | Usado por `payBill` |
| `server/src/services/transactions.ts:442-446, 507-511` | `deleteTransaction`, `bulkDeleteTransactions` | Precisam do guard de `bill_payments` |
| `server/src/services/transfers.ts:230-241` | `ensureTransactionCanBeRemoved` | Padrão do guard a replicar |
| `server/src/services/transfer-detection.ts:7-31, 141` | `TransferParty`, `TransferCandidate`, `detectTransferCandidates` | Molde para `bill-payment-detection.ts` |
| `server/src/lib/text-similarity.ts:32,40` | `levenshteinSimilarity`, `tokenJaccard` | Similaridade de descrição no auto-match |
| `server/src/services/import.ts:198-227, 246-257, 1001, 1227` | `ImportPreview`, `ImportOptions`, `previewImport`, `importWorkbook` | Pontos de inserção de `billCandidates`/`billDecisions` |
| `server/src/db/reset.ts:15-23` | `DATA_RESET_TABLES` sem `scheduled_bills` | Bug latente (R1) |
| `server/tests/bills.test.ts:108-177` | Testes de `status`/`repeat` | Serão substituídos |
| `server/tests/helpers.ts` | `createTestDatabase`, `seedTransaction` | Reutilizar; adicionar `seedBill`/`seedTemplate` |
| `client/src/pages/BillsPage.tsx` (529 linhas) | Tela atual | Reescrita em componentes |
| `client/src/pages/TransactionsPage.tsx:391+` | `useSearchParams` para filtros | Padrão de URL a copiar |
| `client/src/components/Layout.tsx:66-72` | Badge de seleção no menu | Padrão para o badge de contas |
| `client/src/lib/api.ts:241-272` | Cliente de bills | Ampliar |
| `client/src/lib/types.ts:405-428` | `Bill`, `BillSummary` | Substituir |

## 4. Design

### 4.1 Contratos

```ts
// packages futuros: hoje em server/src/services/bills/*.ts e client/src/lib/types.ts

export type BillFrequency = 'monthly' | 'weekly' | 'yearly';

export interface BillRecurrence {
  frequency: BillFrequency;
  interval: number;            // 1 = todo mês; 2 = a cada 2 meses
  dayOfMonth?: number;         // 1..31, clamp ao último dia (monthly/yearly)
  weekday?: number;            // 0..6 (weekly)
  monthOfYear?: number;        // 1..12 (yearly)
}

export interface BillTemplateDto {
  id: number;
  description: string;
  amountCents: number;         // valor previsto
  amountMinCents: number | null;  // faixa opcional (conta variável)
  amountMaxCents: number | null;
  categoryId: number;
  categoryName: string;
  paymentMethodId: number | null; // conta padrão para pagar
  recurrence: BillRecurrence;
  startDate: string;           // ISO
  endDate: string | null;      // "repetir até"
  occurrenceCount: number | null; // "repetir N vezes" (ex.: 6x); vale o que terminar primeiro
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type BillState = 'open' | 'paid' | 'skipped';
/** Derivado no serviço a partir de state + datas; nunca gravado. */
export type BillDisplayStatus =
  | 'overdue' | 'due_today' | 'scheduled' | 'upcoming' | 'paid' | 'skipped';

export interface BillPaymentDto {
  id: number;
  transactionId: number;
  amountCents: number;
  paidAt: string;
  origin: 'manual' | 'import_match' | 'migration';
  /** true quando o lançamento foi criado pelo próprio pagamento (unpay apaga). */
  createdTransaction: boolean;
  paymentMethodName: string;
}

export interface BillDto {
  id: number;
  templateId: number | null;
  sequence: number | null;
  description: string;
  amountCents: number;
  dueDate: string;
  state: BillState;
  displayStatus: BillDisplayStatus;
  scheduledFor: string | null;  // "AG"
  paidAt: string | null;
  paidCents: number | null;
  categoryId: number;
  categoryName: string;
  paymentMethodId: number | null;
  notes: string | null;
  payments: BillPaymentDto[];
  createdAt: string;
  updatedAt: string;
}

export interface BillSummary {
  totalCents: number;
  openCents: number;
  paidCents: number;
  overdueCents: number;
  counts: Record<BillDisplayStatus, number>;
}

export interface BillAgenda {
  today: string;
  days: number;
  overdue: BillDto[];
  dueToday: BillDto[];
  upcoming: BillDto[];
  summary: BillSummary;
}

export type PayBillInput =
  | { mode: 'external'; paidAt: string; paidCents: number; notes?: string }      // só marca; sem Módulo 2
  | { mode: 'transaction'; paidAt: string; paidCents: number; paymentMethodId: number; notes?: string } // cria lançamento
  | { mode: 'link'; transactionId: number; notes?: string };                      // vincula lançamento existente

// Auto-match na importação
export interface BillPaymentCandidate {
  key: string;                 // `${party.key}:${bill.id}`
  confidence: 'high' | 'possible';
  ambiguous: boolean;
  reasons: string[];
  dayDistance: number;
  amountDiffCents: number;
  party: TransferParty;        // reaproveita o tipo do arquivo
  bill: Pick<BillDto, 'id' | 'description' | 'amountCents' | 'dueDate' | 'categoryName'>;
}
export type BillDecision = 'confirm' | 'reject' | 'pending';
// ImportPreview ganha `billCandidates: BillPaymentCandidate[]`
// ImportOptions ganha `billDecisions?: Record<string, BillDecision>`
```

Schemas Zod (em `routes/validation.ts`): `billRecurrenceSchema`, `billTemplateWriteSchema`, `billTemplateUpdateQuerySchema` (`scope: 'this'|'future'`, `from`), `billWriteSchema`, `billListQuerySchema` (`year`, `month`, `state?`, `q?`, `categoryId?`), `billAgendaQuerySchema` (`days` 1..60, default 7), `payBillSchema` (união discriminada por `mode`: `external` | `transaction` | `link`), `scheduleBillSchema`.

### 4.2 Schema (migração 0006)

```sql
CREATE TABLE bill_templates (
  id integer PRIMARY KEY AUTOINCREMENT,
  description text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  amount_min_cents integer, amount_max_cents integer,
  category_id integer NOT NULL REFERENCES categories(id) ON DELETE restrict ON UPDATE cascade,
  payment_method_id integer REFERENCES payment_methods(id) ON DELETE set null ON UPDATE cascade,
  frequency text NOT NULL CHECK (frequency IN ('monthly','weekly','yearly')),
  interval integer NOT NULL DEFAULT 1 CHECK (interval >= 1),
  day_of_month integer, weekday integer, month_of_year integer,
  start_date text NOT NULL, end_date text,
  occurrence_count integer CHECK (occurrence_count IS NULL OR occurrence_count >= 1),
  active integer NOT NULL DEFAULT 1,
  notes text,
  created_at text NOT NULL DEFAULT (...), updated_at text NOT NULL DEFAULT (...)
);

-- scheduled_bills: SQLite não altera CHECK; recriar a tabela (padrão Drizzle: __new_scheduled_bills + copy + drop + rename)
-- colunas novas: template_id (FK set null), sequence integer, state text NOT NULL DEFAULT 'open'
--   CHECK (state IN ('open','paid','skipped')), scheduled_for text, paid_at text, paid_cents integer,
--   payment_method_id (FK set null), notes text
-- colunas removidas: status (após migrar os dados)
-- índices: (template_id, sequence) UNIQUE; (due_date); (state, due_date); (category_id)

CREATE TABLE bill_payments (
  id integer PRIMARY KEY AUTOINCREMENT,
  bill_id integer NOT NULL REFERENCES scheduled_bills(id) ON DELETE cascade ON UPDATE cascade,
  transaction_id integer NOT NULL REFERENCES transactions(id) ON DELETE restrict ON UPDATE cascade,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  paid_at text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('manual','import_match','migration')),
  created_transaction integer NOT NULL DEFAULT 0,
  created_at text NOT NULL DEFAULT (...)
);
CREATE UNIQUE INDEX bill_payments_transaction_uq ON bill_payments(transaction_id);
CREATE INDEX bill_payments_bill_idx ON bill_payments(bill_id);
```

Migração de dados (mesmo arquivo SQL, antes do `DROP COLUMN status`): `UPDATE ... SET state = CASE status WHEN 'PG' THEN 'paid' ELSE 'open' END, scheduled_for = CASE status WHEN 'AG' THEN due_date END, paid_at = CASE status WHEN 'PG' THEN due_date END, paid_cents = CASE status WHEN 'PG' THEN amount_cents END`. Contas "PG" migradas **não** ganham `bill_payments` (não há lançamento para apontar); ficam `paid` com `payments: []`. A tela mostra "pago (histórico)".

Gatilhos: nenhum novo. A unicidade de `transaction_id` em `bill_payments` já impede um lançamento pagar duas contas. Pagamento parcial (N pagamentos por conta) fica permitido pelo modelo, mas a UI desta fase só expõe pagamento único (ver fora de escopo).

### 4.3 Fluxo de dados

1. **Criar template** → `createTemplate` valida (Zod + categoria/conta existem) → insere → `ensureOccurrences(templateId, horizon = hoje + 12 meses)`.
2. **ensureOccurrences** → calcula datas por `recurrence` a partir de `start_date` usando `addMonthsIso`/aritmética de semana → para cada `(template_id, sequence)` ausente, `INSERT OR IGNORE`. Limite = o primeiro que ocorrer entre `end_date`, `sequence > occurrence_count` e `hoje + 12 meses`; template inativo não gera. Conta avulsa (sem template) nunca gera nada. A linha mostra "3 de 6" quando há `occurrence_count`. Chamado também em `GET /api/bills` e `GET /api/bills/agenda` (barato: uma query por template ativo + inserts faltantes).
3. **Listar mês** → `WHERE due_date BETWEEN :start AND :end` (+ `state`, `q` via `normalize_search`, `categoryId`) → `displayStatus` derivado com `today` injetado (parâmetro, para testes determinísticos) → resumo.
4. **Agenda** → três queries por faixa de datas sobre `state='open'` (+ `paid` de hoje para o resumo) → `displayStatus`.
5. **Pagar** → `db.transaction`: carrega conta (`open`). `mode='external'` → apenas `UPDATE scheduled_bills SET state='paid', paid_at, paid_cents` (sem lançamento, sem `bill_payments`); este é o padrão do popover quando o template não tem conta padrão. `mode='transaction'` → `createTransaction` (`purchaseDate = dueDate` da conta, `dueDate = paidAt`, `amount = -paidCents`, `paymentMethodId`, `categoryId`, `description`). `mode='link'` → `transactionId` valida que existe, não está em `bill_payments`, não é transferência confirmada, é saída (`amount_cents < 0`) → insere `bill_payments` → `UPDATE scheduled_bills SET state='paid', paid_at, paid_cents, payment_method_id`.
6. **Desfazer** → `db.transaction`: lê `bill_payments` da conta (vazio no modo externo: só reabre) → apaga vínculo → se `created_transaction` → `deleteTransaction` (passa pelo guard de transferências) → `state='open'`, limpa `paid_*`.
7. **Editar template `scope=future`** → atualiza template → apaga ocorrências `open` com `due_date >= from` **sem** `bill_payments` e sem edição manual (`notes`/valor diferente do template contam como edição? Não: regenera mesmo assim, exceto pagas/puladas; decisão simples e documentada) → `ensureOccurrences`.
8. **Importação** → em `previewImport`, após `detectCandidates` de transferências: carrega ocorrências `open` com `due_date` entre `min(data do arquivo) - 5` e `max + 5` → `detectBillPaymentCandidates(fileParties, bills)` → `billCandidates`. Em `importWorkbook`, após inserir cada lançamento, se `billDecisions[key] === 'confirm'` e a ocorrência ainda estiver `open` → `payBill(bill.id, {mode:'link', transactionId})` (com `paidAt = dueDate` e `paidCents = |amount|` do lançamento, `origin='import_match'`) dentro da mesma transação. Lançamentos do arquivo já marcados como transferência confirmada não participam.
9. **Guard de exclusão** → `ensureTransactionNotBillPayment(db, ids)` em `deleteTransaction` e `bulkDeleteTransactions` (409 "Lançamento vinculado ao pagamento da conta X; desfaça o pagamento antes").

### 4.4 Decisões e alternativas descartadas

- **Conciliação opcional.** O Módulo 1 é agenda; pagar sem lançamento é caminho normal, não exceção. Descartado: exigir conta/lançamento em todo pagamento. Motivo: contas quitadas por terceiros ou fora das movimentações controladas (ex.: outra pessoa pagou neste mês) não podem travar a agenda. O vínculo serve para o que vale a pena conciliar (fatura de cartão, boletos da própria conta).
- **`occurrence_count` além de `end_date`.** Descartado: só `end_date`. Motivo: parcelamentos ("6x") são contados, não datados; obrigar o usuário a calcular a data final gera erro. O `sequence` já existente permite exibir "N de T" e, depois, casar com parcelas de cartão do Módulo 2.
- **Manter `scheduled_bills` como tabela de ocorrências.** Descartado: renomear para `bill_occurrences`. Motivo: renomear exige recriar índices/FKs, README e testes sem ganho funcional.
- **Status derivado, não gravado.** Descartado: coluna `status` com `overdue`. Motivo: "atrasada" muda com o tempo sem evento; gravar exige job diário e cria inconsistência.
- **Gerar ocorrências com horizonte fixo (12 meses) e garantia on-read.** Descartado: cron/job. Motivo: app local sem processo em background; on-read idempotente custa uma query.
- **Pagamento cria lançamento via `createTransaction` existente.** Descartado: insert direto. Motivo: reaproveita validação, `installmentSource`, DTO e testes.
- **Bloquear exclusão de lançamento vinculado.** Descartado: cascata que reabre a conta. Motivo: coerente com transferências; evita reabrir conta por engano em exclusão em massa.
- **Auto-match como seção da prévia, com decisões explícitas.** Descartado: vincular automaticamente `high`. Motivo: regra do projeto de nunca aplicar sugestão sozinha (README, categorias e transferências seguem isso).
- **`PG` migrado sem lançamento.** Descartado: criar lançamentos retroativos. Motivo: inventaria movimentos no consolidado.

## 5. Passos de implementação

Cada PR fecha com `npm run build` e `npm test` verdes. Ordem obrigatória: PR1 → PR2 → PR3; PR4 e PR5 após PR3; PR6 por último.

### PR1 — Fundação: migração, schema e serviço de ocorrências (sem UI)
1. `server/src/db/schema.ts` — `billTemplates`, `billPayments`, `scheduledBills` estendida — teste: `tests/bills-migration.test.ts` (AC12: cria banco com migrações até 0005, insere `''/AG/PG`, aplica 0006, compara).
2. `npm run db:backup` + `npm run db:generate` → `server/drizzle/0006_*.sql`; editar o SQL gerado para incluir a migração de dados antes do drop de `status` — teste: idem.
3. `server/src/db/reset.ts` — `DATA_RESET_TABLES = ['bill_payments','transfer_rejections','transfers','transactions','import_batches','scheduled_bills','bill_templates']` — teste: `tests/reset.test.ts` ganha caso AC13.
4. `server/src/services/bills/recurrence.ts` — `nextOccurrenceDates(recurrence, startDate, {to, endDate, occurrenceCount}): {sequence, dueDate}[]` puro — teste: `tests/bills-recurrence.test.ts` (AC2, AC3b: dia 31, bissexto, semanal, anual, interval 2, `endDate`, `occurrenceCount`, ambos).
5. `server/src/services/bills/templates.ts` — CRUD + `ensureOccurrences` — teste: `tests/bills-templates.test.ts` (AC1, AC3, AC10).
6. `server/src/services/bills/occurrences.ts` — `listBills` por intervalo SQL, `getAgenda`, `displayStatus(bill, today)`, `createBill`, `updateBill`, `deleteBill`, `skipBill`, `unskipBill`, `scheduleBill` — teste: `tests/bills.test.ts` reescrito (AC8, AC9; remover testes de `status`/`repeat` com justificativa).
7. `server/src/services/bills.ts` — vira barrel reexportando `bills/*`; `addMonths` removido em favor de `addMonthsIso`.

### PR2 — Pagamento vinculado ao Módulo 2
1. `server/src/services/bills/payments.ts` — `payBill`, `unpayBill`, `ensureTransactionNotBillPayment` — teste: `tests/bills-payments.test.ts` (AC4, AC5, AC6; caso de falha no meio da transação usando `transactionId` inexistente).
2. `server/src/services/transactions.ts` — chamar o guard em `deleteTransaction` e `bulkDeleteTransactions`; `TransactionDto` ganha `billPayment: {billId, description} | null` (join leve) — teste: `tests/transactions.test.ts` (AC7).
3. `server/src/services/transfers.ts` — `linkTransfer` recusa lançamento que está em `bill_payments` (um lançamento não é transferência e pagamento ao mesmo tempo) — teste: `tests/transfers.test.ts` (+1 caso).

### PR3 — Rotas com Zod e cliente tipado
1. `server/src/routes/validation.ts` — schemas da seção 4.1 — teste: `tests/addendo4.test.ts` padrão (400 com `issues`).
2. `server/src/routes/multipart.ts` — `readMultipart` tipado (sem `any`), usado por `routes/bills.ts` e `routes/imports.ts` — teste: existentes de importação continuam verdes.
3. `server/src/routes/bills.ts` — `GET /api/bills`, `GET /api/bills/agenda`, `GET /api/bills/forecast?months=`, `POST/PUT/DELETE /api/bills/:id`, `POST /:id/pay|unpay|skip|unskip|schedule`, `GET/POST/PUT/DELETE /api/bill-templates[/:id]`; remover `/:id/status` e `/:id/repeat` — teste: `tests/bills-routes.test.ts` via `app.inject` (AC11, códigos 201/400/404/409).
4. `client/src/lib/types.ts`, `client/src/lib/api.ts` — novos DTOs e métodos; remover `Bill`/`setBillStatus`/`repeatBill` — teste: `npm run build -w client`.
5. `README.md` — seção "Contas a pagar" reescrita (recorrência, pagar, desfazer, agenda, migração de AG/PG).

### PR4 — Tela nova
1. `client/src/pages/bills/BillsPage.tsx` — shell com `useSearchParams` (`year`, `month`, `state`, `q`), carrega agenda + mês — teste: `client/src/pages/bills/bills-url-state.test.ts` (parse/serialize dos params).
2. `client/src/components/bills/BillQueue.tsx` (bloco Atrasadas / Hoje e próximos 7 dias / Mês), `BillRow.tsx`, `StatusChip.tsx` — teste: Testing Library (requer aprovação de dependência `@testing-library/react` + `jsdom`; se negada, lógica de derivação fica em `lib/bills-view.ts` testada sem DOM).
3. `client/src/components/bills/PayPopover.tsx` — data/valor e um toggle "Registrar lançamento" (desligado por padrão; ligado quando o template tem conta padrão, mostrando o select de conta); confirmar, toast com "Desfazer" (6 s, chama `unpay`) — AC18, AC4a.
4. `client/src/components/bills/BillForm.tsx` — modal de conta avulsa e de template (toggle "Repetir" desligado = conta avulsa; ligado abre frequência, intervalo, dia, início, término por "até a data" ou "N vezes", conta padrão opcional, prévia das próximas 6 datas); `EditScopeDialog.tsx` ("Só esta / Esta e as futuras") — AC19.
5. `client/src/components/Layout.tsx` — badge `overdue + dueToday` usando `GET /api/bills/agenda` (cache 60 s em contexto `BillsBadgeContext`) — AC20.
6. `client/src/lib/format.ts` — `formatRecurrence(recurrence)` ("Mensal, dia 10") — teste: `format.test.ts`.
7. Remover `client/src/pages/BillsPage.tsx` antigo; `App.tsx` aponta para a nova página.

### PR5 — Auto-match na importação
1. `server/src/services/bill-payment-detection.ts` — `detectBillPaymentCandidates(parties, bills, {toleranceDays:5, amountTolerance:0})` puro — teste: `tests/bill-payment-detection.test.ts` (AC14, AC15; faixa min/max do template; conta paga ignorada; transferência confirmada ignorada).
2. `server/src/services/import.ts` — `billCandidates` em `ImportPreview`, `billDecisions` em `ImportOptions`, confirmação chama `payBill` na mesma transação; `ImportSummary.billPayments` — teste: `tests/import.test.ts` (AC16).
3. `server/src/routes/imports.ts` — aceitar `billDecisions` no multipart (mesmo tratamento de `transferDecisions`).
4. `client/src/pages/ImportsPage.tsx` — nova seção "Contas a pagar encontradas" entre transferências e categorias, reaproveitando `TransferCandidateRow` como molde; `client/src/lib/import-decisions.ts` ganha `defaultBillDecisions` (high e não ambíguo → `confirm`) — teste: `import-decisions.test.ts`.

### PR6 — Documentação e limpeza
1. `AGENTS.md` — baseline de testes, estrutura `services/bills/*`.
2. `README.md` — rotas, migração, limitações ("PG migrado não tem lançamento").
3. `docs/analise-modulos-2026-11.md` — marcar itens M1-01…M1-09 como resolvidos/pendentes.

Estimativa: PR1 4–6 h · PR2 2–3 h · PR3 3–4 h · PR4 6–8 h · PR5 4–5 h · PR6 1 h.

## 6. Estratégia de teste

| Nível | O que cobre | Ferramenta |
|---|---|---|
| unit puro | recorrência (datas), `displayStatus`, detecção de pagamento, formatação | vitest (server/client) |
| unit com banco em memória | templates, ocorrências, pagamento/desfazer, guards, reset, migração de dados | vitest + `createTestDatabase` |
| rota | validação Zod, códigos HTTP, multipart com `billDecisions` | vitest + `app.inject` |
| componente | fila/chip/popover (se dependência aprovada) | Testing Library |
| manual (QA G4) | fluxo completo: criar template → ver agenda → pagar → ver lançamento → importar extrato com o mesmo valor → sugestão → desfazer | app em dev |

Casos obrigatórios de borda: dia 31 em fevereiro; `interval=2`; `endDate` antes do horizonte; pagar conta já paga (409); `unpay` em conta migrada sem pagamento (volta a `open` sem apagar nada); exclusão em massa misturando vinculados e livres (409 e nada apagado); importação com dois lançamentos iguais para uma única ocorrência (segundo fica `pending`).

## 7. Riscos e rollback

- **R1 — `db:reset:all` já falha hoje** se houver contas (FK `scheduled_bills.category_id` restrict e tabela fora do escopo). Probabilidade: alta ao testar. Mitigação: passo PR1.3. Rollback: n/a (correção).
- **R2 — Recriar `scheduled_bills` em SQLite** (CHECK não é alterável). Probabilidade: média de erro no SQL gerado. Mitigação: `db:backup` obrigatório antes; teste AC12 roda a cadeia 0000→0006 sobre dados sintéticos; `PRAGMA foreign_key_check` ao final. Rollback: `npm run db:restore`.
- **R3 — Remoção dos endpoints `status`/`repeat`** quebra o client antigo. Mitigação: PR3 e PR4 entram juntos em uma única release; até lá o client antigo não é servido (`npm run build` do client falha por tipos, o que é intencional).
- **R4 — Geração on-read criar ocorrências indesejadas** (template mal configurado gera 12 meses). Mitigação: prévia das próximas 6 datas no formulário antes de salvar; `DELETE /api/bill-templates/:id` apaga ocorrências abertas sem pagamento.
- **R5 — Falsos positivos no auto-match** (contas de mesmo valor, ex.: duas assinaturas de R$ 29,90). Mitigação: ambíguas nunca confirmam; descrição pesa na confiança; decisão sempre explícita na prévia.
- **R6 — Dependência de testes de componente** não aprovada. Mitigação: lógica de visualização em módulos puros testáveis sem DOM.

## 8. Fora de escopo (desta fase)

- Pagamento parcial na UI (modelo permite; UI expõe pagamento único).
- Notificações do sistema/PWA (apenas badge no menu).
- Anexos (boleto/PDF) e linha digitável.
- Visão calendário gráfica (lista agrupada por dia atende; calendário entra com a PWA).
- "Find schedules" (sugerir templates a partir do histórico de lançamentos) — depende de regras do Módulo 2.
- Importação de contas a pagar via planilha ganhando recorrência (continua criando ocorrências avulsas).
- Mover `lib/*` para `packages/domain` (Fase transversal; os módulos novos já nascem puros para facilitar).

---

## 9. Registro de execução

### PR1 (2026-11-11) — concluído sobre `origin/master`

- `origin/master` já continha os **lembretes por e-mail** (migração `0006_slimy_nekra`, tabelas `bill_reminder_*` referenciando `scheduled_bills`). A migração deste plano passou a ser **`0015_bill_templates_and_payments`** (a branch foi empilhada sobre o PR #5 do Módulo 3, que ocupa `0007`–`0014`; o SQL é idêntico ao da antiga `0007`) e `bill-reminders.ts` foi portado de `status = ''` para `state = 'open' AND scheduled_for IS NULL`.
- O migrator do Drizzle roda em transação, onde `PRAGMA foreign_keys=OFF` não tem efeito (risco R2 confirmado em teste). O rebuild de `scheduled_bills` guarda `repeated_from_id` e `bill_reminder_notifications` em tabelas auxiliares e os restaura após o `RENAME`.
- **Camada de compatibilidade** (`services/bills/legacy.ts` + campo `status` e `summary.counts` derivados): os endpoints `/:id/status` e `/:id/repeat` e a tela atual continuam funcionando sem alteração até o PR4. Por isso os testes antigos de status/repeat **não** foram removidos neste PR; saem com a tela nova.
- `scope=future` foi implementado como **divisão da série** (a regra atual termina na véspera de `from` e uma nova recorrência nasce em `from`), como fazem os calendários. Evita conflito de `sequence` e mantém "N de T" coerente dentro de cada série. `scope=all` propaga campos descritivos e recusa mudança de recorrência.
- Excluir uma ocorrência de recorrência a marca como **pulada** (`skipped`) em vez de apagar: a geração idempotente a recriaria. Conta avulsa é apagada de verdade.
- `payBill` aceita só `mode: 'external'` neste PR; `transaction` e `link` respondem 400 até o PR2.
- Baseline após o PR1: 409 testes (383 server + 26 client).

### PR2 (2026-11-11) — concluído em `feat/bills-payments` (empilhada sobre `feat/bills-recurrence`)

- `services/bills/payments.ts`: `payBill` com `mode: 'external' | 'transaction' | 'link'` (AC4, AC4a, AC5) e `unpayBill` (AC6). Tudo em uma transação SQLite; o modo `transaction` usa `createTransaction` com `purchaseDate` = vencimento da conta (competência) e `dueDate` = data do pagamento (caixa). O modo `link` aceita `origin: 'import_match'` para o PR5.
- `services/bills/guards.ts` importa só o schema (evita ciclo `transactions` ↔ `bills`): bloqueia excluir (individual e em massa, AC7), transformar em entrada e vincular como transferência um lançamento que paga conta.
- `TransactionDto.billPayment` (`{ billId, description, dueDate }`) na leitura individual e na listagem; tipo opcional no client.
- Testes: `tests/bills-payments.test.ts` (17). Mutação manual confirmou que os testes de AC7 falham sem os guards.
- Baseline após o PR2: 426 testes (400 server + 26 client).

### PR3 (2026-11-11) — concluído em `feat/bills-api` (empilhada sobre `feat/bills-payments`)

- Rotas com Zod (`parseWith`) para ocorrências (`GET /api/bills`, `/:id`, `/agenda`, `/forecast`; `POST/PUT/DELETE`; `/pay`, `/unpay`, `/skip`, `/unskip`, `/schedule`) e recorrências (`/api/bill-templates` CRUD + `/preview`). `payBillSchema` é união discriminada por `mode`; o modo `link` pela API não aceita `origin` (reservado à importação).
- **Desvio deliberado do plano:** `/:id/status` e `/:id/repeat` **não** foram removidas, só marcadas deprecated. A tela atual depende delas; a remoção sai junto com a tela nova no PR4 (mitigação do risco R3).
- `getForecast` (resumo por mês) implementado em `services/bills/queries.ts`, que o PR1 não tinha.
- `routes/multipart.ts` (`readMultipartForm`, `parseJsonField`) substitui os dois leitores duplicados; contas e importação de movimentações usam o mesmo. Sem `any`.
- Cliente: tipos `Bill` (com campos novos e legados), `BillAgenda`, `BillForecast`, `BillTemplate`, `PayBillInput` e métodos de API correspondentes; a tela atual compila sem mudança.
- Testes: `tests/bills-routes.test.ts` (12, via `app.inject`, datas relativas ao dia real). Baseline sobre o Módulo 3: 547 (494 server + 53 client).

### PR4 (2026-11-12) — concluído em `feat/bills-ui` (empilhada sobre `feat/bills-api`)

- Tela nova em `client/src/pages/BillsPage.tsx` com componentes em `client/src/components/bills/` (`StatusChip`, `PayDialog`, `BillFormDialog`, `SmallBillDialogs` com agendar, excluir e escolha de escopo). Lógica sem React em `client/src/lib/bills-view.ts` (estado na URL, rótulos de situação, conversão de valores, modelo do formulário).
- Agenda agrupada (atrasadas, vencem hoje, próximos 7 dias) limitada a 8 linhas com "Mostrar todas"; mês com filtros na URL (AC17); popover de pagamento virou diálogo pequeno com toggle "Registrar lançamento" desligado por padrão e ligado quando há conta padrão (AC18); "Desfazer" no aviso por 6 s (o `ToastContext` ganhou `action` e `durationMs`, retrocompatível); escopo "só esta / esta e as futuras" com "só esta" bloqueado quando a repetição muda (AC19); badge no menu via `BillsBadgeContext`, atualizado a cada 60 s e após cada mudança (AC20).
- Formulário de nova conta não pré-seleciona categoria (a primeira da lista induzia erro, visto no teste com dados reais).
- Legado removido (AC21): `services/bills/legacy.ts`, rotas `/status` e `/repeat`, `status`/`repeatedFromId` no DTO, `counts`/`unpaidCents` no resumo e os métodos do cliente. A entrada `status` (`''/AG/PG`) continua aceita pelo serviço porque a importação de planilha usa a coluna "Situação"; a API não a aceita mais (400). Os testes de `setBillStatus`, `repeatBill` e `advanceMonth` foram substituídos por testes diretos de `addMonthsIso` e da situação da planilha.
- Sem dependência nova: os testes de página usam `react-dom/client` + `act` + jsdom (`client/src/pages/bills-page.test.tsx`, 8). Mutação manual (toggle ligado por padrão) faz o teste de AC18 falhar.
- Verificado no navegador com uma cópia do banco real (servidor de produção em porta livre, `DATABASE_PATH` apontando para a cópia): agenda, pagar, desfazer, badge e prévia de recorrência.
- Baseline: 562 testes (489 server + 73 client).

### PR5 (2026-11-12) — concluído em `feat/bills-import-match` (base `master`)

- `server/src/services/bill-payment-detection.ts`: `detectBillPaymentCandidates` (puro) compara saídas do arquivo com ocorrências abertas e sem pagamento: valor igual ou dentro da faixa do template, até 5 dias (pela data de compra ou de vencimento da linha), semelhança de descrição ignorando termos de extrato ("PAG", "BOLETO", "DEB"…). Alta confiança só com valor exato e descrição parecida; disputa de linha ou de conta vira ambígua (AC14, AC15). `loadOpenBillsForMatch` busca a janela no banco; `confirmedBillCandidates` recusa uma linha para duas contas ou uma conta para duas linhas.
- `previewImport` devolve `billCandidates`; `importWorkbook` aceita `billDecisions` e, dentro da mesma transação, chama `payBill` em modo `link` com origem `import_match` (savepoint por vínculo). Sem decisão explícita nada é vinculado no servidor. Linha confirmada que não foi gravada (duplicada/rejeitada), que virou transferência ou cuja sugestão deixou de existir aparece em `skippedBillPayments` com o motivo (AC16).
- Tela de importação ganha a aba **Contas a pagar** (`TransactionsImportPage.tsx`), com as decisões em `client/src/lib/import-decisions.ts` (`defaultBillDecisions`, `mergeBillDecisions`, `applyBillDecision`, `billDecisionsForImport`) e o resumo final com vinculadas, pendentes, rejeitadas e puladas.
- Verificado ponta a ponta pela API com uma cópia do banco real: extrato com Vivo Fibra e Darf gerou dois candidatos de alta confiança; confirmar a Vivo a marcou paga com o lançamento importado e rejeitar a Darf a manteve em aberto. A tela não foi verificada no navegador porque o painel não anexa arquivos; está coberta por `transactions-import-page.test.tsx`.
- Baseline: 594 testes (511 server + 83 client).

### PR6 (2026-11-12) — documentação final

- README: lembretes descritos pelo estado novo (em aberto e sem agendamento), limitações de contas a pagar, recorrências e sugestão na importação, e cobertura de testes.
- AGENTS: estrutura de `services/bills` e dos componentes da tela.
- Análise: coluna de status para M1-01…M1-09 e Fase 0/Fase 1 marcadas.
- HANDOFF: estado após os merges e próximos passos.
- Correção do review do #10 em PR próprio (#11): as abas de contas e de transferências da importação passam a mostrar todos os pares, porque os de alta confiança vêm pré-confirmados.
