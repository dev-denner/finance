import type { BillReminderConfig } from './bill-reminder-config';
import type { ReminderMessage, ReminderTransport } from './bill-reminder-transport';

/**
 * Transporte SMTP real.
 *
 * O pacote `nodemailer` é carregado **sob demanda** (`await import`), e só
 * quando o transporte `smtp` está de fato configurado: importar este módulo
 * nunca abre conexão nem exige credencial. Sem as variáveis de ambiente
 * obrigatórias, a criação do transporte falha com uma mensagem clara.
 *
 * **TLS é obrigatório**: sem TLS implícito (porta diferente de 465) o
 * `STARTTLS` é exigido — a conexão aborta se o servidor não anunciar — e o
 * mínimo aceito é TLS 1.2. Senha e corpo do e-mail nunca trafegam em claro.
 */

export interface SmtpTransportOptions {
  host: string;
  port: number;
  /** `true` quando a conexão já é TLS (implícita). */
  secure: boolean;
  /** `true` quando o servidor precisa anunciar `STARTTLS`. */
  requireTLS: boolean;
  auth: { user: string; pass: string };
  tls: { minVersion: 'TLSv1.2' };
}

export interface NodemailerTransporter {
  sendMail(options: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
    messageId: string;
  }): Promise<unknown>;
}

export interface NodemailerModule {
  createTransport(options: SmtpTransportOptions): NodemailerTransporter;
}

/**
 * Carregador do módulo de e-mail. A implementação padrão importa o
 * `nodemailer` sob demanda; os testes injetam um dublê (nunca há rede).
 */
export type NodemailerModuleLoader = () => Promise<NodemailerModule>;

async function loadNodemailer(): Promise<NodemailerModule> {
  // `nodemailer` não traz tipos próprios e adicionar `@types/nodemailer`
  // exigiria nova dependência (não autorizada). Por isso o especificador vai
  // em variável — o TypeScript não resolve o módulo — e o formato usado é
  // tipado localmente.
  const specifier: string = 'nodemailer';
  const loaded: unknown = await import(specifier);
  const candidate = loaded as { default?: NodemailerModule } & NodemailerModule;
  const module = candidate.default ?? candidate;
  if (typeof module.createTransport !== 'function') {
    throw new Error('Não foi possível carregar o cliente de e-mail (nodemailer).');
  }
  return module;
}

/** Porta de TLS implícito: a conexão já é criptografada, sem `STARTTLS`. */
export const SMTP_IMPLICIT_TLS_PORT = 465;

export class SmtpTransport implements ReminderTransport {
  readonly kind = 'smtp';
  /** O transporte real confirma a entrega: o ledger pode ser gravado. */
  readonly persists = true;

  private transporter: NodemailerTransporter | null = null;

  constructor(
    private readonly options: SmtpTransportOptions,
    private readonly from: string,
    private readonly loadModule: NodemailerModuleLoader = loadNodemailer,
  ) {}

  async send(message: ReminderMessage): Promise<void> {
    const transporter = await this.getTransporter();
    await transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      messageId: message.messageId,
    });
  }

  private async getTransporter(): Promise<NodemailerTransporter> {
    if (this.transporter) return this.transporter;
    const nodemailer = await this.loadModule();
    this.transporter = nodemailer.createTransport(this.options);
    return this.transporter;
  }
}

export interface CreateSmtpTransportOptions {
  /** Carregador do módulo de e-mail (testes injetam um dublê). */
  moduleLoader?: NodemailerModuleLoader;
}

/**
 * Cria o transporte SMTP a partir da configuração. Falha com mensagem
 * explícita quando as credenciais obrigatórias não estão presentes.
 */
export function createSmtpTransport(
  config: BillReminderConfig,
  options: CreateSmtpTransportOptions = {},
): SmtpTransport {
  if (config.transport !== 'smtp') {
    throw new Error(
      'O transporte SMTP exige BILL_REMINDER_TRANSPORT=smtp (o padrão é dry-run).',
    );
  }
  if (!config.to) {
    throw new Error('Defina BILL_REMINDER_TO para enviar lembretes por e-mail.');
  }

  const smtp = config.smtp;
  const missing: string[] = [];
  if (!smtp?.host) missing.push('BILL_REMINDER_SMTP_HOST');
  if (!smtp?.user) missing.push('BILL_REMINDER_SMTP_USER');
  if (!smtp?.password) missing.push('BILL_REMINDER_SMTP_PASSWORD');
  if (missing.length > 0 || !smtp) {
    throw new Error(
      `Transporte SMTP sem credenciais completas. Defina: ${missing.join(', ')}.`,
    );
  }

  const user = smtp.user;
  const password = smtp.password;
  if (!user || !password) {
    throw new Error(
      'Transporte SMTP sem credenciais completas. Defina: BILL_REMINDER_SMTP_USER, BILL_REMINDER_SMTP_PASSWORD.',
    );
  }

  // TLS implícito: a porta 465 já é criptografada. Nas demais, o `STARTTLS`
  // é obrigatório — sem ele a conexão aborta (nada trafega em claro).
  const secure = smtp.secure || smtp.port === SMTP_IMPLICIT_TLS_PORT;

  return new SmtpTransport(
    {
      host: smtp.host,
      port: smtp.port,
      secure,
      requireTLS: !secure,
      auth: { user, pass: password },
      tls: { minVersion: 'TLSv1.2' },
    },
    config.from,
    options.moduleLoader,
  );
}
