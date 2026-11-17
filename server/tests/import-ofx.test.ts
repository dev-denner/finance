import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/db/client';
import { importWorkbook, isOfx, parseOfx, previewImport } from '../src/services/import';
import { ensureLookup } from '../src/services/lookups';
import { createTestDatabase } from './helpers';

/** OFX 1.x (SGML): cabeçalho em texto, tags de valor sem fechamento, Windows-1252. */
const SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20261117120000[-3:BRT]<LANGUAGE>POR</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STMTRS><CURDEF>BRL
<BANKACCTFROM><BANKID>0341<ACCTID>12345-6<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261101<DTEND>20261117
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20261110120000[-3:BRT]
<TRNAMT>-150.00
<FITID>20261110001
<MEMO>PADARIA PÃO QUENTE
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20261115
<TRNAMT>3200.50
<FITID>20261115002
<NAME>EMPRESA LTDA
<MEMO>SALARIO NOVEMBRO
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>
`;

/** OFX 2.x (XML), cartão de crédito, vírgula decimal e entidades. */
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
<CCACCTFROM><ACCTID>5555</ACCTID></CCACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261103</DTPOSTED><TRNAMT>-1.234,56</TRNAMT><FITID>a1</FITID><MEMO>LOJA A &amp; B</MEMO></STMTTRN>
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

const sgmlBuffer = () => Buffer.from(SGML, 'latin1');

describe('OFX — leitura', () => {
  it('reconhece pela extensão ou pelo conteúdo', () => {
    expect(isOfx(Buffer.from('x'), 'extrato.OFX')).toBe(true);
    expect(isOfx(sgmlBuffer(), 'extrato.txt')).toBe(true);
    expect(isOfx(Buffer.from('Data;Valor'), 'extrato.csv')).toBe(false);
  });

  it('SGML 1.x: tags sem fechamento, fuso no DTPOSTED, acento em Windows-1252, nome e memorando', () => {
    const statement = parseOfx(sgmlBuffer());
    expect(statement).toMatchObject({ kind: 'bank', bankId: '0341', accountId: '12345-6' });
    expect(statement.transactions).toEqual([
      { postedAt: '2026-11-10', amountCents: -15000, description: 'PADARIA PÃO QUENTE', fitId: '20261110001', type: 'DEBIT' },
      { postedAt: '2026-11-15', amountCents: 320050, description: 'EMPRESA LTDA SALARIO NOVEMBRO', fitId: '20261115002', type: 'CREDIT' },
    ]);
  });

  it('XML 2.x de cartão: vírgula decimal, milhar e entidades', () => {
    const statement = parseOfx(Buffer.from(XML, 'utf8'));
    expect(statement).toMatchObject({ kind: 'credit_card', accountId: '5555' });
    expect(statement.transactions[0]).toMatchObject({ postedAt: '2026-11-03', amountCents: -123456, description: 'LOJA A & B' });
  });

  it('recusa arquivo sem <OFX>, lançamento sem valor e extrato vazio', () => {
    expect(() => parseOfx(Buffer.from('OFXHEADER:100\nnada'))).toThrow(/OFX válido/);
    expect(() => parseOfx(Buffer.from('<OFX><STMTTRN><DTPOSTED>20261101</STMTTRN></OFX>'))).toThrow(/sem data ou valor/);
    const db = createTestDatabase();
    expect(() => previewImport(db.db, Buffer.from('<OFX><BANKTRANLIST></BANKTRANLIST></OFX>'), 'vazio.ofx')).toThrow(/não possui lançamentos/);
    db.sqlite.close();
  });
});

describe('OFX — importação', () => {
  let handle: DatabaseHandle;
  beforeEach(() => {
    handle = createTestDatabase();
  });
  afterEach(() => handle.sqlite.close());

  it('a prévia reconhece as colunas sozinha e importa na conta escolhida; reimportar acusa duplicidade', () => {
    const account = ensureLookup(handle.db, 'payment', 'Itaú Conta');
    const preview = previewImport(handle.db, sgmlBuffer(), 'extrato.ofx', undefined, undefined, undefined, undefined, {
      destinationPaymentMethodId: account.id,
    });
    expect(preview.mappingErrors).toEqual([]);
    expect(preview.sheetName).toBe('OFX · conta 12345-6');
    expect(preview.rows.map((row) => [row.rowNumber, row.values.description, row.values.amountCents, row.values.dueDate])).toEqual([
      [2, 'PADARIA PÃO QUENTE', -15000, '2026-11-10'],
      [3, 'EMPRESA LTDA SALARIO NOVEMBRO', 320050, '2026-11-15'],
    ]);

    const summary = importWorkbook(handle.db, sgmlBuffer(), 'extrato.ofx', {
      mapping: preview.mapping,
      destinationPaymentMethodId: account.id,
      skipDuplicates: true,
    });
    expect(summary).toMatchObject({ importedRows: 2, invalidRows: 0 });
    const rows = handle.sqlite
      .prepare('SELECT description, amount_cents AS a, payment_method_id AS p FROM transactions ORDER BY due_date')
      .all();
    expect(rows).toEqual([
      { description: 'PADARIA PÃO QUENTE', a: -15000, p: account.id },
      { description: 'EMPRESA LTDA SALARIO NOVEMBRO', a: 320050, p: account.id },
    ]);

    const again = importWorkbook(handle.db, sgmlBuffer(), 'extrato.ofx', {
      mapping: preview.mapping,
      destinationPaymentMethodId: account.id,
      skipDuplicates: true,
    });
    expect(again.importedRows).toBe(0);
  });
});
