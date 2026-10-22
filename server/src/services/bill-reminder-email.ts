/**
 * Renderização do e-mail de lembrete de contas a pagar.
 *
 * Módulo **puro**: nenhuma entrada/saída, nenhum acesso a banco ou rede.
 * A garantia estrutural de privacidade está no tipo `ReminderItemView`, que
 * **não possui** `amountCents` — o compilador impede que um valor monetário
 * chegue ao corpo do e-mail por engano.
 *
 * O texto usa **a data real do envio** (`today`), nunca a data-alvo do marco.
 * Quando há itens vencidos, o e-mail orienta a agir logo, sem expor detalhes
 * internos de agendamento, como marcos ou recuperação.
 *
 * Cada item mostra também **quantos dias faltam** para o vencimento
 * (calculado a partir de `today` e do `dueDate` do item) — é a informação
 * que o usuário precisa para priorizar, e **não** envolve valor monetário.
 */

import { daysBetweenIso } from '../lib/dates';

/** Marcos de aviso, do mais distante para o mais próximo do vencimento. */
export const REMINDER_MILESTONES = ['D-3', 'D-2', 'D-1', 'D0'] as const;

export type ReminderMilestone = (typeof REMINDER_MILESTONES)[number];

/** Quantos dias antes do vencimento cada marco dispara. */
export const MILESTONE_DAYS_BEFORE: Record<ReminderMilestone, number> = {
  'D-3': 3,
  'D-2': 2,
  'D-1': 1,
  D0: 0,
};

/** Item exibido no e-mail. Não há valor monetário por desenho. */
export interface ReminderItemView {
  /** Identificador da conta (usado apenas para rastreio interno). */
  billId: number;
  /** Descrição da conta a pagar. */
  description: string;
  /** Vencimento em ISO (AAAA-MM-DD). */
  dueDate: string;
  /** Nome da categoria. */
  categoryName: string;
}

export interface ReminderEmailInput {
  milestone: ReminderMilestone;
  /** Data-alvo do marco (AAAA-MM-DD): quando o aviso *deveria* ter saído. */
  sendDate: string;
  /** Data real do envio (AAAA-MM-DD). */
  today: string;
  items: ReminderItemView[];
}

