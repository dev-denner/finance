import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { HttpError } from '../src/lib/errors';
import { NfcePortalAccessBlockedError } from '../src/services/nfce-browser';
import { NfceQueryGuardError } from '../src/services/nfce-query-guard';
import {
  importNfceBatch,
  inspectNfceBatch,
  MAX_BATCH_FILE_BYTES,
  previewNfceBatch,
  type NfceBatchDeps,
} from '../src/services/nfce-batch';
import { getPurchase, importPurchase } from '../src/services/purchases';
import type { PurchaseInput } from '../src/services/rj-nfce';
import { createTestDatabase, csvBuffer } from './helpers';

/** Chave sintética de 44 dígitos; nunca representa uma NFC-e real. */
function key(n: number): string {
  return `${'9'.repeat(40)}${String(n).padStart(4, '0')}`;
}

function urlFor(n: number): string {
  return `https://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode?p=${key(n)}%7C3%7C1`;
}

function currentV2UrlFor(n: number): string {
  return `https://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode?p=${key(n)}%7C2%7C1%7C3%7C${'a'.repeat(40)}`;
}

function legacyUrlFor(n: number): string {
  return `http://www4.fazenda.rj.gov.br/consultaNFCe/QRCode?p=${key(n)}%7C2%7C1%7C3%7C${'a'.repeat(40)}`;
}

