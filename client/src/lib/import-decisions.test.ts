import { describe, expect, it } from 'vitest';
import {
  buildCategoryDecisions,
  buildImportIdentity,
  canAutoAcceptSuggestion,
  importIdentityKey,
  isMappingIdentityCompatible,
  isReviewableCategoryGroup,
  previewIdentityKey,
  resolveIncludedDuplicateRows,
} from './import-decisions';
import type { CategorySuggestionGroup, ColumnMapping } from './types';

function group(overrides: Partial<CategorySuggestionGroup> = {}): CategorySuggestionGroup {
  return {
    sourceCategory: 'Mercado',
    sourceNormalized: 'mercado',
    count: 1,
    targetCategoryId: 10,
    targetCategoryName: 'Supermercado',
    confidence: 'high',
    reason: 'nome igual',
    method: 'exact',
    ambiguous: false,
    alternatives: [],
    ...overrides,
  };
}

describe('import-decisions', () => {
  it('só aceita automaticamente sugestão com alvo, sem ambiguidade e confiança suficiente', () => {
    expect(canAutoAcceptSuggestion(group())).toBe(true);
    expect(canAutoAcceptSuggestion(group({ targetCategoryId: null }))).toBe(false);
    expect(canAutoAcceptSuggestion(group({ ambiguous: true }))).toBe(false);
    expect(canAutoAcceptSuggestion(group({ confidence: 'low' }))).toBe(false);
    expect(canAutoAcceptSuggestion(group({ confidence: 'medium' }))).toBe(true);
  });

  it('mantém grupos exatos e sem categoria de origem fora da revisão', () => {
    expect(isReviewableCategoryGroup(group())).toBe(false);
    expect(isReviewableCategoryGroup(group({ sourceCategory: 'Mercadinho', method: 'text_similarity' }))).toBe(true);
    expect(isReviewableCategoryGroup(group({ sourceCategory: '  ', method: 'none' }))).toBe(false);
  });

  it('sugestão automática não confirma alias permanente', () => {
    const decisions = buildCategoryDecisions([group({ method: 'text_similarity' })], {});
    expect(decisions.mercado).toEqual({
      action: 'accept',
      sourceCategory: 'Mercado',
      targetCategoryId: 10,
      confirmed: false,
    });
  });

  it('escolha explícita confirma alias e vale para toda a origem', () => {
    const decisions = buildCategoryDecisions([group({ method: 'text_similarity' })], {
      mercado: { action: 'use', targetCategoryId: 42 },
    });
    expect(decisions.mercado).toMatchObject({
      action: 'use',
      targetCategoryId: 42,
      sourceCategory: 'Mercado',
      confirmed: true,
    });
  });

  it('grupo ambíguo vira criação de categoria e nunca é auto-aceito', () => {
    const decisions = buildCategoryDecisions(
      [
        group({
          ambiguous: true,
          confidence: 'low',
          sourceCategory: 'Casa & Cia',
          sourceNormalized: 'casa_cia',
        }),
      ],
      {},
    );
    expect(decisions.casa_cia).toMatchObject({
      action: 'create',
      confirmed: false,
    });
    expect(decisions.casa_cia.targetCategoryId).toBeUndefined();
  });

  it('descarta decisão obsoleta quando o mapeamento deixa de produzir o grupo', () => {
    const decisions = buildCategoryDecisions([group()], {
      categoria_que_sumiu: { action: 'use', targetCategoryId: 99 },
    });
    expect(decisions.categoria_que_sumiu).toBeUndefined();
    expect(decisions.mercado).toBeDefined();
  });

  it('preserva criação explícita de categoria sem inventar categoria de destino', () => {
    const decisions = buildCategoryDecisions([group({ sourceNormalized: 'nova', sourceCategory: 'Nova' })], {
      nova: { action: 'create' },
    });
    expect(decisions.nova).toMatchObject({ action: 'create', confirmed: true });
    expect(decisions.nova.targetCategoryId).toBeUndefined();
  });

  it('preserva o nome escolhido para a categoria nova', () => {
    const decisions = buildCategoryDecisions([group({ sourceNormalized: 'nova', sourceCategory: 'Nova' })], {
      nova: { action: 'create', newCategoryName: 'Supermercado' },
    });
    expect(decisions.nova.newCategoryName).toBe('Supermercado');
  });
});

describe('import-decisions - identidade', () => {
  it('a identidade reúne conta de destino e decisões de categoria', () => {
    const identity = buildImportIdentity([group()], {}, 7);
    expect(identity.destinationPaymentMethodId).toBe(7);
    expect(identity.categoryDecisions.mercado.action).toBe('accept');
  });

  it('a chave da identidade é estável e independe da ordem das chaves', () => {
    const groups = [
      group(),
      group({ sourceNormalized: 'outro', sourceCategory: 'Outro', targetCategoryId: 11 }),
    ];
    const a = importIdentityKey(buildImportIdentity(groups, {}, 3));
    const b = importIdentityKey(buildImportIdentity([...groups].reverse(), {}, 3));
    expect(a).toBe(b);
  });

  it('a chave da identidade muda quando a conta ou a decisão muda', () => {
    const groups = [group()];
    const base = importIdentityKey(buildImportIdentity(groups, {}, 3));
    expect(importIdentityKey(buildImportIdentity(groups, {}, 4))).not.toBe(base);
    expect(
      importIdentityKey(
        buildImportIdentity(groups, { mercado: { action: 'use', targetCategoryId: 42 } }, 3),
      ),
    ).not.toBe(base);
  });

  it('decisões incompatíveis com o mapeamento são detectadas', () => {
    const anterior: ColumnMapping = { paymentMethod: 5, category: 2, description: 1 };
    expect(isMappingIdentityCompatible(anterior, { ...anterior })).toBe(true);
    expect(isMappingIdentityCompatible(anterior, { ...anterior, paymentMethod: 6 })).toBe(false);
    expect(isMappingIdentityCompatible(anterior, { ...anterior, category: 3 })).toBe(false);
    // Colunas que não definem a identidade podem mudar sem invalidar nada.
    expect(isMappingIdentityCompatible(anterior, { ...anterior, description: 9 })).toBe(true);
  });
});

