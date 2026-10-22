/**
 * Renderização do e-mail de lembrete de contas a pagar.
 *
 * Módulo **puro**: nenhuma entrada/saída, nenhum acesso a banco ou rede.
 * A garantia estrutural de privacidade está no tipo `ReminderItemView`, que
 * **não possui** `amountCents` — o compilador impede que um valor monetário
 * chegue ao corpo do e-mail por engano.
 *
 * O texto usa **a data real do envio** (`today`), nunca a data-alvo do marco:
 * num aviso de recuperação o marco já passou, e dizer "Aviso gerado em
 * 18/10/2026" num e-mail entregue em 21/10/2026 seria falso. Quando o marco é
 * atrasado (`sendDate < today`), o e-mail diz que é um aviso de recuperação e
 * informa a data prevista do marco.
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
 * O conteúdo deixa explícito que os itens **precisam ser agendados** (AC-11)
 * e que o aviso acontece no máximo uma vez por marco.
 *
 * O texto sempre informa **a data real do envio**. Quando o marco já passou
 * (`sendDate < today`), o assunto ganha o sufixo `— recuperação` e o corpo
 * diz que o marco previsto já havia passado — a data de vencimento de cada
 * item continua na lista, porque é a referência real do prazo.
 */
export function buildReminderEmail(input: ReminderEmailInput): ReminderEmailContent {
  const { milestone, sendDate, today, items } = input;
  const count = items.length;
  const itemLabel = pluralize(count, 'conta a pagar', 'contas a pagar');
  const verbLabel = pluralize(count, 'precisa', 'precisam');
  const schedule = `${count} ${itemLabel} ${verbLabel} ser agendada${count === 1 ? '' : 's'}`;

  /** Marco atrasado: o aviso é enviado depois da data prevista. */
  const late = sendDate < today;
  const suffix = late ? ' — recuperação' : '';

  const subject = `Finance: ${schedule} (${milestone}${suffix})`;

  const lines: string[] = [];
  lines.push(`Finance — lembrete de contas a pagar (marco ${milestone}${suffix})`);
  lines.push('');
  lines.push(`Aviso enviado em ${formatBr(today)}: ${schedule}.`);
  if (late) {
    lines.push('');
    lines.push(
      `Este aviso é de recuperação: o marco ${milestone} (previsto para ${formatBr(
        sendDate,
      )}) já havia passado.`,
    );
  }
  lines.push('');
  lines.push('Itens que precisam ser agendados:');
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.description}`);
    lines.push(`   Vencimento: ${dueDateLabel(today, item.dueDate)}`);
    lines.push(`   Categoria: ${item.categoryName}`);
  });
  lines.push('');
  lines.push('Observações:');
  lines.push(
    '- Estes itens ainda não estão agendados. Abra o Finance e marque cada conta como agendada.',
  );
  lines.push(
    `- Cada marco (${REMINDER_MILESTONES.join(', ')}) gera no máximo um aviso por conta.`,
  );
  lines.push(
    '- Marcar uma conta como agendada interrompe os avisos restantes dessa conta.',
  );
  lines.push(
    '- Por segurança, este e-mail não informa valores. Consulte o aplicativo Finance para ver os detalhes.',
  );

  const text = lines.join('\n');

  const htmlItems = items
    .map(
      (item) => `      <li>
        <strong>${escapeHtml(item.description)}</strong><br />
        Vencimento: ${escapeHtml(dueDateLabel(today, item.dueDate))}<br />
        Categoria: ${escapeHtml(item.categoryName)}
      </li>`,
    )
    .join('\n');

  const htmlLate = late
    ? `
    <p>Este aviso é de recuperação: o marco ${escapeHtml(
        milestone,
      )} (previsto para ${escapeHtml(
        formatBr(sendDate),
      )}) já havia passado.</p>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
  <body style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #1f2933;">
    <h2 style="font-size: 18px; margin: 0 0 12px;">Finance &mdash; lembrete de contas a pagar (marco ${escapeHtml(
      milestone,
    )}${escapeHtml(suffix)})</h2>
    <p>Aviso enviado em ${escapeHtml(formatBr(today))}: <strong>${escapeHtml(schedule)}</strong>.</p>${htmlLate}
    <p>Itens que precisam ser agendados:</p>
    <ol>
${htmlItems}
    </ol>
    <p>Observações:</p>
    <ul>
      <li>Estes itens ainda não estão agendados. Abra o Finance e marque cada conta como agendada.</li>
      <li>Cada marco (${escapeHtml(REMINDER_MILESTONES.join(', '))}) gera no máximo um aviso por conta.</li>
      <li>Marcar uma conta como agendada interrompe os avisos restantes dessa conta.</li>
      <li>Por segurança, este e-mail não informa valores. Consulte o aplicativo Finance para ver os detalhes.</li>
    </ul>
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