function spAccessKey(): string {
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

function spUrl(): string {
  return `https://www.nfce.fazenda.sp.gov.br/qrcode?p=${spAccessKey()}|2|1|1|${'b'.repeat(40)}`;
}

function purchaseFor(n: number): PurchaseInput {
  return {
    accessKey: key(n),
    supplierName: `Mercado Sintético ${n}`,
    supplierCnpj: '12345678000195',
    invoiceNumber: String(1000 + n),
    series: '1',
    issuedAt: '2026-03-02T10:20:30-03:00',
    totalCents: 3000,
    invoiceDiscountCents: 0,
    paymentMethod: 'Pix',
    items: [
      {
        description: `Produto sintético ${n}`,
        quantity: '1',
        unit: 'UN',
        unitPriceCents: 3000,
        discountCents: null,
        totalCents: 3000,
      },
    ],
  };
}

function urlNumber(url: string): number {
  const payload = new URL(url).searchParams.get('p') ?? '';
  return Number(payload.slice(40, 44));
}

function depsFor(
  handler: (n: number) => PurchaseInput | Promise<PurchaseInput>,
): { deps: NfceBatchDeps; preview: ReturnType<typeof vi.fn> } {
  const preview = vi.fn(async (url: string) => handler(urlNumber(url)));
  return { deps: { preview }, preview };
}

function expectNoSensitivePayload(payload: unknown): void {
  const text = JSON.stringify(payload);
  expect(text).not.toContain('consultadfe');
  expect(text).not.toContain('www4.fazenda.rj.gov.br');
  expect(text).not.toContain('p=');
  expect(text).not.toContain(key(1));
}

describe('inspeção do arquivo de NFC-e em lote', () => {
  it('detecta cabeçalho, sugere a coluna das URLs e conta linhas vazias/longas', () => {
    const buffer = csvBuffer(`url;observacao\n${urlFor(1)};ok\n\n${'x'.repeat(2050)}\n`);
    const inspection = inspectNfceBatch(buffer, 'notas.csv');

    expect(inspection.headers).toEqual(['url', 'observacao']);
    expect(inspection.columns).toHaveLength(2);
    expect(inspection.columns[0]).toMatchObject({ index: 0, label: 'url', validCount: 1, totalCount: 1 });
    expect(inspection.columns[1]).toMatchObject({ index: 1, label: 'observacao', validCount: 0 });
    expect(inspection.suggestedColumn).toBe(0);
    expect(inspection.dataLines).toBe(3);
    expect(inspection.blankLines).toBe(1);
    expect(inspection.tooLongLines).toBe(1);
  });

  it('aceita arquivo sem cabeçalho com uma URL por linha', () => {
    const inspection = inspectNfceBatch(csvBuffer(`${urlFor(1)}\n${urlFor(2)}\n`), 'notas.txt');

    expect(inspection.headers).toBeNull();
    expect(inspection.columns).toHaveLength(1);
    expect(inspection.columns[0]).toMatchObject({ label: 'Coluna A', validCount: 2, totalCount: 2 });
    expect(inspection.suggestedColumn).toBe(0);
    expect(inspection.dataLines).toBe(2);
  });

  it('reconhece versão 2 no domínio atual e não confunde repetição com URL inválida', async () => {
    const handle = createTestDatabase();
    const repeatedUrl = currentV2UrlFor(8);
    const buffer = csvBuffer(`${repeatedUrl}\n${repeatedUrl}\n`);
    const { deps, preview } = depsFor((n) => purchaseFor(n));
    try {
      const inspection = inspectNfceBatch(buffer, 'notas.csv');
      expect(inspection.columns[0]).toMatchObject({ validCount: 2, totalCount: 2 });

      const previewResult = await previewNfceBatch(handle.db, buffer, 'notas.csv', {}, deps);
      expect(previewResult.rows.map((row) => row.status)).toEqual(['valid', 'duplicate-file']);
      expect(preview).toHaveBeenCalledTimes(1);

      const imported = await importNfceBatch(
        handle.db,
        buffer,
        'notas.csv',
        { lines: [1, 2] },
        deps,
      );
      expect(imported.rows.map((row) => row.status)).toEqual(['imported', 'duplicate']);
      expect(imported.summary).toEqual({ total: 2, imported: 1, duplicate: 1, error: 0, notQueried: 0 });
      expect(preview).toHaveBeenCalledTimes(2);
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM purchases').get()).toMatchObject({ count: 1 });
      expectNoSensitivePayload(previewResult);
      expectNoSensitivePayload(imported);
    } finally {
      handle.sqlite.close();
    }
  });

  it('classifica SP no lote e deduplica pela chave entre prévia e importação', async () => {
    const handle = createTestDatabase();
    const url = spUrl();
    const purchase = { ...purchaseFor(21), accessKey: spAccessKey() };
    const preview = vi.fn(async () => purchase);
    const deps: NfceBatchDeps = { preview };
    const buffer = csvBuffer(`${url}\n${url}\n`);
    try {
      const previewResult = await previewNfceBatch(handle.db, buffer, 'notas.csv', {}, deps);
      expect(previewResult.rows.map((row) => row.status)).toEqual(['valid', 'duplicate-file']);
      expect(previewResult.rows.map((row) => row.state)).toEqual(['SP', 'SP']);
      expect(preview).toHaveBeenCalledTimes(1);

      const imported = await importNfceBatch(handle.db, buffer, 'notas.csv', { lines: [1, 2] }, deps);
      expect(imported.rows.map((row) => row.status)).toEqual(['imported', 'duplicate']);
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM purchases').get()).toMatchObject({ count: 1 });
      expectNoSensitivePayload(previewResult);
      expectNoSensitivePayload(imported);
    } finally {
      handle.sqlite.close();
    }
  });

  it('não trata uma URL oficial como cabeçalho', () => {
    const inspection = inspectNfceBatch(csvBuffer(`${urlFor(1)};${legacyUrlFor(2)}\n`), 'notas.csv');

    expect(inspection.headers).toBeNull();
    expect(inspection.columns).toHaveLength(2);
  });
});

describe('prévia do lote de NFC-e', () => {
  it('não descarta nenhuma linha e classifica válida, vazia, duplicada e inválida', async () => {
    const handle = createTestDatabase();
    const { deps, preview } = depsFor((n) => purchaseFor(n));
    try {
      const previewResult = await previewNfceBatch(
        handle.db,
        csvBuffer(
          `${urlFor(1)}\n\n${urlFor(1)}\nnao-e-url\n${urlFor(9)}\nhttps://exemplo.invalido/consultaNFCe/QRCode?p=${key(3)}%7C3%7C1\n`,
        ),
        'notas.csv',
        {},
        deps,
      );

      expect(previewResult.rows.map((row) => row.line)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(previewResult.rows.map((row) => row.status)).toEqual([
        'valid',
        'blank',
        'duplicate-file',
        'invalid',
        'valid',
        'invalid',
      ]);
      expect(previewResult.rows[2]?.message).toContain('linha 1');
      expect(previewResult.rows[0]).toMatchObject({
        supplierName: 'Mercado Sintético 1',
        invoiceNumber: '1001',
        itemCount: 1,
        totalCents: 3000,
      });
      expect(previewResult.rows[3]?.message).not.toContain('http');
      expect(previewResult.summary).toEqual({
        total: 6,
        valid: 2,
        invalid: 2,
        blank: 1,
        duplicateFile: 1,
        alreadyImported: 0,
        error: 0,
        notQueried: 0,
      });
      // Só as duas URLs oficiais inéditas são consultadas, em série.
      // O host não permitido da linha 6 nunca abre o navegador.
      expect(preview).toHaveBeenCalledTimes(2);
      expectNoSensitivePayload(previewResult);
    } finally {
      handle.sqlite.close();
    }
  });

  it('respeita a coluna escolhida, a célula vazia e rejeita coluna fora do arquivo', async () => {
    const handle = createTestDatabase();
    const { deps } = depsFor((n) => purchaseFor(n));
    const buffer = csvBuffer(`obs;link\nsem-url;${urlFor(3)}\nvazio;\n`);
    try {
      const wrong = await previewNfceBatch(handle.db, buffer, 'notas.csv', { column: 0 }, deps);
      expect(wrong.rows[0]?.status).toBe('invalid');

      const right = await previewNfceBatch(handle.db, buffer, 'notas.csv', { column: 1 }, deps);
      expect(right.rows[0]).toMatchObject({ status: 'valid', supplierName: 'Mercado Sintético 3' });
      expect(right.rows[1]).toMatchObject({ status: 'invalid' });
      expect(right.rows[1]?.message).toContain('coluna escolhida está vazia');

      await expect(
        previewNfceBatch(handle.db, buffer, 'notas.csv', { column: 9 }, deps),
      ).rejects.toThrow(/Coluna de URL inválida/);

      const imported = await importNfceBatch(
        handle.db,
        buffer,
        'notas.csv',
        { column: 1, lines: [2] },
        deps,
      );
      expect(imported.rows[0]).toMatchObject({ status: 'imported' });
      expect(imported.rows[0]?.purchaseId).toBeGreaterThan(0);
    } finally {
      handle.sqlite.close();
    }
  });

  it('não consulta a SEFAZ quando a nota já existe no banco', async () => {
    const handle = createTestDatabase();
    const { deps, preview } = depsFor((n) => purchaseFor(n));
    try {
      importPurchase(handle.db, purchaseFor(7));

      const result = await previewNfceBatch(
        handle.db,
        csvBuffer(`${urlFor(7)}\n${legacyUrlFor(7)}\n`),
        'notas.csv',
        {},
        deps,
      );

      expect(result.rows[0]?.status).toBe('already-imported');
      expect(result.rows[1]?.status).toBe('duplicate-file');
      expect(result.summary.alreadyImported).toBe(1);
      expect(preview).not.toHaveBeenCalled();
      expectNoSensitivePayload(result);
    } finally {
      handle.sqlite.close();
    }
  });

  it('revalida antes de consultar durante importação em lote', async () => {
    const handle = createTestDatabase();
    const { deps, preview } = depsFor((n) => purchaseFor(n));
    try {
      const existing = importPurchase(handle.db, purchaseFor(19));
      const result = await importNfceBatch(
        handle.db,
        csvBuffer(urlFor(19)),
        'notas.csv',
        { lines: [1] },
        deps,
      );
      expect(result.rows).toEqual([{
        line: 1,
        status: 'duplicate',
        message: 'Esta NFC-e já existe nas compras.',
        purchaseId: existing.id,
      }]);
      expect(preview).not.toHaveBeenCalled();
    } finally {
      handle.sqlite.close();
    }
  });

  it('uma falha na consulta não impede as demais notas', async () => {
    const handle = createTestDatabase();
    const { deps } = depsFor((n) => {
      if (n === 2) throw new HttpError(502, 'Não foi possível carregar os itens da NFC-e.');
      return purchaseFor(n);
    });
    try {
      const result = await previewNfceBatch(
        handle.db,
        csvBuffer(`${urlFor(1)}\n${urlFor(2)}\n${urlFor(3)}\n`),
        'notas.csv',
        {},
        deps,
      );

      expect(result.rows.map((row) => row.status)).toEqual(['valid', 'error', 'valid']);
      expect(result.rows[1]?.message).toBe('Não foi possível carregar os itens da NFC-e.');
      expect(result.summary).toMatchObject({ valid: 2, error: 1 });
      expectNoSensitivePayload(result);
    } finally {
      handle.sqlite.close();
    }
  });

  it('interrompe consultas restantes quando a SEFAZ informa bloqueio de acesso', async () => {
    const handle = createTestDatabase();
    const { deps, preview } = depsFor((n) => {
      if (n === 1) throw new NfcePortalAccessBlockedError();
      return purchaseFor(n);
    });
    try {
      const result = await previewNfceBatch(
        handle.db,
        csvBuffer(`${urlFor(1)}\n${urlFor(2)}\n${urlFor(3)}\n`),
        'notas.csv',
        {},
        deps,
      );

      expect(preview).toHaveBeenCalledTimes(1);
      expect(result.rows.map((row) => row.status)).toEqual(['error', 'not-queried', 'not-queried']);
      expect(result.rows[0]?.message).toContain('bloqueou a consulta');
      expect(result.rows[1]?.message).toContain('Não consultada');
      expect(result.rows[2]?.message).toContain('Não consultada');
      expectNoSensitivePayload(result);
    } finally {
      handle.sqlite.close();
    }
  });

  it('interrompe as consultas restantes do lote ao atingir um limite local', async () => {
    const handle = createTestDatabase();
    const preview = vi.fn(async () => { throw new NfceQueryGuardError('Limite local de consultas atingido.'); });
    const deps: NfceBatchDeps = { preview };
    try {
      const buffer = csvBuffer(`${urlFor(31)}\n${urlFor(32)}\n${urlFor(33)}\n`);
      const previewResult = await previewNfceBatch(handle.db, buffer, 'notas.csv', {}, deps);
      expect(previewResult.rows.map((row) => row.status)).toEqual(['error', 'not-queried', 'not-queried']);
      expect(previewResult.rows[0]?.message).toContain('Limite local');
      expect(previewResult.rows[1]?.message).toContain('Não consultada');
      expect(preview).toHaveBeenCalledTimes(1);

      preview.mockClear();
      const importResult = await importNfceBatch(
        handle.db,
        buffer,
        'notas.csv',
        { lines: [1, 2, 3] },
        deps,
      );
      expect(importResult.rows.map((row) => row.status)).toEqual(['error', 'not-queried', 'not-queried']);
      expect(importResult.rows[2]?.message).toContain('Não consultada');
      expect(preview).toHaveBeenCalledTimes(1);
    } finally {
      handle.sqlite.close();
    }
  });

  it('recusa nota cuja chave retornada pela SEFAZ não confere com a URL do QR Code', async () => {
    const handle = createTestDatabase();
    // O dublê responde com uma chave diferente da que consta na URL.
    const { deps } = depsFor((n) => purchaseFor(n + 100));
    try {
      const previewed = await previewNfceBatch(
        handle.db,
        csvBuffer(urlFor(11)),
        'notas.csv',
        {},
        deps,
      );
      expect(previewed.rows[0]?.status).toBe('error');
      expect(previewed.rows[0]?.message).toContain('não confere com a URL do QR Code');

      const imported = await importNfceBatch(
        handle.db,
        csvBuffer(urlFor(11)),
        'notas.csv',
        { lines: [1] },
        deps,
      );
      expect(imported.rows[0]?.status).toBe('error');
      expect(imported.rows[0]?.message).toContain('não confere com a URL do QR Code');
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM purchases').get()).toMatchObject({
        count: 0,
      });
    } finally {
      handle.sqlite.close();
    }
  });

  it('aplica os limites de linhas, consultas, bytes, tipo e tamanho de linha', async () => {
    const handle = createTestDatabase();
    const { deps, preview } = depsFor((n) => purchaseFor(n));
    try {
      const tooManyLines = Array.from({ length: 201 }, (_, index) => urlFor(index + 1)).join('\n');
      await expect(
        previewNfceBatch(handle.db, csvBuffer(tooManyLines), 'notas.csv', {}, deps),
      ).rejects.toThrow(/mais de 200 linhas/);

      const tooManyQueries = Array.from({ length: 51 }, (_, index) => urlFor(index + 1)).join('\n');
      await expect(
        previewNfceBatch(handle.db, csvBuffer(tooManyQueries), 'notas.csv', {}, deps),
      ).rejects.toThrow(/limite por lote é 50/);
      expect(preview).not.toHaveBeenCalled();

      const bigFile = Buffer.alloc(MAX_BATCH_FILE_BYTES + 1, 'a');
      await expect(
        previewNfceBatch(handle.db, bigFile, 'notas.csv', {}, deps),
      ).rejects.toThrow(/no máximo 1 MB/);

      await expect(
        previewNfceBatch(handle.db, csvBuffer(urlFor(1)), 'notas.xlsx', {}, deps),
      ).rejects.toThrow(/CSV ou TXT/);

      await expect(
        previewNfceBatch(handle.db, Buffer.from(`x\0y`, 'utf8'), 'notas.csv', {}, deps),
      ).rejects.toThrow(/não parece ser um CSV ou TXT de texto/);

      const longLine = 'x'.repeat(2050);
      const withLongLine = await previewNfceBatch(
        handle.db,
        csvBuffer(`${urlFor(1)}\n${longLine}\n`),
        'notas.csv',
        {},
        deps,
      );
      expect(withLongLine.rows[1]).toMatchObject({ status: 'invalid' });
      expect(withLongLine.rows[1]?.message).toContain('excede 2048 caracteres');
    } finally {
      handle.sqlite.close();
    }
  });
});

