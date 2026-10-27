import { describe, expect, it } from 'vitest';
import {
  classifyNfcePortalStatus,
  formatHostResolverRule,
  isAllowedBrowserRequestProtocol,
  isNfcePortalAccessBlocked,
  NfcePortalAccessBlockedError,
  selectPublicAddress,
  shouldUpgradeHttpRedirect,
} from '../src/services/nfce-browser';
import { isAllowedBrowserRequest, isAllowedLegacyRjHttpRequest } from '../src/services/rj-nfce';
import { isAllowedSpBrowserRequest } from '../src/services/sp-nfce';

describe('detecção de bloqueio de acesso da NFC-e', () => {
  it('reconhece o aviso público da SEFAZ-RJ sem precisar guardar o HTML', () => {
    const pageText = `SECRETARIA DE ESTADO DE FAZENDA DO RIO DE JANEIRO
      O serviço de segurança da informação bloqueia acessos provenientes desses endereços IP.
      É provável que seu endereço IP atual esteja listado em uma dessas bases de dados.`;

    expect(isNfcePortalAccessBlocked('RJ', pageText)).toBe(true);
    expect(new NfcePortalAccessBlockedError()).toMatchObject({ statusCode: 503 });
  });

  it('não classifica uma nota normal ou avisos de outro estado como bloqueio RJ', () => {
    expect(isNfcePortalAccessBlocked('RJ', 'Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica')).toBe(false);
    expect(isNfcePortalAccessBlocked('SP', 'A SEFAZ-RJ bloqueia acessos provenientes desses endereços IP')).toBe(false);
  });
});

describe('resolução segura do DNS para NFC-e', () => {
  it('prefere IPv6 público e mantém fallback IPv4 quando IPv6 não existe', () => {
    expect(selectPublicAddress([
      { address: '9.9.9.9', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ], 'RJ')).toBe('2606:4700:4700::1111');
    expect(selectPublicAddress([{ address: '8.8.8.8', family: 4 }], 'RJ')).toBe('8.8.8.8');
  });

  it('rejeita respostas DNS não públicas mesmo quando há outro endereço público', () => {
    expect(() => selectPublicAddress([
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '127.0.0.1', family: 4 },
    ], 'RJ')).toThrow(/validação de segurança/);
    expect(() => selectPublicAddress([{ address: 'fe80::1', family: 6 }], 'RJ')).toThrow(/validação de segurança/);
    expect(() => selectPublicAddress([{ address: '2001:db8::1', family: 6 }], 'RJ')).toThrow(/validação de segurança/);
  });

  it('formata endereços IPv6 entre colchetes nas regras do Chromium', () => {
    expect(formatHostResolverRule('sefaz.example.gov.br', '2606:4700:4700::1111'))
      .toBe('MAP sefaz.example.gov.br [2606:4700:4700::1111]');
    expect(formatHostResolverRule('sefaz.example.gov.br', '8.8.8.8'))
      .toBe('MAP sefaz.example.gov.br 8.8.8.8');
  });
});

describe('classificação de respostas do portal NFC-e', () => {
  it('mantém redirecionamentos e respostas normais e explica indisponibilidade 5xx sem conteúdo do portal', () => {
    expect(classifyNfcePortalStatus('RJ', 302)).toBeNull();
    expect(classifyNfcePortalStatus('RJ', 200)).toBeNull();
    expect(classifyNfcePortalStatus('RJ', 503)?.message)
      .toBe('A SEFAZ-RJ respondeu com indisponibilidade temporária (HTTP 503). Tente novamente mais tarde.');
  });

  it('atualiza apenas o redirecionamento HTTP do host oficial autorizado', () => {
    const allowed = ['consultadfe.fazenda.rj.gov.br'];
    expect(shouldUpgradeHttpRedirect(new URL('http://consultadfe.fazenda.rj.gov.br/resultado'), allowed)).toBe(true);
    expect(shouldUpgradeHttpRedirect(new URL('http://example.invalid/resultado'), allowed)).toBe(false);
    expect(shouldUpgradeHttpRedirect(new URL('https://consultadfe.fazenda.rj.gov.br/resultado'), allowed)).toBe(false);
  });
});

describe('exceção HTTP do QR Code legado da SEFAZ-RJ', () => {
  const validLegacyUrl = `http://www4.fazenda.rj.gov.br/consultaNFCe/QRCode?p=${'1'.repeat(44)}|2|1|3|${'a'.repeat(40)}`;
  const request = (url: string, method = 'GET', resourceType = 'document') => ({ url, method, resourceType });

  it('aceita em HTTP apenas o QR legado válido como navegação de documento', () => {
    const legacyRequest = request(validLegacyUrl);
    expect(isAllowedLegacyRjHttpRequest(legacyRequest)).toBe(true);
    expect(isAllowedBrowserRequestProtocol(legacyRequest, isAllowedLegacyRjHttpRequest)).toBe(true);
    expect(isAllowedBrowserRequest(legacyRequest)).toBe(true);
  });

  it('bloqueia host, caminho, método, recurso e formato de QR inválidos', () => {
    const invalidRequests = [
      request(validLegacyUrl.replace('www4.fazenda.rj.gov.br', 'example.invalid')),
      request(validLegacyUrl.replace('/consultaNFCe/QRCode', '/outro/caminho')),
      request(validLegacyUrl, 'POST'),
      request(validLegacyUrl, 'GET', 'xhr'),
      request(validLegacyUrl.replace('|2|1|3|', '|3|1|3|')),
    ];
    for (const invalidRequest of invalidRequests) {
      expect(isAllowedLegacyRjHttpRequest(invalidRequest)).toBe(false);
      expect(isAllowedBrowserRequestProtocol(invalidRequest, isAllowedLegacyRjHttpRequest)).toBe(false);
      expect(isAllowedBrowserRequest(invalidRequest)).toBe(false);
    }
  });

  it('bloqueia HTTP por padrão e mantém RJ atual e consultas HTTPS de SP', () => {
    const otherHttp = request('http://example.invalid/consulta');
    expect(isAllowedBrowserRequestProtocol(otherHttp)).toBe(false);
    expect(isAllowedBrowserRequest(otherHttp)).toBe(false);

    const currentRj = request('https://consultadfe.fazenda.rj.gov.br/resultado');
    expect(isAllowedBrowserRequestProtocol(currentRj)).toBe(true);
    expect(isAllowedBrowserRequest(currentRj)).toBe(true);

    const spRequest = request('https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/api', 'GET', 'xhr');
    expect(isAllowedBrowserRequestProtocol(spRequest)).toBe(true);
    expect(isAllowedSpBrowserRequest(spRequest)).toBe(true);
  });
});
