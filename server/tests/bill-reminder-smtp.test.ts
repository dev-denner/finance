import { describe, expect, it } from 'vitest';
import {
  BillReminderConfigError,
  loadBillReminderConfig,
  type BillReminderConfig,
} from '../src/services/bill-reminder-config';
import {
  createSmtpTransport,
  SmtpTransport,
  type NodemailerModule,
  type SmtpTransportOptions,
} from '../src/services/bill-reminder-smtp';
import type { ReminderMessage } from '../src/services/bill-reminder-transport';

/**
 * Transporte SMTP e configuração dos lembretes.
 *
 * Cobertura:
 * - `createSmtpTransport` falha com erro claro (transporte, destinatário e
 *   credenciais);
 * - `SmtpTransport.send` mapeia a mensagem para a chamada do cliente de
 *   e-mail — **com um módulo falso injetado**, nunca com a rede;
 * - `loadBillReminderConfig` valida e-mail, janelas e o booleano de TLS;
 * - TLS: `STARTTLS` obrigatório na porta 587 e TLS implícito na porta 465.
 *
 * Nenhum teste abre socket: o `nodemailer` é substituído por um dublê.
 */

const RECIPIENT = 'lembretes@exemplo.invalid';

function smtpConfig(overrides: Partial<BillReminderConfig> = {}): BillReminderConfig {
  return {
    enabled: true,
    transport: 'smtp',
    to: RECIPIENT,
    from: 'finance@localhost',
    smtp: { host: 'smtp.invalid', port: 587, secure: false, user: 'usuario', password: 'senha' },
    catchUpDays: 3,
    intervalMinutes: 30,
    ...overrides,
  };
}

interface FakeNodemailer {
  module: NodemailerModule;
  options: SmtpTransportOptions[];
  messages: Record<string, unknown>[];
}

function fakeNodemailer(): FakeNodemailer {
  const options: SmtpTransportOptions[] = [];
  const messages: Record<string, unknown>[] = [];
  const module: NodemailerModule = {
    createTransport(received) {
      options.push(received);
      return {
        async sendMail(message) {
          messages.push(message);
          return { messageId: message.messageId };
        },
      };
    },
  };
  return { module, options, messages };
}

const MESSAGE: ReminderMessage = {
  to: RECIPIENT,
  subject: 'Finance: 1 conta a pagar precisa ser agendada (D-3)',
  text: 'corpo de teste',
  html: '<p>corpo de teste</p>',
  messageId: '<bill-reminder-D-3-2026-03-10@finance.local>',
};

describe('transporte SMTP — criação', () => {
  it('deve recusar quando o transporte configurado não é smtp', () => {
    const config = smtpConfig({ transport: 'dry-run' });

    expect(() => createSmtpTransport(config)).toThrow(/BILL_REMINDER_TRANSPORT=smtp/);
  });

  it('deve recusar quando falta o destinatário', () => {
    const config = smtpConfig({ to: null });

    expect(() => createSmtpTransport(config)).toThrow(/BILL_REMINDER_TO/);
  });

  it('deve recusar quando faltam as credenciais', () => {
    const config = smtpConfig({ smtp: null });

    expect(() => createSmtpTransport(config)).toThrow(/credenciais completas/);
  });

  it('deve recusar quando falta usuário ou senha', () => {
    const config = smtpConfig({
      smtp: { host: 'smtp.invalid', port: 587, secure: false, user: null, password: 'senha' },
    });

    expect(() => createSmtpTransport(config)).toThrow(/BILL_REMINDER_SMTP_USER/);
  });
});

describe('transporte SMTP — envio', () => {
  it('deve mapear a mensagem para a chamada do cliente de e-mail', async () => {
    const fake = fakeNodemailer();
    const transport = createSmtpTransport(smtpConfig(), {
      moduleLoader: async () => fake.module,
    });

    await transport.send(MESSAGE);

    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]).toEqual({
      from: 'finance@localhost',
      to: RECIPIENT,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
      messageId: MESSAGE.messageId,
    });
  });

  it('deve confirmar a entrega (o ledger pode ser gravado)', () => {
    const transport = createSmtpTransport(smtpConfig(), {
      moduleLoader: async () => fakeNodemailer().module,
    });

    expect(transport.kind).toBe('smtp');
    expect(transport.persists).toBe(true);
  });

  it('deve reutilizar o mesmo cliente de e-mail entre envios', async () => {
    const fake = fakeNodemailer();
    const transport = createSmtpTransport(smtpConfig(), {
      moduleLoader: async () => fake.module,
    });

    await transport.send(MESSAGE);
    await transport.send(MESSAGE);

    expect(fake.options).toHaveLength(1);
    expect(fake.messages).toHaveLength(2);
  });
});

