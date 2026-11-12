import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { isNfcePortalQueryEnabled } from '../src/services/nfce-portal-config';
import { createTestDatabase } from './helpers';

describe('consulta automática aos portais da SEFAZ (R2)', () => {
  it('fica desligada por padrão e só liga com NFCE_PORTAL_QUERY_ENABLED=true', () => {
    expect(isNfcePortalQueryEnabled({})).toBe(false);
    expect(isNfcePortalQueryEnabled({ NFCE_PORTAL_QUERY_ENABLED: '' })).toBe(false);
    expect(isNfcePortalQueryEnabled({ NFCE_PORTAL_QUERY_ENABLED: '1' })).toBe(false);
    expect(isNfcePortalQueryEnabled({ NFCE_PORTAL_QUERY_ENABLED: 'true' })).toBe(true);
    expect(isNfcePortalQueryEnabled({ NFCE_PORTAL_QUERY_ENABLED: ' TRUE ' })).toBe(true);
  });

  it('desligada: QR Code e lote respondem 403 sem consultar; PDF e texto seguem disponíveis; meta informa', async () => {
    const handle = createTestDatabase();
    const app = await buildApp({ db: handle.db, logger: false, nfcePortalQueryEnabled: false });
    try {
      const preview = await app.inject({
        method: 'POST',
        url: '/api/purchases/preview',
        payload: { url: 'https://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode?p=1' },
      });
      expect(preview.statusCode).toBe(403);
      expect(preview.json().error).toMatch(/desligada/);

      for (const route of ['inspect', 'preview', 'import']) {
        const response = await app.inject({ method: 'POST', url: `/api/purchases/batch/${route}` });
        expect(response.statusCode).toBe(403);
      }

      const copied = await app.inject({ method: 'POST', url: '/api/purchases/copied-text/preview', payload: { text: 'sem nota' } });
      expect(copied.statusCode).not.toBe(403);

      expect((await app.inject({ method: 'GET', url: '/api/meta' })).json().features).toEqual({ nfcePortalQuery: false });
    } finally {
      await app.close();
      handle.sqlite.close();
    }
  });

  it('ligada: meta informa o canal disponível', async () => {
    const handle = createTestDatabase();
    const app = await buildApp({ db: handle.db, logger: false, nfcePortalQueryEnabled: true });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/meta' })).json().features).toEqual({ nfcePortalQuery: true });
    } finally {
      await app.close();
      handle.sqlite.close();
    }
  });
});
