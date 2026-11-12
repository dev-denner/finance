import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  extractSpNfceSnapshotFromDocument,
  isAllowedSpBrowserRequest,
  isAllowedSpFinalUrl,
  parseSpNfceSnapshot,
  validateSpQrUrl,
} from '../src/services/sp-nfce';

function syntheticAccessKey(): string {
  const payload = `35${'2601'}${'00000000000000'}65${'001'}${'000000001'}1${'00000001'}`;
  let weight = 2;
  let sum = 0;
  for (let index = payload.length - 1; index >= 0; index -= 1) {
    sum += Number(payload[index]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  return `${payload}${remainder < 2 ? 0 : 11 - remainder}`;
}

function qrUrl(path = '/qrcode', key = syntheticAccessKey(), hash = 'a'.repeat(40)): string {
  return `https://www.nfce.fazenda.sp.gov.br${path}?p=${key}|2|1|1|${hash}`;
}

const syntheticHtml = (
  key = syntheticAccessKey(),
  options: { payment?: boolean; discount?: boolean; itemDiscount?: boolean; integerUnitPrice?: boolean; grossTotal?: string; payable?: string } = {},
) => `
  <div class="txtCenter">
    <span class="txtTopo">Fornecedor Sintético LTDA</span>
    <span class="text">CNPJ: 00000000000000</span>
  </div>
  <section>
    <h4 class="ui-collapsible-heading">Informações gerais da Nota</h4>
    <div class="ui-collapsible-content">Número: 42 Série: 3 Emissão: 02/03/2026 10:20:30-03:00</div>
  </section>
  <section>
    <h4 class="ui-collapsible-heading">Chave de acesso</h4>
    <div class="ui-collapsible-content">${key.replace(/(\d{4})(?=\d)/g, '$1 ')}</div>
  </section>
  <table id="tabResult"><tbody>
    <tr><td><span class="txtTit">Item Sintético A (Código: A-01)</span><span class="Rqtd">Qtde.: 2</span><span class="RUN">UN: UN</span><span class="RvlUnit">Vl. Unit.: R$ ${options.integerUnitPrice ? '10' : '10,00'}</span>${options.itemDiscount ? '<span class="RvlDesc">Vl. Desc.: R$ 3,00</span>' : ''}</td><td><span class="valor">R$ 20,00</span></td></tr>
    <tr><td><span class="txtTit">Item Sintético B (Código: B-02)</span><span class="Rqtd">Qtde.: 1</span><span class="RUN">UN: UN</span><span class="RvlUnit">Vl. Unit.: R$ ${options.integerUnitPrice ? '10' : '10,00'}</span></td><td><span class="valor">R$ 10,00</span></td></tr>
  </tbody></table>
  <div id="totalNota">
    <div id="linhaTotal"><span>Valor total</span><span class="totalNumb">${options.grossTotal ?? 'R$ 30,00'}</span></div>
    ${options.discount ? '<div id="linhaTotal"><span>Desconto</span><span class="totalNumb">R$ 5,00</span></div>' : ''}
    <div id="linhaTotal"><span>Valor a pagar</span><span class="totalNumb">${options.payable ?? (options.discount ? 'R$ 25,00' : 'R$ 30,00')}</span></div>
  </div>
  ${options.payment ? '<div id="linhaForma">Forma de pagamento</div><div><span class="txtTit">Pix</span><span>Valor pago R$ 30,00</span></div>' : ''}
`;

describe('adaptador NFC-e de SP', () => {
  it('aceita QR online v2 no caminho público e no caminho de consulta observado', () => {
    expect(validateSpQrUrl(qrUrl()).pathname).toBe('/qrcode');
    expect(validateSpQrUrl(qrUrl('/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx')).pathname)
      .toBe('/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx');
  });

  it('rejeita hosts, esquema, caminhos, parâmetros e chaves malformados', () => {
    const valid = qrUrl();
    const key = syntheticAccessKey();
    for (const candidate of [
      valid.replace('https:', 'http:'),
      valid.replace('www.nfce.fazenda.sp.gov.br', 'nfce.fazenda.sp.gov.br'),
      valid.replace('/qrcode?', '/other?'),
      valid.replace('|2|1|1|', '|3|1|1|'),
      valid.replace('|2|1|1|', '|2|3|1|'),
      valid.replace('|2|1|1|', '|2|1|0|'),
      valid.replace('|2|1|1|', '|2|1|1234567|'),
      valid.replace('a'.repeat(40), 'g'.repeat(40)),
      valid.replace(`${key}|2|1|1|`, `${key.slice(0, 43)}${key[43] === '0' ? '1' : '0'}|2|1|1|`),
      `${valid}&extra=1`,
    ]) expect(() => validateSpQrUrl(candidate)).toThrow();
  });

  it('permite redirecionamento HTTPS do mesmo host para o caminho de consulta e bloqueia destinos externos', () => {
    expect(isAllowedSpBrowserRequest({
      url: qrUrl('/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx'),
      method: 'GET',
      resourceType: 'document',
    })).toBe(true);
    expect(isAllowedSpFinalUrl(new URL(qrUrl('/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx')))).toBe(true);
    expect(isAllowedSpBrowserRequest({
      url: qrUrl().replace('www.nfce.fazenda.sp.gov.br', 'evil.example'),
      method: 'GET',
      resourceType: 'document',
    })).toBe(false);
    expect(isAllowedSpFinalUrl(new URL('https://evil.example/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx')))
      .toBe(false);
    expect(isAllowedSpBrowserRequest({
      url: 'https://www.nfce.fazenda.sp.gov.br/unlisted',
      method: 'GET',
      resourceType: 'document',
    })).toBe(false);
  });

  it('extrai duas células por item do DOM e normaliza campos, descontos e pagamento disponíveis', () => {
    const dom = new JSDOM(syntheticHtml(syntheticAccessKey(), { payment: true, discount: true }));
    const snapshot = extractSpNfceSnapshotFromDocument(dom.window.document);
    const purchase = parseSpNfceSnapshot(snapshot);

    expect(purchase).toMatchObject({
      supplierName: 'Fornecedor Sintético LTDA',
      supplierCnpj: '00000000000000',
      invoiceNumber: '42',
      series: '3',
      issuedAt: '2026-03-02T10:20:30-03:00',
      totalCents: 2500,
      invoiceDiscountCents: 500,
      paymentMethod: 'Pix',
    });
    expect(purchase.items).toEqual([
      { description: 'Item Sintético A', quantity: '2', unit: 'UN', unitPriceCents: 1000, discountCents: null, totalCents: 2000 },
      { description: 'Item Sintético B', quantity: '1', unit: 'UN', unitPriceCents: 1000, discountCents: null, totalCents: 1000 },
    ]);
    expect(JSON.stringify(purchase)).not.toMatch(/consumerCpf|card|authorization|html/i);
    dom.window.close();
  });

  it('executa o extrator serializado no contexto DOM, sem dependências externas', () => {
    const dom = new JSDOM(syntheticHtml(syntheticAccessKey(), { payment: true, discount: true }), {
      runScripts: 'outside-only',
    });
    const serializedExtractor = `(() => { const __name = (fn) => fn; return (${extractSpNfceSnapshotFromDocument.toString()})(document); })()`;
    const snapshot = dom.window.eval(serializedExtractor);
    const purchase = parseSpNfceSnapshot(snapshot);

    expect(purchase.items).toHaveLength(2);
    expect(purchase.totalCents).toBe(2500);
    expect(purchase.paymentMethod).toBe('Pix');
    dom.window.close();
  });

  it('deriva preço unitário exato quando o portal SP omite centavos no campo unitário', () => {
    const dom = new JSDOM(syntheticHtml(syntheticAccessKey(), { integerUnitPrice: true }));
    const purchase = parseSpNfceSnapshot(extractSpNfceSnapshotFromDocument(dom.window.document));
    expect(purchase.items.map((item) => item.unitPriceCents)).toEqual([1000, 1000]);
    expect(purchase.items.map((item) => item.totalCents)).toEqual([2000, 1000]);
    dom.window.close();
  });

  it('preserva campos opcionais ausentes sem inventar pagamento nem desconto de item', () => {
    const dom = new JSDOM(syntheticHtml());
    const purchase = parseSpNfceSnapshot(extractSpNfceSnapshotFromDocument(dom.window.document));
    expect(purchase.paymentMethod).toBeNull();
    expect(purchase.invoiceDiscountCents).toBe(0);
    expect(purchase.items.every((item) => item.discountCents === null)).toBe(true);
    dom.window.close();
  });

  it('lê desconto de item quando o portal o apresenta', () => {
    const dom = new JSDOM(syntheticHtml(syntheticAccessKey(), { itemDiscount: true }));
    const purchase = parseSpNfceSnapshot(extractSpNfceSnapshotFromDocument(dom.window.document));
    expect(purchase.items[0]?.discountCents).toBe(300);
    dom.window.close();
  });

  it('guarda somente a categoria da forma de pagamento sem sufixos identificáveis', () => {
    const dom = new JSDOM(syntheticHtml(syntheticAccessKey(), { payment: true }));
    const snapshot = extractSpNfceSnapshotFromDocument(dom.window.document);
    snapshot.paymentMethod = 'Cartão de Crédito final 1234';
    expect(parseSpNfceSnapshot(snapshot).paymentMethod).toBe('Cartão de Crédito');
    dom.window.close();
  });

  it('rejeita divergência entre os totais dos itens e o valor bruto da nota', () => {
    const dom = new JSDOM(syntheticHtml(syntheticAccessKey(), { grossTotal: 'R$ 31,00' }));
    expect(() => parseSpNfceSnapshot(extractSpNfceSnapshotFromDocument(dom.window.document)))
      .toThrow(/itens, descontos e total a pagar/i);
    dom.window.close();
  });
});
