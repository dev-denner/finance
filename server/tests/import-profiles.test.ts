import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/db/client';
import { cleanInterDescription, cleanNubankDescription, detectCsvProfile, importWorkbook, parseOfx, previewImport } from '../src/services/import';
import { ensureLookup } from '../src/services/lookups';
import { createTestDatabase } from './helpers';

// Dados fictícios no formato do extrato da conta Nubank (nomes, documentos e contas inventados).
const NUBANK_CSV = [
  'Data,Valor,Identificador,Descrição',
  '01/09/2026,-100.00,aaaa-0001,Transferência enviada pelo Pix - Fulano de Tal - •••.111.222-•• - BANCO EXEMPLO (0999) Agência: 1 Conta: 12345-6',
  '01/09/2026,1500.00,aaaa-0002,Transferência recebida pelo Pix - EMPRESA FICTICIA LTDA - 11.222.333/0001-44 - BANCO INTER (0077) Agência: 1 Conta: 999-1',
  '04/09/2026,-2793.84,aaaa-0003,Pagamento de boleto efetuado - PLANO DE SAUDE EXEMPLO S A',
  '09/09/2026,-958.91,aaaa-0004,Pagamento de fatura',
  '18/09/2026,-24.97,aaaa-0005,Compra no débito - LOJINHA EXEMPLO',
].join('\n');

const NUBANK_OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
ENCODING:UTF-8
CHARSET:NONE
<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE></STATUS><FI><ORG>NU PAGAMENTOS S.A.</ORG><FID>260</FID></FI></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF>
<BANKACCTFROM><BANKID>0260</BANKID><BRANCHID>1</BRANCHID><ACCTID>1234567-8</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261005000000[-3:BRT]</DTPOSTED><TRNAMT>-250.00</TRNAMT><FITID>bbbb-1</FITID><MEMO>Transferência enviada pelo Pix - 12.345.678 Maria Exemplo - 12.345.678/0001-90 - NU PAGAMENTOS - IP (0260) Agência: 1 Conta: 1-1</MEMO></STMTTRN>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261005000000[-3:BRT]</DTPOSTED><TRNAMT>704.83</TRNAMT><FITID>bbbb-2</FITID><MEMO>Resgate RDB</MEMO></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

describe('perfil Nubank — descrições', () => {
  it('Pix fica só com o favorecido; boleto e débito com o estabelecimento; o resto não muda', () => {
    expect(cleanNubankDescription('Transferência enviada pelo Pix - Fulano de Tal - •••.111.222-•• - BANCO EXEMPLO (0999) Agência: 1 Conta: 12345-6')).toBe('Pix enviado - Fulano de Tal');
    expect(cleanNubankDescription('Transferência recebida pelo Pix - EMPRESA FICTICIA LTDA - 11.222.333/0001-44 - BANCO INTER (0077) Agência: 1 Conta: 999-1')).toBe('Pix recebido - EMPRESA FICTICIA LTDA');
    // MEI com a raiz do CNPJ antes do nome, nome com hífen e asteriscos.
    expect(cleanNubankDescription('Transferência enviada pelo Pix - 12.345.678 Maria Exemplo - 12.345.678/0001-90 - NU PAGAMENTOS - IP (0260) Agência: 1 Conta: 1-1')).toBe('Pix enviado - Maria Exemplo');
    expect(cleanNubankDescription('Transferência enviada pelo Pix - Padaria - Filial Centro - 11.222.333/0001-44 - BANCO (0001) Agência: 1 Conta: 2')).toBe('Pix enviado - Padaria - Filial Centro');
    expect(cleanNubankDescription('Transferência enviada pelo Pix - * GAS EXEMPLO * - 11.222.333/0001-44 - BANCO (0237) Agência: 1 Conta: 2')).toBe('Pix enviado - GAS EXEMPLO');
    expect(cleanNubankDescription('Transferência enviada pelo Pix - Loja Online - BANCO PAGO Agência: 1 Conta: 1256-4')).toBe('Pix enviado - Loja Online');
    expect(cleanNubankDescription('Pagamento de boleto efetuado - PLANO DE SAUDE EXEMPLO S A')).toBe('Boleto - PLANO DE SAUDE EXEMPLO S A');
    expect(cleanNubankDescription('Compra no débito - LOJINHA EXEMPLO')).toBe('Débito - LOJINHA EXEMPLO');
    for (const text of ['Pagamento de fatura', 'Resgate RDB', 'Débito em conta', 'Crédito em conta']) {
      expect(cleanNubankDescription(text)).toBe(text);
    }
  });

  it('reconhece o CSV pelo cabeçalho exato (acento e caixa não importam)', () => {
    expect(detectCsvProfile(['Data', 'Valor', 'Identificador', 'Descrição'])?.profile.id).toBe('nubank-checking');
    expect(detectCsvProfile(['DATA', 'VALOR', 'IDENTIFICADOR', 'DESCRICAO'])?.profile.id).toBe('nubank-checking');
    expect(detectCsvProfile(['Data', 'Valor', 'Descrição'])).toBeNull();
  });

  it('OFX do Nubank traz a instituição e resume as descrições', () => {
    expect(parseOfx(Buffer.from(NUBANK_OFX, 'utf8'))).toMatchObject({ org: 'NU PAGAMENTOS S.A.', fid: '260', bankId: '0260' });
  });
});

