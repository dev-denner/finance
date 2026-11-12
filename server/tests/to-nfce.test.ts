import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { isAllowedToBrowserRequest, isAllowedToFinalUrl, parseToNfceXml, validateToQrUrl } from '../src/services/to-nfce';

function key(): string {
  const base = `17${'2601'}${'00000000000000'}65${'001'}${'000000042'}1${'00000001'}`;
  let sum = 0; let weight = 2;
  for (let i = base.length - 1; i >= 0; i -= 1) { sum += Number(base[i]) * weight; weight = weight === 9 ? 2 : weight + 1; }
  const check = sum % 11;
  return `${base}${check < 2 ? 0 : 11 - check}`;
}

function alternateKey(): string {
  const base = key().slice(0, 43).replace("000000042", "000000043");
  let sum = 0; let weight = 2;
  for (let i = base.length - 1; i >= 0; i -= 1) { sum += Number(base[i]) * weight; weight = weight === 9 ? 2 : weight + 1; }
  const check = sum % 11;
  return base + String(check < 2 ? 0 : 11 - check);
}

const qr = () => `http://www.sefaz.to.gov.br/nfce/qrcode?p=${key()}|2|1|2|${'a'.repeat(40)}`;
const xml = () => `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe${key()}"><ide><mod>65</mod><serie>1</serie><nNF>42</nNF><dhEmi>2026-01-02T10:20:30-03:00</dhEmi></ide><emit><CNPJ>00000000000000</CNPJ><xNome>Fornecedor Sintético</xNome></emit><det><prod><xProd>Item Sintético A</xProd><qCom>2.0000</qCom><uCom>UN</uCom><vUnCom>10.000000</vUnCom><vProd>20.00</vProd><vDesc>1.00</vDesc></prod></det><det><prod><xProd>Item Sintético B</xProd><qCom>1.0000</qCom><uCom>UN</uCom><vUnCom>10.000000</vUnCom><vProd>10.00</vProd></prod></det><total><ICMSTot><vProd>30.00</vProd><vDesc>2.00</vDesc><vNF>28.00</vNF></ICMSTot></total><pag><detPag><tPag>17</tPag></detPag></pag></infNFe></NFe><protNFe><infProt><chNFe>${key()}</chNFe></infProt></protNFe></nfeProc>`;

describe('adaptador NFC-e TO', () => {
  it('canonicaliza URL oficial para HTTPS e rejeita destinos/QR inválidos', () => {
    expect(validateToQrUrl(qr()).protocol).toBe('https:');
    expect(() => validateToQrUrl(qr().replace('www.sefaz.to.gov.br', 'evil.example'))).toThrow();
    expect(() => validateToQrUrl(qr().replace('|2|1|2|', '|3|1|2|'))).toThrow();
  });
  it('permite apenas requests HTTPS oficiais da consulta', () => {
    expect(isAllowedToBrowserRequest({ url: 'https://www.sefaz.to.gov.br/nfce/api/nfe', method: 'POST', resourceType: 'fetch' })).toBe(true);
    expect(isAllowedToBrowserRequest({ url: 'http://www.sefaz.to.gov.br/nfce', method: 'GET', resourceType: 'document' })).toBe(false);
    expect(isAllowedToBrowserRequest({ url: 'https://evil.example/nfce', method: 'GET', resourceType: 'document' })).toBe(false);
    expect(isAllowedToFinalUrl(new URL('https://www.sefaz.to.gov.br/nfce'))).toBe(true);
  });
  it('extrai campos e itens de XML sintético sem reter o documento', () => {
    const document = xml();
    const result = parseToNfceXml(document, new JSDOM('').window.DOMParser, key());
    expect(result.error).toBeUndefined();
    expect(result.purchase).toMatchObject({ supplierName: 'Fornecedor Sintético', totalCents: 2800, paymentMethod: 'Pix', items: [{ description: 'Item Sintético A', discountCents: 100 }, { description: 'Item Sintético B' }] });
    expect(JSON.stringify(result)).not.toContain(document);
    const mismatched = document.replace("<chNFe>" + key() + "</chNFe>", "<chNFe>" + alternateKey() + "</chNFe>");
    expect(parseToNfceXml(mismatched, new JSDOM("").window.DOMParser, key()).error).toBe("invoice-mismatch");
    expect(parseToNfceXml(document.replace("<mod>65</mod>", "<mod>55</mod>"), new JSDOM("").window.DOMParser, key()).error).toBe("invoice-mismatch");
  });
  it('rejeita divergência da soma e entidades XML', () => {
    expect(parseToNfceXml(xml().replace('<vProd>30.00</vProd>', '<vProd>31.00</vProd>'), new JSDOM('').window.DOMParser, key()).error).toBe('total-mismatch');
    expect(parseToNfceXml('<!DOCTYPE x [<!ENTITY e "x">]><x/>', new JSDOM('').window.DOMParser, key()).error).toBe('xml-invalid');
  });
});
