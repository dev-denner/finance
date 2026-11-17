/** Decisões de categoria e de forma de pagamento tomadas na revisão. */
import type { AppDatabase } from '../../db/client';
import { categories, paymentMethods } from '../../db/schema';
import { badRequest } from '../../lib/errors';
import { normalizeName } from '../../lib/normalize';
import type { CategoryDecision, CategoryDecisions } from './types';

export function buildDecisionsMap(
  decisions: CategoryDecisions | CategoryDecision[] | undefined,
): Map<string, CategoryDecision> {
  const map = new Map<string, CategoryDecision>();
  if (Array.isArray(decisions)) {
    for (const decision of decisions) {
      const key = normalizeName(decision.sourceCategory ?? '');
      if (key) map.set(key, decision);
    }
  } else if (decisions) {
    for (const [key, decision] of Object.entries(decisions)) {
      map.set(normalizeName(decision.sourceCategory ?? key), decision);
    }
  }
  return map;
}

export function lookupNames(db: AppDatabase): {
  categoryNames: Map<number, string>;
  paymentMethodNames: Map<number, string>;
} {
  return {
    categoryNames: new Map(
      db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .all()
        .map((category) => [category.id, category.name]),
    ),
    paymentMethodNames: new Map(
      db
        .select({ id: paymentMethods.id, name: paymentMethods.name })
        .from(paymentMethods)
        .all()
        .map((paymentMethod) => [paymentMethod.id, paymentMethod.name]),
    ),
  };
}

/** Nome efetivo da categoria depois da decisão do usuário (usado na duplicidade). */
export function effectiveCategoryName(
  sourceCategory: string,
  decision: CategoryDecision | undefined,
  categoryNames: Map<number, string>,
): string {
  if (!decision) return sourceCategory;
  if (decision.action === 'create') {
    return decision.newCategoryName?.trim() || sourceCategory;
  }
  if (decision.action === 'accept' || decision.action === 'use') {
    const targetName = decision.targetCategoryId
      ? categoryNames.get(decision.targetCategoryId)
      : undefined;
    return targetName ?? sourceCategory;
  }
  return sourceCategory;
}

/** Conta efetiva: arquivo quando informada; senão, a conta de destino do lote. */
export function effectivePaymentMethodName(
  paymentMethod: string | null,
  destinationPaymentMethodId: number | null | undefined,
  paymentMethodNames: Map<number, string>,
): string {
  if (paymentMethod !== null) return paymentMethod;
  if (!destinationPaymentMethodId) return '';
  return paymentMethodNames.get(destinationPaymentMethodId) ?? '';
}

/**
 * Valida decisões de categoria na fronteira do serviço: ação de aceite/uso
 * precisa apontar para uma categoria existente. Um alvo inválido nunca pode
 * cair silenciosamente na criação da categoria de origem.
 */
export function assertValidCategoryDecisions(
  decisions: Map<string, CategoryDecision>,
  categoryNames: Map<number, string>,
): void {
  for (const [key, decision] of decisions) {
    const source = (decision.sourceCategory ?? key).trim();
    if (!source) {
      throw badRequest('Decisão de categoria sem categoria de origem.');
    }
    if (decision.action === 'accept' || decision.action === 'use') {
      const target = decision.targetCategoryId;
      if (
        typeof target !== 'number' ||
        !Number.isInteger(target) ||
        target <= 0 ||
        !categoryNames.has(target)
      ) {
        throw badRequest(
          `Decisão de categoria inválida para "${source}": a categoria de destino não existe.`,
        );
      }
    }
    if (
      decision.action === 'create' &&
      typeof decision.newCategoryName === 'string' &&
      decision.newCategoryName.trim().length > 120
    ) {
      throw badRequest('Nome da nova categoria muito longo (máximo 120 caracteres).');
    }
  }
}
