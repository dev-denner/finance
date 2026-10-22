import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { AppDatabase } from '../db/client';
import {
  billReminderBatches,
  billReminderNotifications,
  categories,
  scheduledBills,
} from '../db/schema';
import { addDaysIso, parseIsoDate, todayIsoInTimeZone } from '../lib/dates';
import type { BillReminderConfig } from './bill-reminder-config';
import { REMINDER_TIME_ZONE } from './bill-reminder-config';
import {
  buildReminderEmail,
  buildReminderMessageId,
  MILESTONE_DAYS_BEFORE,
  REMINDER_MILESTONES,
  type ReminderItemView,
  type ReminderMilestone,
} from './bill-reminder-email';
import type { ReminderMessage, ReminderTransport } from './bill-reminder-transport';

/**
 * Núcleo dos lembretes por e-mail.
 *
 * Regras que não podem ser furadas:
 * - só envia para conta com `status = ''` **e** `due_date` igual à registrada
 *   na notificação;
 * - **por item e por execução: no máximo 1 aviso novo e 1 retentativa**:
 *   - **aviso novo** (vem de `pending`):
 *     - havendo marco nominal do dia (`sendDate == hoje`), **ele** é o enviado
 *       e os marcos perdidos do mesmo item (`sendDate < hoje`) viram `skipped`
 *       com o motivo `marco perdido: coberto pelo aviso de hoje` — o usuário já
 *       foi avisado hoje sobre o item, então os avisos atrasados são
 *       redundantes (evita a enxurrada quando o servidor volta depois de alguns
 *       dias fora);
 *     - sem marco nominal do dia, envia **apenas o marco perdido mais antigo**
 *       (recuperação) e marca os **outros** marcos perdidos como `skipped` com o
 *       motivo `marco perdido: coberto pelo aviso de recuperacao` — o item
 *       continua sinalizado (AC-9) sem virar enxurrada;
 *     - marcos futuros (`sendDate > hoje`) **nunca** são enviados e continuam
 *       `pending` para o dia deles;
 *   - **retentativa** (vem de `failed`): o `failed` **mais antigo** é
 *     **reenviado sempre**, mesmo quando o item já recebeu um aviso novo no
 *     mesmo dia. Um envio não confirmado não é um aviso novo — é a continuação
 *     de um aviso já iniciado — então um `failed` **nunca** vira `skipped` por
 *     causa da regra de seleção e **nunca** deixa de ser elegível. Reenviar
 *     não duplica notificação já confirmada (o que é `sent`, AC-5/AC-3);
 *   - consequência: **no máximo 2 e-mails por item por dia** (1 aviso novo +
 *     1 retentativa), e isso só acontece depois de uma falha real de envio.
 *     No caminho normal (sem falha) continua valendo **1 e-mail por item por
 *     dia**;
 * - **1 e-mail por (marco, data-alvo)** — consolida os itens do marco;
 * - marca `sent` **só depois** do transporte resolver; falha ⇒ `failed`,
 *   `attempts + 1` e `last_error` truncado e sanitizado;
 * - **transporte que não confirma entrega** (`persists === false`, o `dry-run`)
 *   ⇒ o ciclo é uma **simulação pura**: não grava lote, não grava notificação,
 *   não muda nenhum `state` e não roda a limpeza. O aviso do dia **não é
 *   consumido** — ele continua elegível para o ciclo com transporte real;
 * - erro do transporte **não** derruba o processo: a função resolve com o
 *   resumo (`emailsFailed`).
 */

/** Logger injetável (compatível com o `app.log` do Fastify). */
export interface ReminderLogger {
  info(obj: unknown, message?: string): void;
  warn(obj: unknown, message?: string): void;
  error(obj: unknown, message?: string): void;
}

export const noopReminderLogger: ReminderLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface RunBillRemindersOptions {
  db: AppDatabase;
  transport: ReminderTransport;
  config: BillReminderConfig;
  /** Data de referência (AAAA-MM-DD). Padrão: hoje em São Paulo. */
  today?: string;
  /** Momento da execução (usado nos carimbos). Padrão: agora. */
  now?: Date;
  logger?: ReminderLogger;
}

export interface ReminderBatchSummary {
  milestone: string;
  sendDate: string;
  itemCount: number;
  state: 'sent' | 'failed' | 'skipped';
}

