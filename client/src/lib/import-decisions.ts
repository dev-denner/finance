import type {
  BillDecision,
  BillPaymentCandidate,
  CategoryDecisionsPayload,
  CategorySuggestionGroup,
  ColumnMapping,
} from './types';

/**
 * Só sugere automaticamente quando há alvo e a confiança é alta/média sem
 * ambiguidade. Sugestões ambíguas ou de baixa confiança exigem decisão humana.
 */
export function canAutoAcceptSuggestion(group: CategorySuggestionGroup): boolean {
  return group.targetCategoryId !== null && !group.ambiguous && group.confidence !== 'low';
}

/** Grupos que o usuário precisa revisar (categoria de origem conhecida e diferente). */
export function isReviewableCategoryGroup(group: CategorySuggestionGroup): boolean {
  return group.sourceCategory.trim() !== '' && group.method !== 'exact';
}

/**
 * Monta o payload de decisões usado tanto na prévia quanto na importação.
 * Fonte única: evita que a duplicidade seja calculada com uma identidade e a
 * gravação use outra.
 */
export function buildCategoryDecisions(
  groups: CategorySuggestionGroup[],
  chosen: CategoryDecisionsPayload,
): CategoryDecisionsPayload {
  const decisions: CategoryDecisionsPayload = {};
  for (const group of groups) {
    const selected = chosen[group.sourceNormalized];
    if (selected) {
      decisions[group.sourceNormalized] = {
        action: selected.action,
        sourceCategory: group.sourceCategory,
        targetCategoryId: selected.targetCategoryId,
        // O nome escolhido para uma categoria nova é do usuário: precisa
        // sobreviver ao payload, senão o servidor cria a categoria de origem.
        newCategoryName: selected.newCategoryName,
        // Escolha explícita do usuário pode persistir alias.
        confirmed: true,
      };
      continue;
    }
    const auto = canAutoAcceptSuggestion(group);
    decisions[group.sourceNormalized] = {
      action: auto ? 'accept' : 'create',
      sourceCategory: group.sourceCategory,
      targetCategoryId: auto ? (group.targetCategoryId ?? undefined) : undefined,
      // Sugestão automática nunca vira alias permanente; só uma escolha
      // explícita do usuário (selected acima) confirma a equivalência.
      confirmed: false,
    };
  }
  return decisions;
}

/**
 * Identidade usada para calcular a duplicidade: a mesma conta de destino e as
 * mesmas decisões de categoria precisam valer na prévia e na importação.
 */
export interface ImportIdentity {
  destinationPaymentMethodId: number | null;
  categoryDecisions: CategoryDecisionsPayload;
}

/** Monta a identidade canônica a partir dos grupos da prévia e das escolhas. */
export function buildImportIdentity(
  groups: CategorySuggestionGroup[],
  chosen: CategoryDecisionsPayload,
  destinationPaymentMethodId: number | null,
): ImportIdentity {
  return {
    destinationPaymentMethodId,
    categoryDecisions: buildCategoryDecisions(groups, chosen),
  };
}

/**
 * Chave estável da identidade. A prévia e a importação são comparadas por
 * ela: enquanto forem diferentes, a importação fica bloqueada e a prévia é
 * recalculada.
 */
export function importIdentityKey(identity: ImportIdentity): string {
  const decisions: Record<string, unknown> = {};
  for (const key of Object.keys(identity.categoryDecisions).sort()) {
    const decision = identity.categoryDecisions[key];
    if (!decision) continue;
    decisions[key] = {
      action: decision.action,
      sourceCategory: decision.sourceCategory ?? null,
      targetCategoryId: decision.targetCategoryId ?? null,
      newCategoryName: decision.newCategoryName ?? null,
      confirmed: decision.confirmed === true,
    };
  }
  return JSON.stringify({
    destinationPaymentMethodId: identity.destinationPaymentMethodId ?? null,
    categoryDecisions: decisions,
  });
}

/**
 * Chave canônica da prévia. Tanto a prévia quanto a importação precisam
 * falar a mesma língua: a chave gravada depois de uma prévia e a chave
 * comparada no efeito de sincronização têm que sair daqui, senão a prévia
 * nunca estabiliza e o botão de importar nunca habilita.
 */
