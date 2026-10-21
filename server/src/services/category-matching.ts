import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/client';
import type { Executor } from './lookups';
import { categories as categoriesTable, categoryImportAliases } from '../db/schema';
import { nowIso } from '../lib/errors';
import { normalizeName } from '../lib/normalize';
import { levenshteinSimilarity, tokenJaccard } from '../lib/text-similarity';

export interface CategorySuggestionAlternative {
  categoryId: number;
  categoryName: string;
  score: number;
}

export interface CategorySuggestion {
  sourceCategory: string;
  sourceNormalized: string;
  targetCategoryId: number | null;
  targetCategoryName: string | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  method: 'exact' | 'normalized' | 'alias' | 'text_similarity' | 'contextual' | 'none';
  ambiguous: boolean;
  alternatives: CategorySuggestionAlternative[];
}

export function suggestCategory(
  db: AppDatabase | Executor,
  sourceCategory: string,
  description: string,
  amountCents: number,
): CategorySuggestion {
  const sourceNormalized = normalizeName(sourceCategory ?? '');
  const allCategories = db.select().from(categoriesTable).all();
  const alternatives: CategorySuggestionAlternative[] = [];

  // 1. Correspondência exata (nome idêntico).
  let target = allCategories.find((category) => category.name === sourceCategory);
  if (target) {
    return {
      sourceCategory,
      sourceNormalized,
      targetCategoryId: target.id,
      targetCategoryName: target.name,
      confidence: 'high',
      reason: 'Categoria idêntica encontrada.',
      method: 'exact',
      ambiguous: false,
      alternatives,
    };
  }

  // 2. Correspondência normalizada.
  target = allCategories.find((category) => category.normalizedName === sourceNormalized);
  if (target) {
    return {
      sourceCategory,
      sourceNormalized,
      targetCategoryId: target.id,
      targetCategoryName: target.name,
      confidence: 'high',
      reason: 'Categoria equivalente após normalização.',
      method: 'normalized',
      ambiguous: false,
      alternatives,
    };
  }

  // 3. Alias aprendido.
  const alias = db
    .select()
    .from(categoryImportAliases)
    .where(eq(categoryImportAliases.sourceNormalizedName, sourceNormalized))
    .get();
  if (alias) {
    const aliased = allCategories.find((category) => category.id === alias.targetCategoryId);
    if (aliased) {
      return {
        sourceCategory,
        sourceNormalized,
        targetCategoryId: aliased.id,
        targetCategoryName: aliased.name,
        confidence: 'high',
        reason: 'Alias de importação aprendido anteriormente.',
        method: 'alias',
        ambiguous: false,
        alternatives,
      };
    }
  }

  // 4. Similaridade textual.
  const scored = allCategories
    .map((category) => {
      const score = Math.max(
        tokenJaccard(sourceCategory, category.name),
        levenshteinSimilarity(sourceNormalized, category.normalizedName),
      );
      return { category, score };
    })
    .sort((left, right) => right.score - left.score || left.category.name.localeCompare(right.category.name));

  const best = scored[0];
  if (best && best.score >= 0.6) {
    const second = scored[1];
    const ambiguous =
      Boolean(second) && second.score >= 0.6 && best.score - second.score < 0.1;
    for (const item of scored.slice(0, 5)) {
      alternatives.push({
        categoryId: item.category.id,
        categoryName: item.category.name,
        score: item.score,
      });
    }
    return {
      sourceCategory,
      sourceNormalized,
      targetCategoryId: best.category.id,
      targetCategoryName: best.category.name,
      confidence: best.score >= 0.8 ? 'high' : 'medium',
      reason: 'Categoria sugerida por similaridade textual.',
      method: 'text_similarity',
      ambiguous,
      alternatives,
    };
  }

  // 5. Contextual: pagamento/fatura.
  const descriptionNormalized = normalizeName(description ?? '');
  if (
    (descriptionNormalized.includes('pagamento') || descriptionNormalized.includes('fatura')) &&
    sourceNormalized.includes('pagamento')
  ) {
    const contextual = allCategories.find((category) => {
      const normalized = normalizeName(category.name);
      return normalized.includes('pagamento') && normalized.includes('cartao');
    });
    if (contextual) {
      return {
        sourceCategory,
        sourceNormalized,
        targetCategoryId: contextual.id,
        targetCategoryName: contextual.name,
        confidence: 'medium',
        reason: 'Lançamento identificado como pagamento de cartão.',
        method: 'contextual',
        ambiguous: false,
        alternatives,
      };
    }
  }

  return {
    sourceCategory,
    sourceNormalized,
    targetCategoryId: null,
    targetCategoryName: null,
    confidence: 'low',
    reason: 'Sem correspondência confiável.',
    method: 'none',
    ambiguous: false,
    alternatives,
  };
}

export function persistCategoryAlias(
  db: AppDatabase | Executor,
  source: string,
  targetId: number,
): void {
  const sourceNormalizedName = normalizeName(source ?? '');
  if (!sourceNormalizedName) return;
  const existing = db
    .select()
    .from(categoryImportAliases)
    .where(eq(categoryImportAliases.sourceNormalizedName, sourceNormalizedName))
    .get();
  if (existing) {
    db.update(categoryImportAliases)
      .set({ targetCategoryId: targetId })
      .where(eq(categoryImportAliases.sourceNormalizedName, sourceNormalizedName))
      .run();
  } else {
    db.insert(categoryImportAliases)
      .values({
        sourceNormalizedName,
        targetCategoryId: targetId,
        createdAt: nowIso(),
      })
      .run();
  }
}