import { z } from 'zod';

/**
 * Configuração dos lembretes por e-mail.
 *
 * Toda a configuração vem de variáveis de ambiente (fronteira externa) e é
 * validada com Zod. O padrão é **seguro**: transporte `dry-run` (nenhum e-mail
 * real sai) e recurso **desabilitado** enquanto não houver destinatário.
 */

/** Fuso usado para calcular "hoje". Constante no código, não é variável de ambiente. */
export const REMINDER_TIME_ZONE = 'America/Sao_Paulo';

/** Janela de catch-up padrão (dias). */
export const DEFAULT_CATCH_UP_DAYS = 3;

/** Intervalo padrão do agendador interno (minutos). */
export const DEFAULT_INTERVAL_MINUTES = 30;

/** Remetente padrão (endereço local, sem serviço externo). */
export const DEFAULT_REMINDER_FROM = 'finance@localhost';

export type ReminderTransportKind = 'dry-run' | 'smtp';

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
}

export interface BillReminderConfig {
  /** `false` quando falta o destinatário: o recurso fica desligado, sem erro. */
  enabled: boolean;
  transport: ReminderTransportKind;
  to: string | null;
  from: string;
  smtp: SmtpSettings | null;
  /** Janela de recuperação de marcos perdidos (dias). */
  catchUpDays: number;
  /** Intervalo do agendador interno (minutos). */
  intervalMinutes: number;
}

/** Erro de configuração: mensagem explícita, sem credencial ou valor no texto. */
export class BillReminderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillReminderConfigError';
  }
}

// Aceita endereços locais (`finance@localhost`) e domínios completos.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+(\.[^\s@]+)*$/;

const transportSchema = z.enum(['dry-run', 'smtp']);

const intSchema = (fallback: number, min: number, max: number) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : Number(value)))
    .refine((value) => Number.isInteger(value) && value >= min && value <= max, {
      message: `deve ser um inteiro entre ${min} e ${max}`,
    });

const booleanSchema = z
  .string()
  .trim()
  .optional()
  .transform((value) => {
    if (value === undefined || value === '') return false;
    const normalized = value.toLowerCase();
    if (['true', '1', 'yes', 'sim', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'nao', 'não', 'off'].includes(normalized)) return false;
    return null;
  })
  .refine((value) => value !== null, {
    message: 'deve ser true/false, 1/0, yes/no ou on/off',
  })
  .transform((value) => value === true);

function readOptional(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  if (raw === undefined) return null;
  const trimmed = String(raw).trim();
  return trimmed === '' ? null : trimmed;
}

function parseWithSchema<S extends z.ZodTypeAny>(
  key: string,
  schema: S,
  value: string | undefined,
): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0]?.message ?? 'valor inválido';
    throw new BillReminderConfigError(`${key} inválido: ${issue}.`);
  }
  return result.data;
}

/**
 * Lê a configuração do ambiente. Sem `BILL_REMINDER_TO` o recurso fica
 * desabilitado (sem erro). Valores inválidos geram `BillReminderConfigError`.
 */
export function loadBillReminderConfig(env: NodeJS.ProcessEnv = process.env): BillReminderConfig {
  const transport = parseWithSchema(
    'BILL_REMINDER_TRANSPORT',
    transportSchema.optional().transform((value) => value ?? 'dry-run'),
    env.BILL_REMINDER_TRANSPORT,
  );

  const to = readOptional(env, 'BILL_REMINDER_TO');
  if (to && !EMAIL_PATTERN.test(to)) {
    throw new BillReminderConfigError('BILL_REMINDER_TO inválido: informe um endereço de e-mail.');
  }

  const from = readOptional(env, 'BILL_REMINDER_FROM') ?? DEFAULT_REMINDER_FROM;
  if (!EMAIL_PATTERN.test(from)) {
    throw new BillReminderConfigError('BILL_REMINDER_FROM inválido: informe um endereço de e-mail.');
  }

  const catchUpDays = parseWithSchema(
    'BILL_REMINDER_CATCH_UP_DAYS',
    intSchema(DEFAULT_CATCH_UP_DAYS, 0, 30),
    env.BILL_REMINDER_CATCH_UP_DAYS,
  );

  const intervalMinutes = parseWithSchema(
    'BILL_REMINDER_INTERVAL_MINUTES',
    intSchema(DEFAULT_INTERVAL_MINUTES, 1, 24 * 60),
    env.BILL_REMINDER_INTERVAL_MINUTES,
  );

  const host = readOptional(env, 'BILL_REMINDER_SMTP_HOST');
  const port = parseWithSchema(
    'BILL_REMINDER_SMTP_PORT',
    intSchema(587, 1, 65_535),
    env.BILL_REMINDER_SMTP_PORT,
  );
  const secure = parseWithSchema(
    'BILL_REMINDER_SMTP_SECURE',
    booleanSchema,
    env.BILL_REMINDER_SMTP_SECURE,
  );
  const user = readOptional(env, 'BILL_REMINDER_SMTP_USER');
  const password = readOptional(env, 'BILL_REMINDER_SMTP_PASSWORD');

  const smtp: SmtpSettings | null =
    host || user || password ? { host: host ?? '', port, secure, user, password } : null;

  // Sem destinatário o recurso fica desligado e nada mais é exigido.
  if (transport === 'smtp' && to) {
    const missing: string[] = [];
    if (!host) missing.push('BILL_REMINDER_SMTP_HOST');
    if (!user) missing.push('BILL_REMINDER_SMTP_USER');
    if (!password) missing.push('BILL_REMINDER_SMTP_PASSWORD');
    if (missing.length > 0) {
      throw new BillReminderConfigError(
        `Transporte SMTP sem credenciais completas. Defina: ${missing.join(', ')}.`,
      );
    }
  }

  return {
    enabled: Boolean(to),
    transport,
    to,
    from,
    smtp,
    catchUpDays,
    intervalMinutes,
  };
}

/** Configuração desligada, usada quando a leitura do ambiente falha. */
export function disabledBillReminderConfig(): BillReminderConfig {
  return {
    enabled: false,
    transport: 'dry-run',
    to: null,
    from: DEFAULT_REMINDER_FROM,
    smtp: null,
    catchUpDays: DEFAULT_CATCH_UP_DAYS,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  };
}