export function previewIdentityKey(options: {
  destinationPaymentMethodId?: number | null;
  categoryDecisions?: CategoryDecisionsPayload;
}): string {
  return importIdentityKey({
    destinationPaymentMethodId: options.destinationPaymentMethodId ?? null,
    categoryDecisions: options.categoryDecisions ?? {},
  });
}

/**
 * Colunas que definem a identidade da importação. Quando o mapeamento muda
 * nessas colunas, a seleção anterior (conta de destino e decisões) deixa de
 * ser compatível e precisa ser refeita.
 */
export function mappingIdentityColumns(mapping: ColumnMapping): string {
  return JSON.stringify({
    paymentMethod: mapping.paymentMethod ?? null,
    category: mapping.category ?? null,
  });
}

/** true quando a seleção existente continua válida para o novo mapeamento. */
export function isMappingIdentityCompatible(
  previous: ColumnMapping,
  next: ColumnMapping,
): boolean {
  return mappingIdentityColumns(previous) === mappingIdentityColumns(next);
}

/**
 * Linhas que o usuário escolheu importar mesmo sendo duplicatas.
 *
 * A lista é explícita: o servidor só aceita duplicata quando ela está aqui.
 * Quando o usuário desliga "pular duplicatas", todas as duplicatas exatas da
 * prévia entram na lista.
 */
export function resolveIncludedDuplicateRows(
  rows: { rowNumber: number; duplicate: { kind: string } | null }[],
  options: { skipDuplicates: boolean; duplicateIncludes: Iterable<number> },
): number[] {
  const includes = new Set(options.duplicateIncludes);
  const result = new Set<number>();
  for (const row of rows) {
    if (row.duplicate?.kind !== 'exact') continue;
    if (options.skipDuplicates) {
      // Só entra na lista o que o usuário liberou linha a linha.
      if (includes.has(row.rowNumber)) result.add(row.rowNumber);
      continue;
    }
    // "Pular duplicatas" desligado: todas as duplicatas são intencionais.
    result.add(row.rowNumber);
  }
  return [...result].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Pagamentos de contas a pagar sugeridos na importação
// ---------------------------------------------------------------------------

/**
 * Pares de alta confiança e sem disputa já vêm marcados como confirmados na
 * revisão (o usuário vê e pode mudar); o resto fica pendente. O servidor
 * nunca vincula sem decisão enviada.
 */
export function defaultBillDecisions(candidates: BillPaymentCandidate[]): Record<string, BillDecision> {
  const decisions: Record<string, BillDecision> = {};
  for (const candidate of candidates) {
    decisions[candidate.key] = candidate.confidence === 'high' && !candidate.ambiguous ? 'confirm' : 'pending';
  }
  return decisions;
}

/** Mantém decisões já tomadas para candidatos que continuam na prévia nova. */
export function mergeBillDecisions(
  candidates: BillPaymentCandidate[],
  current: Record<string, BillDecision>,
): Record<string, BillDecision> {
  const next = defaultBillDecisions(candidates);
  for (const [key, decision] of Object.entries(current)) {
    if (Object.prototype.hasOwnProperty.call(next, key)) next[key] = decision;
  }
  return next;
}

/**
 * Aplica uma decisão. Confirmar um par devolve a pendente qualquer outro par
 * confirmado que use a mesma linha ou a mesma conta: uma linha paga uma conta
 * e uma conta é paga por uma linha.
 */
export function applyBillDecision(
  candidates: BillPaymentCandidate[],
  current: Record<string, BillDecision>,
  candidate: BillPaymentCandidate,
  decision: BillDecision,
): Record<string, BillDecision> {
  const next = { ...current, [candidate.key]: decision };
  if (decision !== 'confirm') return next;
  for (const other of candidates) {
    if (other.key === candidate.key || next[other.key] !== 'confirm') continue;
    if (other.party.key === candidate.party.key || other.bill.id === candidate.bill.id) next[other.key] = 'pending';
  }
  return next;
}

/** Só as decisões de candidatos cujas linhas ainda serão importadas. */
export function billDecisionsForImport(
  candidates: BillPaymentCandidate[],
  decisions: Record<string, BillDecision>,
  rejectedRows: Set<number>,
): Record<string, BillDecision> {
  const result: Record<string, BillDecision> = {};
  for (const candidate of candidates) {
    if (candidate.party.rowNumber !== null && rejectedRows.has(candidate.party.rowNumber)) continue;
    const decision = decisions[candidate.key];
    if (decision) result[candidate.key] = decision;
  }
  return result;
}