describe('perfil Nubank — importação', () => {
  let handle: DatabaseHandle;
  beforeEach(() => {
    handle = createTestDatabase();
  });
  afterEach(() => handle.sqlite.close());

  it('CSV: mapeamento do perfil sem avisos de coluna genérica, valor com ponto e descrição resumida', () => {
    const preview = previewImport(handle.db, Buffer.from(NUBANK_CSV, 'utf8'), 'NU_extrato.csv');
    expect(preview.profile).toEqual({ id: 'nubank-checking', label: 'Nubank · conta corrente', accountKind: 'checking' });
    expect(preview.mapping).toMatchObject({ dueDate: 0, description: 3, amount: 1, purchaseDate: null });
    expect(preview.mappingWarnings).toEqual([expect.objectContaining({ level: 'info', message: expect.stringContaining('Nubank · conta corrente') })]);
    // A tela refaz a prévia com o mapeamento escolhido: o aviso do formato continua.
    const again = previewImport(handle.db, Buffer.from(NUBANK_CSV, 'utf8'), 'NU_extrato.csv', preview.mapping);
    expect(again.mappingWarnings).toEqual([expect.objectContaining({ message: expect.stringContaining('Nubank · conta corrente') })]);
    expect(preview.rows.map((row) => [row.values.description, row.values.amountCents, row.values.dueDate])).toEqual([
      ['Pix enviado - Fulano de Tal', -10000, '2026-09-01'],
      ['Pix recebido - EMPRESA FICTICIA LTDA', 150000, '2026-09-01'],
      ['Boleto - PLANO DE SAUDE EXEMPLO S A', -279384, '2026-09-04'],
      ['Pagamento de fatura', -95891, '2026-09-09'],
      ['Débito - LOJINHA EXEMPLO', -2497, '2026-09-18'],
    ]);
  });

  it('importar sem mapeamento explícito usa o perfil; OFX do Nubank também resume', () => {
    const account = ensureLookup(handle.db, 'payment', 'Nubank Conta');
    const summary = importWorkbook(handle.db, Buffer.from(NUBANK_CSV, 'utf8'), 'NU_extrato.csv', { destinationPaymentMethodId: account.id });
    expect(summary).toMatchObject({ importedRows: 5, invalidRows: 0 });

    const ofx = previewImport(handle.db, Buffer.from(NUBANK_OFX, 'utf8'), 'NU_extrato.ofx');
    expect(ofx.profile?.id).toBe('nubank-checking');
    expect(ofx.rows.map((row) => row.values.description)).toEqual(['Pix enviado - Maria Exemplo', 'Resgate RDB']);
  });

  it('modelo de mapeamento salvo para o mesmo cabeçalho tem prioridade sobre o perfil', async () => {
    const { saveMappingTemplate } = await import('../src/services/import');
    saveMappingTemplate(handle.db, {
      name: 'Meu Nubank',
      headers: ['Data', 'Valor', 'Identificador', 'Descrição'],
      mapping: { purchaseDate: 0, dueDate: 0, description: 3, amount: 1 },
    });
    const preview = previewImport(handle.db, Buffer.from(NUBANK_CSV, 'utf8'), 'NU_extrato.csv');
    expect(preview.appliedTemplate?.name).toBe('Meu Nubank');
    expect(preview.mapping.purchaseDate).toBe(0);
  });
});