describe('importação do lote de NFC-e', () => {
  it('grava apenas as linhas escolhidas, deduplica e não cria movimentações', async () => {
    const handle = createTestDatabase();
    const { deps, preview } = depsFor((n) => purchaseFor(n));
    const buffer = csvBuffer(`${urlFor(1)}\n${urlFor(2)}\n${urlFor(3)}\n`);
    try {
      const seeded = importPurchase(handle.db, purchaseFor(2));

      const first = await importNfceBatch(handle.db, buffer, 'notas.csv', { lines: [1, 2, 3] }, deps);
      expect(first.rows.map((row) => row.status)).toEqual(['imported', 'duplicate', 'imported']);
      expect(first.rows[1]?.purchaseId).toBe(seeded.id);
      expect(first.rows[0]?.purchaseId).toBeGreaterThan(0);
      expect(first.summary).toEqual({ total: 3, imported: 2, duplicate: 1, error: 0, notQueried: 0 });
      expect(preview).toHaveBeenCalledTimes(2);
      expect(getPurchase(handle.db, first.rows[0]?.purchaseId as number).items).toHaveLength(1);

      const second = await importNfceBatch(handle.db, buffer, 'notas.csv', { lines: [1, 2, 3] }, deps);
      expect(second.rows.map((row) => row.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
      expect(preview).toHaveBeenCalledTimes(2);

      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM purchases').get()).toMatchObject({
        count: 3,
      });
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM transactions').get()).toMatchObject({
        count: 0,
      });
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM import_batches').get()).toMatchObject({
        count: 0,
      });
      expectNoSensitivePayload(first);
    } finally {
      handle.sqlite.close();
    }
  });

  it('deduplica no mesmo lote quando a nota aparece com formatos de URL diferentes', async () => {
    const handle = createTestDatabase();
    const { deps, preview } = depsFor((n) => purchaseFor(n));
    try {
      const result = await importNfceBatch(
        handle.db,
        csvBuffer(`${urlFor(4)}\n${legacyUrlFor(4)}\n`),
        'notas.csv',
        { lines: [1, 2] },
        deps,
      );

      expect(result.rows.map((row) => row.status)).toEqual(['imported', 'duplicate']);
      expect(preview).toHaveBeenCalledTimes(1);
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM purchases').get()).toMatchObject({
        count: 1,
      });
      expectNoSensitivePayload(result);
    } finally {
      handle.sqlite.close();
    }
  });

  it('continua após uma falha de consulta e reporta a linha com erro', async () => {
    const handle = createTestDatabase();
    const { deps } = depsFor((n) => {
      if (n === 2) throw new HttpError(502, 'Não foi possível carregar os itens da NFC-e.');
      return purchaseFor(n);
    });
    try {
      const result = await importNfceBatch(
        handle.db,
        csvBuffer(`${urlFor(1)}\n${urlFor(2)}\n${urlFor(3)}\n`),
        'notas.txt',
        { lines: [1, 2, 3] },
        deps,
      );

      expect(result.rows.map((row) => row.status)).toEqual(['imported', 'error', 'imported']);
      expect(result.rows[1]?.message).toBe('Não foi possível carregar os itens da NFC-e.');
      expect(result.summary).toEqual({ total: 3, imported: 2, duplicate: 0, error: 1, notQueried: 0 });
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM purchases').get()).toMatchObject({
        count: 2,
      });
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM transactions').get()).toMatchObject({
        count: 0,
      });
    } finally {
      handle.sqlite.close();
    }
  });

  it('interrompe a importação do lote no primeiro bloqueio sem consultar nem gravar as linhas restantes', async () => {
    const handle = createTestDatabase();
    const { deps, preview } = depsFor((n) => {
      if (n === 1) throw new NfcePortalAccessBlockedError();
      return purchaseFor(n);
    });
    try {
      const result = await importNfceBatch(
        handle.db,
        csvBuffer(`${urlFor(1)}\n${urlFor(2)}\n${urlFor(3)}\n`),
        'notas.csv',
        { lines: [1, 2, 3] },
        deps,
      );

      expect(preview).toHaveBeenCalledTimes(1);
      expect(result.rows.map((row) => row.status)).toEqual(['error', 'not-queried', 'not-queried']);
      expect(result.rows[0]?.message).toContain('bloqueou a consulta');
      expect(result.rows[1]?.message).toContain('Não consultada');
      expect(result.rows[2]?.message).toContain('Não consultada');
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM purchases').get()).toMatchObject({ count: 0 });
      expectNoSensitivePayload(result);
    } finally {
      handle.sqlite.close();
    }
  });

  it('recusa linhas vazias, inválidas ou inexistentes sem consultar a SEFAZ', async () => {
    const handle = createTestDatabase();
    const { deps, preview } = depsFor((n) => purchaseFor(n));
    try {
      const result = await importNfceBatch(
        handle.db,
        csvBuffer(`nao-e-url\n\n${urlFor(5)}\n`),
        'notas.csv',
        { lines: [1, 2, 9] },
        deps,
      );

      expect(result.rows.map((row) => row.status)).toEqual(['error', 'error', 'error']);
      expect(result.rows[2]?.message).toContain('não encontrada');
      expect(preview).not.toHaveBeenCalled();
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM purchases').get()).toMatchObject({
        count: 0,
      });
    } finally {
      handle.sqlite.close();
    }
  });

  it('exige uma seleção de linhas válida e dentro do limite', async () => {
    const handle = createTestDatabase();
    const { deps } = depsFor((n) => purchaseFor(n));
    const buffer = csvBuffer(urlFor(1));
    try {
      await expect(
        importNfceBatch(handle.db, buffer, 'notas.csv', { lines: [] }, deps),
      ).rejects.toThrow(/ao menos uma linha/);
      await expect(
        importNfceBatch(
          handle.db,
          buffer,
          'notas.csv',
          { lines: Array.from({ length: 51 }, (_, index) => index + 1) },
          deps,
        ),
      ).rejects.toThrow(/no máximo 50 linhas/);
    } finally {
      handle.sqlite.close();
    }
  });
});

