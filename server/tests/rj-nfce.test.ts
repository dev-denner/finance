import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { extractRjNfceSnapshotFromDocument, parseRjNfceSnapshot, rjNfceSnapshotExpression } from '../src/services/rj-nfce';

const ACCESS_KEY = '33260312345678000195650010000123451000123456';

/** Retrato fixo e sintético da página de consulta do portal do RJ. */
const RJ_PAGE = `<!doctype html><html><body>
  <div class="txtCenter">
    <div class="txtTopo">MERCADO EXEMPLO LTDA</div>
    <div class="text">CNPJ: 12.345.678/0001-95</div>
    <div class="text">Rua Sintética, 100, Centro, Rio de Janeiro, RJ</div>
  </div>
  <table id="tabResult">
    <tr id="Item + 1">
      <td><span class="txtTit">ARROZ TIPO 1 5KG</span><span class="RCod">(Código: 7890001)</span><br>
        <span class="Rqtd"><strong>Qtde.:</strong>2</span><span class="RUN"><strong>UN: </strong>UN</span>
        <span class="RvlUnit"><strong>Vl. Unit.:</strong> 10,00</span></td>
      <td class="txtTit noWrap">Vl. Total<br><span class="valor">20,00</span></td>
    </tr>
    <tr id="Item + 2">
      <td><span class="txtTit">SABONETE NEUTRO</span><br>
        <span class="Rqtd"><strong>Qtde.:</strong>1,5</span><span class="RUN"><strong>UN: </strong>KG</span>
        <span class="RvlUnit"><strong>Vl. Unit.:</strong> 6,67</span>
        <span class="RvlDesc"><strong>Desconto:</strong> 0,00</span></td>
      <td class="txtTit noWrap">Vl. Total<br><span class="valor">10,00</span></td>
    </tr>
  </table>
  <div id="totalNota">
    <div id="linhaTotal"><label>Qtd. total de itens:</label><span class="totalNumb">2</span></div>
    <div id="linhaTotal"><label>Valor total R$:</label><span class="totalNumb">30,00</span></div>
    <div id="linhaTotal"><label>Descontos R$:</label><span class="totalNumb">5,00</span></div>
    <div id="linhaTotal" class="linhaShade"><label>Valor a pagar R$:</label><span class="totalNumb txtMax">25,00</span></div>
    <div id="linhaForma"><label>Forma de pagamento:</label><span class="totalNumb txtTitR">Valor pago R$:</span></div>
    <div id="linhaTotal"><label class="tx">Cartão de Crédito</label><span class="totalNumb">25,00</span></div>
  </div>
  <div data-role="collapsible">
    <h4 class="ui-collapsible-heading">Informações gerais da Nota<span class="ui-collapsible-heading-status"> click to expand contents</span></h4>
    <div class="ui-collapsible-content">EMISSÃO NORMAL Número: 12345 Série: 1 Emissão: 02/03/2026 10:20:30-03:00 Via Consumidor Protocolo de Autorização: 333260000000001</div>
  </div>
  <div data-role="collapsible">
    <h4 class="ui-collapsible-heading">Chave de acesso<span class="ui-collapsible-heading-status"> click to collapse contents</span></h4>
    <div class="ui-collapsible-content"><span class="chave">${ACCESS_KEY.replace(/(\d{4})/g, '$1 ').trim()}</span></div>
  </div>
</body></html>`;

describe('NFC-e do RJ — extração do DOM do portal (R6)', () => {
  it('extrai fornecedor, itens, totais, pagamento e painéis do retrato fixo', () => {
    const snapshot = extractRjNfceSnapshotFromDocument(new JSDOM(RJ_PAGE).window.document);
    expect(snapshot).toMatchObject({
      supplierName: 'MERCADO EXEMPLO LTDA',
      supplierCnpjText: 'CNPJ: 12.345.678/0001-95',
      grossTotalText: '30,00',
      discountText: '5,00',
      totalText: '25,00',
      paymentMethod: 'Cartão de Crédito',
    });
    expect(snapshot.generalInfo).toContain('Número: 12345 Série: 1');
    expect(snapshot.paymentRows).toEqual([{ label: 'Cartão de Crédito', amountText: '25,00' }]);
    expect(snapshot.accessKeyText.replace(/\D/g, '')).toBe(ACCESS_KEY);
    expect(snapshot.items).toEqual([
      { description: 'ARROZ TIPO 1 5KG', codeText: '(Código: 7890001)', quantityText: 'Qtde.:2', unitText: 'UN: UN', unitPriceText: 'Vl. Unit.: 10,00', discountText: null, totalText: '20,00' },
      { description: 'SABONETE NEUTRO', codeText: '', quantityText: 'Qtde.:1,5', unitText: 'UN: KG', unitPriceText: 'Vl. Unit.: 6,67', discountText: 'Desconto: 0,00', totalText: '10,00' },
    ]);
  });

  it('o retrato extraído vira a compra esperada', () => {
    const purchase = parseRjNfceSnapshot(extractRjNfceSnapshotFromDocument(new JSDOM(RJ_PAGE).window.document));
    expect(purchase).toMatchObject({
      accessKey: ACCESS_KEY,
      supplierName: 'MERCADO EXEMPLO LTDA',
      supplierCnpj: '12345678000195',
      invoiceNumber: '12345',
      series: '1',
      issuedAt: '2026-03-02T10:20:30-03:00',
      totalCents: 2500,
      invoiceDiscountCents: 500,
      paymentMethod: 'Cartão de Crédito',
    });
    expect(purchase.items).toEqual([
      { description: 'ARROZ TIPO 1 5KG', quantity: '2', unit: 'UN', unitPriceCents: 1000, discountCents: null, totalCents: 2000, code: '7890001' },
      { description: 'SABONETE NEUTRO', quantity: '1.5', unit: 'KG', unitPriceCents: 667, discountCents: 0, totalCents: 1000, code: null },
    ]);
    expect(purchase.payments).toEqual([{ method: 'Cartão de crédito', amountCents: 2500 }]);
  });

  it('a expressão serializada para o Chromium roda sem depender do módulo', () => {
    const { document } = new JSDOM(RJ_PAGE).window;
    const fromExpression = vm.runInNewContext(rjNfceSnapshotExpression(), { document });
    expect(JSON.parse(JSON.stringify(fromExpression))).toEqual(extractRjNfceSnapshotFromDocument(document));
  });

  it('mais de 300 itens interrompe a extração', () => {
    const rows = '<tr><td><span class="txtTit">X</span></td><td><span class="valor">1,00</span></td></tr>'.repeat(301);
    const page = RJ_PAGE.replace(/<table id="tabResult">[\s\S]*?<\/table>/, `<table id="tabResult">${rows}</table>`);
    expect(() => extractRjNfceSnapshotFromDocument(new JSDOM(page).window.document)).toThrow('item-limit');
  });
});