// Dados fictícios no formato do extrato do Inter: preâmbulo, depois o cabeçalho, valores no formato brasileiro.
const INTER_CSV = [
  ' Extrato Conta Corrente ',
  'Conta ;123456789',
  'Período ;01/10/2026 a 31/10/2026',
  'Saldo ;593,95',
  '',
  'Data Lançamento;Histórico;Descrição;Valor;Saldo',
  '12/10/2026;Pix enviado ;Fulano de Tal;-262,33;590,32',
  '05/10/2026;Pix recebido;Empresa Exemplo Ltda;2.618,00;1.741,85',
  '05/10/2026;Pagamento efetuado;PLANO EXEMPLO S A;-2.793,84;-876,15',
  '',
].join('\n');

const INTER_OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
ENCODING:USASCII
CHARSET:1252

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE></STATUS><FI><ORG>Banco Intermedium S/A</ORG><FID>077</FID></FI></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF>
<BANKACCTFROM><BANKID>077</BANKID><ACCTID>123456789</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>PAYMENT</TRNTYPE><DTPOSTED>20261012</DTPOSTED><TRNAMT>-262.33</TRNAMT><FITID>202610120771</FITID><MEMO>Pix enviado: "Cp :11111111-Fulano de Tal"</MEMO><NAME>Fulano de Tal</NAME></STMTTRN>
<STMTTRN><TRNTYPE>PAYMENT</TRNTYPE><DTPOSTED>20261005</DTPOSTED><TRNAMT>-2793.84</TRNAMT><FITID>202610050775</FITID><MEMO>Pagamento efetuado: "PLANO EXEMPLO S A"</MEMO><NAME>PLANO EXEMPLO S A</NAME></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

describe('perfil Inter', () => {
  let handle: DatabaseHandle;
  beforeEach(() => {
    handle = createTestDatabase();
  });
  afterEach(() => handle.sqlite.close());

  it('descrições do OFX e do CSV no mesmo padrão', () => {
    expect(cleanInterDescription('Pix enviado: "Cp :11111111-Fulano de Tal"')).toBe('Pix enviado - Fulano de Tal');
    expect(cleanInterDescription('Pix recebido - Empresa Exemplo Ltda')).toBe('Pix recebido - Empresa Exemplo Ltda');
    expect(cleanInterDescription('Pagamento efetuado: "PLANO EXEMPLO S A"')).toBe('Pagamento - PLANO EXEMPLO S A');
    expect(cleanInterDescription('Pagamento efetuado - PLANO EXEMPLO S A')).toBe('Pagamento - PLANO EXEMPLO S A');
    expect(cleanInterDescription('Tarifa mensal')).toBe('Tarifa mensal');
  });

  it('CSV: acha o cabeçalho depois do preâmbulo, junta Histórico e Descrição e lê o valor brasileiro', () => {
    const preview = previewImport(handle.db, Buffer.from(INTER_CSV, 'utf8'), 'Extrato-CSV.csv');
    expect(preview.profile?.id).toBe('inter-checking');
    expect(preview.headers).toEqual(['Data Lançamento', 'Histórico', 'Descrição', 'Valor', 'Saldo']);
    expect(preview.mappingErrors).toEqual([]);
    expect(preview.rows.map((row) => [row.values.description, row.values.amountCents, row.values.dueDate])).toEqual([
      ['Pix enviado - Fulano de Tal', -26233, '2026-10-12'],
      ['Pix recebido - Empresa Exemplo Ltda', 261800, '2026-10-05'],
      ['Pagamento - PLANO EXEMPLO S A', -279384, '2026-10-05'],
    ]);
  });

  it('OFX do Inter (Windows-1252, ORG Intermedium) resume no mesmo padrão', () => {
    expect(parseOfx(Buffer.from(INTER_OFX, 'latin1'))).toMatchObject({ org: 'Banco Intermedium S/A', fid: '077', bankId: '077' });
    const preview = previewImport(handle.db, Buffer.from(INTER_OFX, 'latin1'), 'Extrato-OFX.ofx');
    expect(preview.profile?.id).toBe('inter-checking');
    expect(preview.rows.map((row) => row.values.description)).toEqual(['Pix enviado - Fulano de Tal', 'Pagamento - PLANO EXEMPLO S A']);
  });

  it('o delimitador vem da primeira linha que tem um (o título solto não confunde)', () => {
    const csv = ['Relatório', 'Data;Compra;Valor', '01/10/2026;Padaria, centro;-10,50'].join('\n');
    const preview = previewImport(handle.db, Buffer.from(csv, 'utf8'), 'r.csv');
    expect(preview.rows[0].values).toMatchObject({ description: 'Padaria, centro', amountCents: -1050 });
  });
});