describe('import-decisions - duplicatas intencionais', () => {
  const rows = [
    { rowNumber: 2, duplicate: { kind: 'exact' } as const },
    { rowNumber: 3, duplicate: { kind: 'probable' } as const },
    { rowNumber: 4, duplicate: null },
  ];

  it('com "pular duplicatas" ligado, só entra o que o usuário liberou', () => {
    expect(resolveIncludedDuplicateRows(rows, { skipDuplicates: true, duplicateIncludes: [] })).toEqual([]);
    expect(
      resolveIncludedDuplicateRows(rows, { skipDuplicates: true, duplicateIncludes: [2] }),
    ).toEqual([2]);
  });

  it('com "pular duplicatas" desligado, todas as duplicatas exatas são intencionais', () => {
    expect(
      resolveIncludedDuplicateRows(rows, { skipDuplicates: false, duplicateIncludes: [] }),
    ).toEqual([2]);
  });

  it('duplicata provável nunca entra na lista de intencionais', () => {
    expect(
      resolveIncludedDuplicateRows(rows, { skipDuplicates: false, duplicateIncludes: [3] }),
    ).toEqual([2]);
  });
});

/**
 * Regressão do loop de prévia: a chave gravada depois de uma prévia e a chave
 * comparada no efeito de sincronização precisam sair da MESMA função. Antes
 * da correção, a tela gravava `JSON.stringify(options)` e comparava com
 * `importIdentityKey(...)`: as duas serializações nunca coincidiam (ordem das
 * chaves e `undefined` x `null`), então o efeito reagendava a prévia sem
 * parar e o botão Importar ficava desabilitado para sempre.
 */
describe('import-decisions - chave de identidade da prévia', () => {
  const groups = [
    group({ sourceNormalized: 'pagamento_recebido', sourceCategory: 'PAGAMENTO_RECEBIDO' }),
    group(),
  ];

  it('a chave gravada e a chave comparada são idênticas', () => {
    const decisions = buildCategoryDecisions(groups, {});
    // o que a tela grava depois da prévia
    const recorded = previewIdentityKey({
      destinationPaymentMethodId: 7,
      categoryDecisions: decisions,
    });
    // o que o efeito de sincronização compara
    const desired = previewIdentityKey(
      buildImportIdentity(groups, {}, 7),
    );
    expect(recorded).toBe(desired);
  });

  it('a forma das opções não altera a chave (undefined x null x ausente)', () => {
    const decisions = buildCategoryDecisions(groups, {});
    const base = previewIdentityKey({
      destinationPaymentMethodId: 7,
      categoryDecisions: decisions,
    });
    expect(
      previewIdentityKey({ destinationPaymentMethodId: 7, categoryDecisions: decisions }),
    ).toBe(base);
    expect(
      previewIdentityKey({ destinationPaymentMethodId: null, categoryDecisions: decisions }),
    ).not.toBe(base);
    expect(
      previewIdentityKey({
        destinationPaymentMethodId: undefined,
        categoryDecisions: decisions,
      }),
    ).toBe(
      previewIdentityKey({ destinationPaymentMethodId: null, categoryDecisions: decisions }),
    );
    expect(previewIdentityKey({})).toBe(
      previewIdentityKey({ destinationPaymentMethodId: null, categoryDecisions: {} }),
    );
  });

  it('a serialização legada (JSON.stringify) NÃO produz a mesma chave', () => {
    const decisions = buildCategoryDecisions(groups, {});
    const legacy = JSON.stringify({
      destinationPaymentMethodId: 7,
      categoryDecisions: decisions,
    });
    expect(legacy).not.toBe(
      previewIdentityKey({ destinationPaymentMethodId: 7, categoryDecisions: decisions }),
    );
  });

  it('a chave muda quando a conta ou a decisão muda', () => {
    const decisions = buildCategoryDecisions(groups, {});
    const base = previewIdentityKey({
      destinationPaymentMethodId: 7,
      categoryDecisions: decisions,
    });
    expect(
      previewIdentityKey({ destinationPaymentMethodId: 8, categoryDecisions: decisions }),
    ).not.toBe(base);
    expect(
      previewIdentityKey({
        destinationPaymentMethodId: 7,
        categoryDecisions: buildCategoryDecisions(groups, {
          mercado: { action: 'use', targetCategoryId: 42 },
        }),
      }),
    ).not.toBe(base);
  });

  it('a prévia estabiliza: repetir a mesma identidade não gera chave nova', () => {
    const decisions = buildCategoryDecisions(groups, {});
    const first = previewIdentityKey({
      destinationPaymentMethodId: 7,
      categoryDecisions: decisions,
    });
    // nova prévia devolve os mesmos grupos -> mesma identidade -> mesma chave
    const second = previewIdentityKey(
      buildImportIdentity(groups, {}, 7),
    );
    expect(second).toBe(first);
  });
});