export interface RunBillRemindersResult {
  /** Data de referência usada na execução. */
  today: string;
  /** Primeiro dia elegível (janela de catch-up). */
  windowStart: string;
  /** Último dia elegível. */
  windowEnd: string;
  /** `true` quando o recurso está desligado (sem destinatário). */
  disabled: boolean;
  /**
   * `true` quando o ciclo foi uma **simulação** (transporte sem entrega
   * confirmada): nada foi gravado no banco.
   */
  simulated: boolean;
  /** Contas pendentes dentro da janela. */
  eligibleBills: number;
  /** Notificações criadas nesta execução. */
  notificationsCreated: number;
  /** Notificações marcadas como `skipped` (limpeza ou marco perdido coberto). */
  notificationsSkipped: number;
  /** Itens selecionados para envio (1 aviso novo + 1 retentativa por conta). */
  notificationsSelected: number;
  /** Itens com aviso confirmado. */
  notificationsSent: number;
  /** Itens com envio falho. */
  notificationsFailed: number;
  /** E-mails enviados com sucesso. */
  emailsSent: number;
  /** E-mails que falharam. */
  emailsFailed: number;
  /** Resumo por lote, sem dados pessoais. */
  batches: ReminderBatchSummary[];
}

const ERROR_MAX_LENGTH = 200;

/**
 * Limite de tentativas de entrega por notificação. Ao estourar, a notificação
 * vira `skipped` com o motivo `falha persistente: limite de tentativas` —
 * assim uma falha que nunca se resolve não vira retentativa eterna.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Motivos registrados em `last_error` quando um marco perdido é coberto por
 * outro aviso do mesmo item (o `sent` de um marco perdido nunca acontece:
 * ele é descartado antes do envio).
 */
const SKIP_REASON_COVERED_BY_TODAY = 'marco perdido: coberto pelo aviso de hoje';
const SKIP_REASON_COVERED_BY_RECOVERY = 'marco perdido: coberto pelo aviso de recuperacao';
/** Motivos da limpeza (a conta deixou de ser elegível). */
const SKIP_REASON_NOT_PENDING = 'conta não está mais pendente';
const SKIP_REASON_DUE_DATE_CHANGED = 'vencimento alterado';
const SKIP_REASON_OUT_OF_WINDOW = 'data-alvo fora da janela';
/** O e-mail do marco já saiu (para outros itens): a notificação continua pendente. */
const SKIP_REASON_BATCH_ALREADY_SENT =
  'marco ja enviado para outro item; aguardando o proximo ciclo';
/** Outro processo gravou o lote do marco primeiro. */
const SKIP_REASON_CONCURRENT_SEND = 'outro processo ja enviou este marco';
/** Limite de tentativas de entrega estourado. */
const SKIP_REASON_MAX_ATTEMPTS = 'falha persistente: limite de tentativas';

/**
 * Tamanho mínimo para um **texto livre** ser redigido como segredo. Textos
 * muito curtos ("Luz") são descartados para não mutilar a mensagem de erro.
 */
const MIN_FREE_TEXT_LENGTH = 4;

/**
 * Reduz a mensagem de erro a um texto curto, sem e-mail, credencial, host,
 * valor monetário ou PII de conta.
 *
 * `secrets` são os valores **conhecidos** (host, usuário e senha do SMTP, e
 * os textos livres das contas do lote). Eles são redigidos **antes** das
 * expressões regulares, porque são os únicos que o código conhece.
 */
export function sanitizeReminderError(error: unknown, secrets: string[] = []): string {
  let text = error instanceof Error ? error.message : String(error ?? 'erro desconhecido');

  // 1. Valores configurados e textos livres conhecidos: redação exata.
  for (const secret of secrets) {
    const value = String(secret ?? '').trim();
    if (!value) continue;
    text = text.split(value).join('[redacted]');
  }

  // 2. Endereço de e-mail.
  text = text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]');
  // 3. Host e endereço IP (o servidor SMTP não precisa aparecer no banco).
  text = text.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,3})?\b/g, '[host]');
  text = text.replace(/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, '[host]');
  // 4. Pares "palavra segredo" (com ou sem ':'/'=').
  text = text.replace(
    /\b(pass(?:word|wd)?|senha|secret|segredo|token|auth|credential|autoriz\w*|user|usuario|usuário)\b\s*[:=]?\s*\S+/gi,
    '$1=[redacted]',
  );
  // 5. Valor monetário.
  text = text.replace(/\bR\$\s*[\d.,]+/gi, '[valor]');
  text = text.replace(/\b\d{1,3}(?:\.\d{3})*,\d{2}\b/g, '[valor]');

  text = text.replace(/\s+/g, ' ').trim();
  const safe = text === '' ? 'erro desconhecido' : text;
  return safe.slice(0, ERROR_MAX_LENGTH);
}