export interface ReminderEmailContent {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Converte ISO (AAAA-MM-DD) em DD/MM/AAAA. */
function formatBr(date: string): string {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return date;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

/**
 * Prazo restante do item, calculado em dias de calendário entre a data do
 * envio (`today`) e o vencimento. `null` quando a data é inválida.
 */
export function remainingDaysLabel(today: string, dueDate: string): string | null {
  const days = daysBetweenIso(today, dueDate);
  if (days === null) return null;
  if (days === 0) return 'vence hoje';
  if (days === 1) return 'vence amanhã';
  if (days > 1) return `faltam ${days} dias`;
  if (days === -1) return 'venceu ontem';
  return `venceu há ${Math.abs(days)} dias`;
}

/** Vencimento com o prazo restante entre parênteses (sem valor monetário). */
function dueDateLabel(today: string, dueDate: string): string {
  const base = formatBr(dueDate);
  const remaining = remainingDaysLabel(today, dueDate);
  return remaining ? `${base} (${remaining})` : base;
}

/**
 * Monta o assunto, o texto e o HTML do aviso.
 * O conteúdo deixa explícito que os itens **precisam ser agendados** (AC-11),
 * priorizando a ação do usuário em vez de detalhes técnicos do mecanismo.
 *
 * O texto sempre informa **a data real do envio**. Quando há atraso, o corpo
 * destaca que existem contas vencidas — a data de vencimento de cada item
 * continua na lista, porque é a referência real do prazo.
 */
export function buildReminderEmail(input: ReminderEmailInput): ReminderEmailContent {
  const { sendDate, today, items } = input;
  const count = items.length;
  const itemLabel = pluralize(count, 'conta a pagar', 'contas a pagar');
  const verbLabel = pluralize(count, 'precisa', 'precisam');
  const schedule = `${count} ${itemLabel} ${verbLabel} ser agendada${count === 1 ? '' : 's'}`;

  /** Marco atrasado: há itens vencidos que merecem prioridade. */
  const late = sendDate < today;
  const pendingLabel = pluralize(count, 'conta pendente', 'contas pendentes');
  const subject = `Finance: ${count} ${pendingLabel} para agendar`;

  const lines: string[] = [];
  lines.push('Finance — contas pendentes para agendar');
  lines.push('');
  lines.push(`Hoje, ${formatBr(today)}, ${schedule}.`);
  if (late) {
    lines.push('');
    lines.push('Atenção: há contas vencidas nesta lista. Agende-as assim que possível.');
  }
  lines.push('');
  lines.push('Contas para agendar');
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.description}`);
    lines.push(`   Vencimento: ${dueDateLabel(today, item.dueDate)}`);
    lines.push(`   Categoria: ${item.categoryName}`);
  });
  lines.push('');
  lines.push('Próximo passo');
  lines.push('Abra o Finance e marque cada conta como agendada.');
  lines.push('');
  lines.push('Este e-mail não inclui valores.');

  const text = lines.join('\n');

  const htmlItems = items
    .map(
      (item) => `
                    <tr>
                      <td style="padding: 16px; border: 1px solid #e2e8f0; border-radius: 8px; background: #ffffff;">
                        <p style="margin: 0 0 8px; font-size: 16px; font-weight: 700; color: #172554;">${escapeHtml(
                          item.description,
                        )}</p>
                        <p style="margin: 0; color: #475569; line-height: 1.5;">
                          <strong style="color: #334155;">Vencimento:</strong> ${escapeHtml(
                            dueDateLabel(today, item.dueDate),
                          )}<br />
                          <strong style="color: #334155;">Categoria:</strong> ${escapeHtml(item.categoryName)}
                        </p>
                      </td>
                    </tr>
                    <tr><td style="height: 12px;"></td></tr>`,
    )
    .join('\n');

  const htmlLate = late
    ? `
                    <tr>
                      <td style="padding: 12px 16px; border-left: 4px solid #d97706; background: #fffbeb; color: #92400e; font-size: 14px; line-height: 1.5;">
                        <strong>Atenção:</strong> há contas vencidas nesta lista. Agende-as assim que possível.
                      </td>
                    </tr>
                    <tr><td style="height: 20px;"></td></tr>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
  <body style="margin: 0; padding: 24px 12px; background: #f1f5f9; font-family: Arial, Helvetica, sans-serif; color: #1e293b;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width: 100%; max-width: 600px; overflow: hidden; border-radius: 12px; background: #ffffff;">
            <tr>
              <td style="padding: 28px 32px; background: #172554; color: #ffffff;">
                <p style="margin: 0 0 8px; font-size: 14px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #bfdbfe;">Finance</p>
                <h1 style="margin: 0; font-size: 24px; line-height: 1.25;">Contas pendentes para agendar</h1>
              </td>
            </tr>
            <tr>
              <td style="padding: 28px 32px 12px;">
                <p style="margin: 0; font-size: 16px; line-height: 1.6; color: #334155;">Hoje, ${escapeHtml(
                  formatBr(today),
                )}, <strong>${escapeHtml(schedule)}</strong>.</p>
              </td>
            </tr>
            <tr>
              <td style="padding: 8px 32px 0;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${htmlLate}
${htmlItems}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding: 12px 32px 28px;">
                <div style="padding: 16px; border-radius: 8px; background: #eff6ff; color: #1e3a8a; line-height: 1.5;">
                  <strong>Próximo passo</strong><br />
                  Abra o Finance e marque cada conta como agendada.
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding: 18px 32px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 12px; line-height: 1.5;">
                Este e-mail não inclui valores. Você receberá lembretes enquanto houver contas pendentes.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}

/**
 * `Message-ID` determinístico por (marco, data-alvo), para deduplicação no
 * cliente de e-mail: `<bill-reminder-D-3-2026-10-22@finance.local>`.
 */
export function buildReminderMessageId(milestone: string, sendDate: string): string {
  const safeMilestone = String(milestone).replace(/[^A-Za-z0-9-]/g, '');
  const safeDate = String(sendDate).replace(/[^0-9-]/g, '');
  return `<bill-reminder-${safeMilestone}-${safeDate}@finance.local>`;
}
