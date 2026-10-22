/**
 * Transportes de envio dos lembretes.
 *
 * A interface é a fronteira do núcleo `runBillReminders`: o núcleo decide
 * *o que* enviar, o transporte decide *como*. Nenhuma implementação aqui abre
 * socket — o transporte SMTP real fica em `bill-reminder-smtp.ts` e só é
 * carregado quando o ambiente pede explicitamente por ele.
 */

/** Mensagem pronta para envio. Não contém valor monetário. */
export interface ReminderMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
}

export interface ReminderTransport {
  /** Identificador do transporte (`dry-run`, `smtp`, `fake`). */
  readonly kind: string;
  /**
   * `false` quando o transporte **não confirma entrega** (simulação).
   *
   * O núcleo usa este sinal para decidir se o ciclo grava o ledger: com
   * `persists === false` o ciclo é uma simulação pura e **não escreve nada**
   * no banco — assim a pré-visualização (`dry-run`) nunca consome o aviso do
   * dia e o e-mail real continua saindo quando o transporte de verdade é
   * configurado.
   */
  readonly persists: boolean;
  send(message: ReminderMessage): Promise<void>;
}

/** E-mail "enviado" pelo transporte de simulação. */
export interface DryRunMessage extends ReminderMessage {
  sentAt: string;
}

/**
 * Transporte de desenvolvimento: guarda as mensagens em memória e **não**
 * abre conexão com nenhum servidor de e-mail.
 *
 * `persists = false`: o ciclo que o usa é uma **simulação** e não grava
 * nada no banco (nenhum lote, nenhuma notificação). O aviso do dia **não é
 * consumido** — ele continua elegível para o ciclo com transporte real.
 */
export class DryRunTransport implements ReminderTransport {
  readonly kind = 'dry-run';
  readonly persists = false;
  readonly messages: DryRunMessage[] = [];

  async send(message: ReminderMessage): Promise<void> {
    this.messages.push({ ...message, sentAt: new Date().toISOString() });
  }
}

export interface FakeTransportOptions {
  /** Falha em todas as mensagens. */
  failAll?: boolean;
  /** Falha nas próximas N mensagens. */
  failTimes?: number;
  /** Decide caso a caso se a mensagem deve falhar. */
  shouldFail?: (message: ReminderMessage) => boolean;
}

/**
 * Transporte de teste: registra o que foi enviado e pode falhar de propósito,
 * para exercitar o caminho de erro (retry e `last_error`) sem rede.
 *
 * `persists = true`: ele **simula** o envio bem-sucedido, então o ledger
 * precisa ser gravado — do contrário os testes de idempotência não teriam
 * como provar que o aviso não é reenviado.
 */
export class FakeTransport implements ReminderTransport {
  readonly kind = 'fake';
  readonly persists = true;
  readonly sent: ReminderMessage[] = [];
  readonly failed: ReminderMessage[] = [];

  private remainingFailures: number;
  private readonly shouldFail: ((message: ReminderMessage) => boolean) | undefined;

  constructor(options: FakeTransportOptions = {}) {
    this.remainingFailures = options.failTimes ?? (options.failAll ? Number.POSITIVE_INFINITY : 0);
    this.shouldFail = options.shouldFail;
  }

  async send(message: ReminderMessage): Promise<void> {
    const forced = this.shouldFail?.(message) === true;
    if (forced || this.remainingFailures > 0) {
      if (!forced && this.remainingFailures !== Number.POSITIVE_INFINITY) {
        this.remainingFailures -= 1;
      }
      this.failed.push(message);
      throw new Error('Falha simulada no transporte de lembretes.');
    }
    this.sent.push(message);
  }
}