/** Chave única do ledger: (conta, marco, vencimento). */
function notificationKey(billId: number, milestone: string, dueDate: string): string {
  return `${billId}|${milestone}|${dueDate}`;
}

/** `true` quando o erro é a violação da chave única do lote. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}

/** Notificação do ledger (a linha do banco ou uma linha virtual de simulação). */
interface CandidateNotification {
  id: number;
  billId: number;
  milestone: string;
  dueDate: string;
  sendDate: string;
  state: string;
  attempts: number;
}

/** Candidato à seleção: a notificação + o que o e-mail mostra do item. */
interface CandidateRow {
  notification: CandidateNotification;
  description: string;
  categoryName: string;
}

function withinWindow(date: string, windowStart: string, windowEnd: string): boolean {
  return date >= windowStart && date <= windowEnd;
}

/**
 * Executa um ciclo completo de lembretes. Nunca lança por falha de envio:
 * o erro do transporte vira contagem no resumo.
 *
 * Quando o transporte **não confirma entrega** (`persists === false`), o
 * ciclo é uma simulação pura: nada é gravado no banco e o resumo descreve o
 * que **teria** acontecido.
 */
export async function runBillReminders(
  options: RunBillRemindersOptions,
): Promise<RunBillRemindersResult> {
  const { db, transport, config } = options;
  const logger = options.logger ?? noopReminderLogger;
  const now = options.now ?? new Date();
  const simulate = transport.persists === false;

  const parsedToday = parseIsoDate(options.today ?? todayIsoInTimeZone(REMINDER_TIME_ZONE, now));
  if (!parsedToday.ok) {
    throw new Error(`Data de referência inválida: ${parsedToday.error}`);
  }
  const today = parsedToday.value;

  const windowStart = addDaysIso(today, -config.catchUpDays);
  if (!windowStart) {
    throw new Error('Não foi possível calcular o início da janela de lembretes.');
  }
  const windowEnd = today;

  const summary: RunBillRemindersResult = {
    today,
    windowStart,
    windowEnd,
    disabled: true,
    simulated: simulate,
    eligibleBills: 0,
    notificationsCreated: 0,
    notificationsSkipped: 0,
    notificationsSelected: 0,
    notificationsSent: 0,
    notificationsFailed: 0,
    emailsSent: 0,
    emailsFailed: 0,
    batches: [],
  };

  const recipient = config.to;
  if (!config.enabled || !recipient) {
    logger.info({}, 'Lembretes por e-mail desabilitados (sem destinatário configurado).');
    return summary;
  }
  summary.disabled = false;

  const timestamp = now.toISOString();
  const maxDaysBefore = Math.max(...Object.values(MILESTONE_DAYS_BEFORE));
  const maxDueDate = addDaysIso(today, maxDaysBefore);
  if (!maxDueDate) {
    throw new Error('Não foi possível calcular o limite de vencimentos da janela.');
  }

  // 1. Contas pendentes dentro da janela.
  //
  //    A consulta bringue **apenas** o necessário (`id` e `dueDate`): o valor
  //    monetário da conta não entra em nenhum objeto intermediário do módulo
  //    (a garantia estrutural de privacidade).
  const bills = db
    .select({ id: scheduledBills.id, dueDate: scheduledBills.dueDate })
    .from(scheduledBills)
    .where(
      and(
        eq(scheduledBills.status, ''),
        gte(scheduledBills.dueDate, windowStart),
        lte(scheduledBills.dueDate, maxDueDate),
      ),
    )
    .all();
  summary.eligibleBills = bills.length;

  // 2. Notificações (item, marco) que **existiriam** neste ciclo.
  const planned: (typeof billReminderNotifications.$inferInsert)[] = [];
  for (const bill of bills) {
    for (const milestone of REMINDER_MILESTONES) {
      const sendDate = addDaysIso(bill.dueDate, -MILESTONE_DAYS_BEFORE[milestone]);
      if (!sendDate) continue;
      if (!withinWindow(sendDate, windowStart, windowEnd)) continue;
      planned.push({
        billId: bill.id,
        milestone,
        dueDate: bill.dueDate,
        sendDate,
        state: 'pending',
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
  }

  const billIds = bills.map((bill) => bill.id);
  /** Chaves já presentes no ledger (para simular o `INSERT OR IGNORE`). */
  const existingKeys = new Set<string>();
  if (simulate && billIds.length > 0) {
    const existing = db
      .select({
        billId: billReminderNotifications.billId,
        milestone: billReminderNotifications.milestone,
        dueDate: billReminderNotifications.dueDate,
      })
      .from(billReminderNotifications)
      .where(inArray(billReminderNotifications.billId, billIds))
      .all();
    for (const row of existing) {
      existingKeys.add(notificationKey(row.billId, row.milestone, row.dueDate));
    }
  }
  const newNotifications = planned.filter(
    (row) => !existingKeys.has(notificationKey(row.billId, row.milestone, row.dueDate)),
  );

  if (simulate) {
    // Simulação: nenhuma escrita — só a contagem do que seria criado.
    summary.notificationsCreated = newNotifications.length;
  } else if (planned.length > 0) {
    const result = db
      .insert(billReminderNotifications)
      .values(planned)
      .onConflictDoNothing()
      .run();
    summary.notificationsCreated = result.changes;
  }

  // 3. Limpeza: contas que deixaram de estar pendentes, vencimento alterado
  //    ou data-alvo fora da janela viram `skipped` — **com o motivo** no
  //    `last_error`, para que o descarte seja auditável.
  const open = db
    .select({
      notification: billReminderNotifications,
      billDueDate: scheduledBills.dueDate,
      billStatus: scheduledBills.status,
    })
    .from(billReminderNotifications)
    .leftJoin(scheduledBills, eq(billReminderNotifications.billId, scheduledBills.id))
    .where(inArray(billReminderNotifications.state, ['pending', 'failed']))
    .all();

  /** Motivo → ids marcados como `skipped` na limpeza. */
  const skipPlan = new Map<string, number[]>();
  const addSkip = (reason: string, id: number): void => {
    const list = skipPlan.get(reason);
    if (list) list.push(id);
    else skipPlan.set(reason, [id]);
  };
  for (const row of open) {
    const notification = row.notification;
    if (row.billDueDate === null) {
      addSkip(SKIP_REASON_NOT_PENDING, notification.id);
      continue;
    }
    if (row.billStatus !== '') {
      addSkip(SKIP_REASON_NOT_PENDING, notification.id);
      continue;
    }
    if (row.billDueDate !== notification.dueDate) {
      addSkip(SKIP_REASON_DUE_DATE_CHANGED, notification.id);
      continue;
    }
    if (!withinWindow(notification.sendDate, windowStart, windowEnd)) {
      addSkip(SKIP_REASON_OUT_OF_WINDOW, notification.id);
      continue;
    }
  }

  const skippedByCleanup = new Set<number>();
  for (const [reason, ids] of skipPlan) {
    for (const id of ids) skippedByCleanup.add(id);
    if (simulate) continue;
    db.update(billReminderNotifications)
      .set({ state: 'skipped', lastError: reason, updatedAt: timestamp })
      .where(inArray(billReminderNotifications.id, ids))
      .run();
  }
  summary.notificationsSkipped += skippedByCleanup.size;

  // 4. Seleção: no máximo 1 aviso novo e 1 retentativa por item por dia.
  //
  //    Candidatos = avisos `pending`/`failed` do item cuja conta continua
  //    pendente, cujo vencimento registrado é o atual e cuja data-alvo já
  //    chegou (`sendDate <= hoje`).
  //
  //    Aviso novo (vem de `pending`) — no máximo 1 por item:
  //    - `sendDate == hoje` → marco nominal do dia: é o que será enviado;
  //    - `sendDate < hoje`  → marco perdido (o servidor ficou dias fora):
  //      quando não há marco nominal, vale o mais antigo (recuperação).
  //
  //    Retentativa (vem de `failed`) — no máximo 1 por item: o `failed` mais
  //    antigo é reenviado **sempre**, independentemente de haver aviso novo no
  //    mesmo dia. Um `failed` não é descartado pela regra de seleção: ele
  //    continua `failed` até o reenvio confirmar (AC-5).
  //
  //    Havendo marco nominal do dia, ele é enviado e os marcos perdidos
  //    `pending` do mesmo item viram `skipped` (o usuário já foi avisado hoje
  //    sobre o item). Sem marco nominal, envia só o marco perdido mais antigo
  //    (recuperação) e descarta os demais. No caminho normal são **1 aviso por
  //    item por dia** — é isso que impede a enxurrada de avisos quando o
  //    servidor volta depois de alguns dias fora. A retentativa só acrescenta
  //    um e-mail depois de uma falha real de envio.
  const storedCandidates = db
    .select({
      notification: billReminderNotifications,
      description: scheduledBills.description,
      categoryName: categories.name,
    })
    .from(billReminderNotifications)
    .innerJoin(scheduledBills, eq(billReminderNotifications.billId, scheduledBills.id))
    .innerJoin(categories, eq(scheduledBills.categoryId, categories.id))
    .where(
      and(
        inArray(billReminderNotifications.state, ['pending', 'failed']),
        eq(scheduledBills.status, ''),
        eq(scheduledBills.dueDate, billReminderNotifications.dueDate),
        lte(billReminderNotifications.sendDate, today),
      ),
    )
    .all();

  const candidates: CandidateRow[] = storedCandidates
    .filter((row) => !skippedByCleanup.has(row.notification.id))
    .map((row) => ({
      notification: row.notification,
      description: row.description,
      categoryName: row.categoryName,
    }));

  if (simulate && newNotifications.length > 0) {
    // Simulação: as notificações que **seriam** criadas entram na seleção
    // como linhas virtuais (id negativo: nunca chegam ao banco).
    const details = db
      .select({
        id: scheduledBills.id,
        description: scheduledBills.description,
        categoryName: categories.name,
      })
      .from(scheduledBills)
      .innerJoin(categories, eq(scheduledBills.categoryId, categories.id))
      .where(inArray(scheduledBills.id, billIds))
      .all();
    const detailsById = new Map(details.map((row) => [row.id, row]));
    newNotifications.forEach((notification, index) => {
      const detail = detailsById.get(notification.billId);
      candidates.push({
        notification: {
          id: -(index + 1),
          billId: notification.billId,
          milestone: notification.milestone,
          dueDate: notification.dueDate,
          sendDate: notification.sendDate,
          state: 'pending',
          attempts: 0,
        },
        description: detail?.description ?? '',
        categoryName: detail?.categoryName ?? '',
      });
    });
  }

  const byBill = new Map<number, CandidateRow[]>();
  for (const row of candidates) {
    const list = byBill.get(row.notification.billId);
    if (list) {
      list.push(row);
    } else {
      byBill.set(row.notification.billId, [row]);
    }
  }

  /** Marco mais antigo de uma lista (menor `sendDate`). */
  const oldestOf = (rows: CandidateRow[]): CandidateRow =>
    rows.reduce((acc, row) =>
      row.notification.sendDate < acc.notification.sendDate ? row : acc,
    );

  /** Aviso novo escolhido por item (vem de `pending`). */
  const newNotices = new Map<number, CandidateRow>();
  /** Retentativa escolhida por item (vem de `failed`). */
  const retries = new Map<number, CandidateRow>();
  const lostByToday: number[] = [];
  const lostByRecovery: number[] = [];

  for (const [billId, rows] of byBill) {
    const pending = rows.filter((row) => row.notification.state === 'pending');
    const failed = rows.filter((row) => row.notification.state === 'failed');

    const nominal = pending.filter((row) => row.notification.sendDate === today);
    const lost = pending.filter((row) => row.notification.sendDate < today);

    if (nominal.length > 0) {
      // Marco nominal do dia: um único aviso novo, o do próprio dia.
      newNotices.set(billId, nominal[0]);
      for (const row of lost) lostByToday.push(row.notification.id);
    } else if (lost.length > 0) {
      // Sem marco nominal do dia: recupera o marco perdido mais antigo.
      const catchUp = oldestOf(lost);
      newNotices.set(billId, catchUp);
      for (const row of lost) {
        if (row.notification.id === catchUp.notification.id) continue;
        lostByRecovery.push(row.notification.id);
      }
    }

    // Retentativa: o `failed` mais antigo é reenviado sempre — mesmo quando
    // o item já recebeu um aviso novo no mesmo dia. Os `failed` que não foram
    // escolhidos **continuam `failed`** e serão retentados nas próximas
    // execuções, um por vez.
    if (failed.length > 0) {
      retries.set(billId, oldestOf(failed));
    }
  }
  summary.notificationsSelected = newNotices.size + retries.size;

  // Marcos perdidos cobertos por um aviso do mesmo dia viram `skipped`, com o
  // motivo no `last_error` (mesmo campo usado para registrar a falha de envio).
  const skipLost = (ids: number[], reason: string): void => {
    if (ids.length === 0) return;
    if (!simulate) {
      const result = db
        .update(billReminderNotifications)
        .set({ state: 'skipped', lastError: reason, updatedAt: timestamp })
        .where(inArray(billReminderNotifications.id, ids))
        .run();
      summary.notificationsSkipped += result.changes;
      return;
    }
    summary.notificationsSkipped += ids.length;
  };
  skipLost(lostByToday, SKIP_REASON_COVERED_BY_TODAY);
  skipLost(lostByRecovery, SKIP_REASON_COVERED_BY_RECOVERY);

  // 5. Envio agrupado por (marco, data-alvo): 1 e-mail por marco/dia.
  const groups = new Map<string, CandidateRow[]>();
  for (const row of [...newNotices.values(), ...retries.values()]) {
    const key = `${row.notification.milestone}|${row.notification.sendDate}`;
    const list = groups.get(key);
    if (list) {
      list.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  const orderedGroups = [...groups.entries()].sort(([keyA], [keyB]) =>
    keyA < keyB ? -1 : keyA > keyB ? 1 : 0,
  );

  // Valores do SMTP que jamais podem aparecer no `last_error` nem no log.
  const smtpSecrets = [
    config.smtp?.host ?? '',
    config.smtp?.user ?? '',
    config.smtp?.password ?? '',
  ].filter((value) => value.trim() !== '');

  for (const [, group] of orderedGroups) {
    const first = group[0].notification;
    const milestone = first.milestone as ReminderMilestone;
    const sendDate = first.sendDate;
    const notificationIds = group.map((row) => row.notification.id);
    const itemCount = group.length;

    const existingBatch = db
      .select()
      .from(billReminderBatches)
      .where(
        and(
          eq(billReminderBatches.milestone, milestone),
          eq(billReminderBatches.sendDate, sendDate),
        ),
      )
      .get();

    if (existingBatch && existingBatch.state === 'sent') {
      // O e-mail deste marco já saiu — mas **para outros itens**. A notificação
      // continua `pending` (o item permanece elegível) e o motivo fica
      // auditável em `last_error`.
      if (!simulate) {
        db.update(billReminderNotifications)
          .set({ lastError: SKIP_REASON_BATCH_ALREADY_SENT, updatedAt: timestamp })
          .where(inArray(billReminderNotifications.id, notificationIds))
          .run();
      }
      summary.batches.push({ milestone, sendDate, itemCount, state: 'skipped' });
      continue;
    }

    let batchId = -1;
    if (existingBatch) {
      // Novo envio de um lote que ainda não saiu (retry de uma falha).
      batchId = existingBatch.id;
      if (!simulate) {
        db.update(billReminderBatches)
          .set({
            state: 'pending',
            attempts: existingBatch.attempts + 1,
            itemCount,
            recipient,
            updatedAt: timestamp,
          })
          .where(eq(billReminderBatches.id, existingBatch.id))
          .run();
      }
    } else if (simulate) {
      // Simulação: o lote só existiria — nada é gravado.
      batchId = -1;
    } else {
      try {
        batchId = db
          .insert(billReminderBatches)
          .values({
            milestone,
            sendDate,
            state: 'pending',
            attempts: 1,
            itemCount,
            recipient,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .returning({ id: billReminderBatches.id })
          .get().id;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Outro processo gravou o lote do marco primeiro: o aviso já saiu.
        db.update(billReminderNotifications)
          .set({ state: 'skipped', lastError: SKIP_REASON_CONCURRENT_SEND, updatedAt: timestamp })
          .where(inArray(billReminderNotifications.id, notificationIds))
          .run();
        summary.notificationsSkipped += itemCount;
        summary.batches.push({ milestone, sendDate, itemCount, state: 'skipped' });
        logger.warn(
          { milestone, sendDate },
          'Outro processo já enviou o lembrete deste marco; ciclo ignorado.',
        );
        continue;
      }
    }

    const items: ReminderItemView[] = group.map((row) => ({
      billId: row.notification.billId,
      description: row.description,
      dueDate: row.notification.dueDate,
      categoryName: row.categoryName,
    }));

    const content = buildReminderEmail({ milestone, sendDate, today, items });
    const message: ReminderMessage = {
      to: recipient,
      subject: content.subject,
      text: content.text,
      html: content.html,
      messageId: buildReminderMessageId(milestone, sendDate),
    };

    try {
      await transport.send(message);
    } catch (error) {
      // A causa do erro é sempre o transporte: nem a descrição nem o valor da
      // conta entram no `last_error` (redação defensiva por segurança).
      const secrets = [
        ...smtpSecrets,
        ...items
          .map((item) => item.description.trim())
          .filter((description) => description.length >= MIN_FREE_TEXT_LENGTH),
      ];
      const reason = sanitizeReminderError(error, secrets);

      const failedIds: number[] = [];
      const exhaustedIds: number[] = [];
      for (const row of group) {
        const attemptsAfter = row.notification.attempts + 1;
        if (attemptsAfter >= MAX_DELIVERY_ATTEMPTS) exhaustedIds.push(row.notification.id);
        else failedIds.push(row.notification.id);
      }

      if (!simulate) {
        db.update(billReminderBatches)
          .set({ state: 'failed', lastError: reason, updatedAt: timestamp })
          .where(eq(billReminderBatches.id, batchId))
          .run();
        if (failedIds.length > 0) {
          db.update(billReminderNotifications)
            .set({
              state: 'failed',
              attempts: sql`${billReminderNotifications.attempts} + 1`,
              lastError: reason,
              batchId,
              updatedAt: timestamp,
            })
            .where(inArray(billReminderNotifications.id, failedIds))
            .run();
        }
        if (exhaustedIds.length > 0) {
          db.update(billReminderNotifications)
            .set({
              state: 'skipped',
              attempts: sql`${billReminderNotifications.attempts} + 1`,
              lastError: SKIP_REASON_MAX_ATTEMPTS,
              batchId,
              updatedAt: timestamp,
            })
            .where(inArray(billReminderNotifications.id, exhaustedIds))
            .run();
        }
      }
      summary.emailsFailed += 1;
      summary.notificationsFailed += failedIds.length;
      summary.notificationsSkipped += exhaustedIds.length;
      summary.batches.push({ milestone, sendDate, itemCount, state: 'failed' });
      logger.error({ error: reason }, 'Falha ao enviar lembrete de contas a pagar.');
      continue;
    }

    if (!simulate) {
      db.update(billReminderBatches)
        .set({ state: 'sent', sentAt: timestamp, lastError: null, updatedAt: timestamp })
        .where(eq(billReminderBatches.id, batchId))
        .run();
      db.update(billReminderNotifications)
        .set({
          state: 'sent',
          attempts: sql`${billReminderNotifications.attempts} + 1`,
          lastError: null,
          sentAt: timestamp,
          batchId,
          updatedAt: timestamp,
        })
        .where(inArray(billReminderNotifications.id, notificationIds))
        .run();
    }
    summary.emailsSent += 1;
    summary.notificationsSent += itemCount;
    summary.batches.push({ milestone, sendDate, itemCount, state: 'sent' });
  }

  logger.info(
    {
      today,
      simulated: simulate,
      eligibleBills: summary.eligibleBills,
      emailsSent: summary.emailsSent,
      emailsFailed: summary.emailsFailed,
    },
    simulate
      ? 'Ciclo de lembretes concluído (simulação: nada foi gravado).'
      : 'Ciclo de lembretes concluído.',
  );

  return summary;
}