describe('transporte SMTP — TLS (HIGH)', () => {
  it('deve exigir STARTTLS na porta 587 sem TLS implícito', async () => {
    const fake = fakeNodemailer();
    const transport = createSmtpTransport(
      smtpConfig({
        smtp: { host: 'smtp.invalid', port: 587, secure: false, user: 'u', password: 'p' },
      }),
      { moduleLoader: async () => fake.module },
    );

    await transport.send(MESSAGE);

    expect(fake.options[0]).toMatchObject({
      port: 587,
      secure: false,
      requireTLS: true,
      tls: { minVersion: 'TLSv1.2' },
    });
  });

  it('deve usar TLS implícito na porta 465', async () => {
    const fake = fakeNodemailer();
    const transport = createSmtpTransport(
      smtpConfig({
        smtp: { host: 'smtp.invalid', port: 465, secure: false, user: 'u', password: 'p' },
      }),
      { moduleLoader: async () => fake.module },
    );

    await transport.send(MESSAGE);

    expect(fake.options[0]).toMatchObject({
      port: 465,
      secure: true,
      requireTLS: false,
      tls: { minVersion: 'TLSv1.2' },
    });
  });

  it('deve não exigir STARTTLS quando o TLS implícito está ligado', async () => {
    const fake = fakeNodemailer();
    const transport = createSmtpTransport(
      smtpConfig({
        smtp: { host: 'smtp.invalid', port: 587, secure: true, user: 'u', password: 'p' },
      }),
      { moduleLoader: async () => fake.module },
    );

    await transport.send(MESSAGE);

    expect(fake.options[0]).toMatchObject({ secure: true, requireTLS: false });
  });
});

describe('configuração dos lembretes — leitura do ambiente', () => {
  it('deve desabilitar o recurso sem destinatário', () => {
    const config = loadBillReminderConfig({});

    expect(config.enabled).toBe(false);
    expect(config.to).toBeNull();
    expect(config.transport).toBe('dry-run');
  });

  it('deve rejeitar e-mail inválido', () => {
    expect(() => loadBillReminderConfig({ BILL_REMINDER_TO: 'nao-e-email' })).toThrow(
      BillReminderConfigError,
    );
  });

  it('deve rejeitar janela de catch-up inválida', () => {
    expect(() => loadBillReminderConfig({ BILL_REMINDER_CATCH_UP_DAYS: 'abc' })).toThrow(
      BillReminderConfigError,
    );
    expect(() => loadBillReminderConfig({ BILL_REMINDER_CATCH_UP_DAYS: '-1' })).toThrow(
      BillReminderConfigError,
    );
    expect(() => loadBillReminderConfig({ BILL_REMINDER_CATCH_UP_DAYS: '31' })).toThrow(
      BillReminderConfigError,
    );
  });

  it('deve rejeitar intervalo do agendador inválido', () => {
    expect(() => loadBillReminderConfig({ BILL_REMINDER_INTERVAL_MINUTES: 'abc' })).toThrow(
      BillReminderConfigError,
    );
    expect(() => loadBillReminderConfig({ BILL_REMINDER_INTERVAL_MINUTES: '0' })).toThrow(
      BillReminderConfigError,
    );
    expect(() => loadBillReminderConfig({ BILL_REMINDER_INTERVAL_MINUTES: '1441' })).toThrow(
      BillReminderConfigError,
    );
  });

  it('deve usar os valores padrão quando nada é informado', () => {
    const config = loadBillReminderConfig({ BILL_REMINDER_TO: RECIPIENT });

    expect(config.transport).toBe('dry-run');
    expect(config.from).toBe('finance@localhost');
    expect(config.catchUpDays).toBe(3);
    expect(config.intervalMinutes).toBe(30);
    expect(config.smtp).toBeNull();
  });

  it('deve ler o booleano de TLS em todas as formas aceitas', () => {
    const expected: [string, boolean][] = [
      ['true', true],
      ['false', false],
      ['1', true],
      ['0', false],
      ['yes', true],
      ['no', false],
    ];

    for (const [value, result] of expected) {
      const config = loadBillReminderConfig({
        BILL_REMINDER_TO: RECIPIENT,
        BILL_REMINDER_SMTP_HOST: 'smtp.invalid',
        BILL_REMINDER_SMTP_SECURE: value,
      });
      expect(config.smtp?.secure, `valor: ${value}`).toBe(result);
    }
  });

  it('deve rejeitar booleano de TLS inválido', () => {
    expect(() =>
      loadBillReminderConfig({
        BILL_REMINDER_TO: RECIPIENT,
        BILL_REMINDER_SMTP_HOST: 'smtp.invalid',
        BILL_REMINDER_SMTP_SECURE: 'talvez',
      }),
    ).toThrow(BillReminderConfigError);
  });

  it('deve exigir credenciais completas quando o transporte é smtp', () => {
    expect(() =>
      loadBillReminderConfig({
        BILL_REMINDER_TRANSPORT: 'smtp',
        BILL_REMINDER_TO: RECIPIENT,
      }),
    ).toThrow(BillReminderConfigError);
  });

  it('deve montar a configuração do SMTP completa', () => {
    const config = loadBillReminderConfig({
      BILL_REMINDER_TRANSPORT: 'smtp',
      BILL_REMINDER_TO: RECIPIENT,
      BILL_REMINDER_SMTP_HOST: 'smtp.invalid',
      BILL_REMINDER_SMTP_PORT: '2525',
      BILL_REMINDER_SMTP_USER: 'usuario',
      BILL_REMINDER_SMTP_PASSWORD: 'senha',
    });

    expect(config.enabled).toBe(true);
    expect(config.transport).toBe('smtp');
    expect(config.smtp).toEqual({
      host: 'smtp.invalid',
      port: 2525,
      secure: false,
      user: 'usuario',
      password: 'senha',
    });
  });
});

describe('transporte SMTP — classe exposta', () => {
  it('deve implementar a interface de transporte do reminders', () => {
    const transport: SmtpTransport = createSmtpTransport(smtpConfig(), {
      moduleLoader: async () => fakeNodemailer().module,
    });

    expect(typeof transport.send).toBe('function');
    expect(transport.kind).toBe('smtp');
  });
});