describe('rotas do lote de NFC-e (ponta a ponta, sem rede)', () => {
  function multipart(parts: { name: string; value: string; filename?: string }[]): {
    payload: string;
    headers: Record<string, string>;
  } {
    const boundary = 'nfcebatchboundary';
    const body = parts
      .map((part) => {
        const disposition = part.filename
          ? `form-data; name="${part.name}"; filename="${part.filename}"`
          : `form-data; name="${part.name}"`;
        const contentType = part.filename ? 'Content-Type: text/csv\r\n' : '';
        return `--${boundary}\r\nContent-Disposition: ${disposition}\r\n${contentType}\r\n${part.value}\r\n`;
      })
      .join('');
    return {
      payload: `${body}--${boundary}--\r\n`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  }

  it('inspeciona, prevê e importa pelo multipart sem revelar a URL', async () => {
    const handle = createTestDatabase();
    const app = await buildApp({ db: handle.db, logger: false });
    try {
      const seeded = importPurchase(handle.db, purchaseFor(1));
      const content = `url;observacao\n${urlFor(1)};ok\n`;

      const inspectForm = multipart([
        { name: 'file', value: content, filename: 'notas.csv' },
      ]);
      const inspect = await app.inject({
        method: 'POST',
        url: '/api/purchases/batch/inspect',
        payload: inspectForm.payload,
        headers: inspectForm.headers,
      });
      expect(inspect.statusCode).toBe(200);
      expect(inspect.json().inspection.headers).toEqual(['url', 'observacao']);
      expect(inspect.json().inspection.suggestedColumn).toBe(0);
      expect(JSON.stringify(inspect.json())).not.toContain('p=');

      const previewForm = multipart([
        { name: 'file', value: content, filename: 'notas.csv' },
        { name: 'column', value: '0' },
      ]);
      const preview = await app.inject({
        method: 'POST',
        url: '/api/purchases/batch/preview',
        payload: previewForm.payload,
        headers: previewForm.headers,
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().rows[0].status).toBe('already-imported');

      const importForm = multipart([
        { name: 'file', value: content, filename: 'notas.csv' },
        { name: 'column', value: '0' },
        { name: 'lines', value: '[2]' },
      ]);
      const imported = await app.inject({
        method: 'POST',
        url: '/api/purchases/batch/import',
        payload: importForm.payload,
        headers: importForm.headers,
      });
      expect(imported.statusCode).toBe(200);
      expect(imported.json().summary).toEqual({ total: 1, imported: 0, duplicate: 1, error: 0, notQueried: 0 });
      expect(imported.json().rows[0].purchaseId).toBe(seeded.id);

      const badColumn = multipart([
        { name: 'file', value: content, filename: 'notas.csv' },
        { name: 'column', value: '9' },
      ]);
      const bad = await app.inject({
        method: 'POST',
        url: '/api/purchases/batch/preview',
        payload: badColumn.payload,
        headers: badColumn.headers,
      });
      expect(bad.statusCode).toBe(400);

      const tooManyLines = multipart([
        {
          name: 'file',
          value: Array.from({ length: 201 }, (_, index) => urlFor(index + 1)).join('\n'),
          filename: 'grande.csv',
        },
      ]);
      const limited = await app.inject({
        method: 'POST',
        url: '/api/purchases/batch/inspect',
        payload: tooManyLines.payload,
        headers: tooManyLines.headers,
      });
      expect(limited.statusCode).toBe(400);
      expect(limited.json().error).toContain('mais de 200 linhas');

      const oversized = multipart([
        { name: 'file', value: 'a'.repeat(MAX_BATCH_FILE_BYTES + 1), filename: 'grande.csv' },
      ]);
      const tooLarge = await app.inject({
        method: 'POST',
        url: '/api/purchases/batch/inspect',
        payload: oversized.payload,
        headers: oversized.headers,
      });
      expect(tooLarge.statusCode).toBe(400);
      expect(tooLarge.json().error).toContain('no máximo 1 MB');

      const noFileForm = multipart([]);
      const noFile = await app.inject({
        method: 'POST',
        url: '/api/purchases/batch/inspect',
        payload: noFileForm.payload,
        headers: noFileForm.headers,
      });
      expect(noFile.statusCode).toBe(400);
    } finally {
      await app.close();
      handle.sqlite.close();
    }
  });
});
