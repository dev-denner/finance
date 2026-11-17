/**
 * Leitura de um boleto em PDF para criar uma conta: valor e vencimento pela
 * linha digitável, beneficiário pelo texto e, pelo histórico, a descrição e a
 * categoria usadas antes para o mesmo credor. Não grava nada.
 */
import { desc, eq } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client';
import { categories, scheduledBills } from '../../db/schema';
import { findBarcodeInText, type BarcodeDetails } from '../../lib/barcode';
import { badRequest } from '../../lib/errors';
import { displayName } from '../../lib/normalize';
import { pdfLineTexts, readPdfTextLines } from '../../lib/pdf-text';
import { descriptionSimilarity } from '../bill-payment-detection';
import { MAX_ATTACHMENT_BYTES, sniffAttachmentType } from './attachments';

/** Semelhança mínima entre o beneficiário e a descrição de uma conta antiga. */
const SIMILARITY_THRESHOLD = 0.5;
/** Contas consideradas no histórico (as mais recentes). */
const HISTORY_LIMIT = 2000;

export interface BoletoSuggestion {
  description: string;
  categoryId: number | null;
  categoryName: string | null;
  /** Por que a sugestão veio: conta anterior da mesma empresa, conta parecida ou só o boleto. */
  source: 'same_company' | 'similar_bill' | 'boleto';
  /** Conta do histórico usada na sugestão. */
  basedOn: { id: number; description: string; dueDate: string } | null;
}

export interface BoletoReading {
  barcode: BarcodeDetails | null;
  beneficiary: string | null;
  suggestion: BoletoSuggestion | null;
}

const BENEFICIARY_LABEL = /\b(benefici[aá]rio(?:\s+final)?|cedente)\b\s*:?/i;
/** Restos comuns depois do nome: documento, agência/código e rótulos vizinhos. */
const BENEFICIARY_NOISE =
  /\b(cnpj|cpf|ag[eê]ncia|c[oó]digo|endere[cç]o|sacador|avalista|pagador|data|vencimento|n[ºo°]?\s*documento)\b.*$/i;

function cleanBeneficiary(value: string): string | null {
  const cleaned = displayName(
    value
      .replace(BENEFICIARY_NOISE, '')
      .replace(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g, '')
      .replace(/[|:;]+/g, ' ')
      .replace(/[\s\-–,]+$/g, ''),
  );
  // Precisa ter letras: "Beneficiário" seguido só de números não é um nome.
  return cleaned.length >= 3 && /[a-zà-ú]{3}/i.test(cleaned) ? cleaned.slice(0, 120) : null;
}

/** Nome do beneficiário: texto depois do rótulo na mesma linha ou, vazio, na linha seguinte. */
export function findBeneficiary(lines: string[]): string | null {
  for (let index = 0; index < lines.length; index += 1) {
    const match = BENEFICIARY_LABEL.exec(lines[index]);
    if (!match) continue;
    const sameLine = cleanBeneficiary(lines[index].slice(match.index + match[0].length));
    if (sameLine) return sameLine;
    const next = lines[index + 1] ? cleanBeneficiary(lines[index + 1]) : null;
    if (next) return next;
  }
  return null;
}

/** "EMPRESA DE ENERGIA S.A." → "Empresa De Energia S.A." (o nome do boleto costuma vir em maiúsculas). */
function titleCase(value: string): string {
  if (value !== value.toUpperCase()) return value;
  return value.toLowerCase().replace(/(^|[\s/(-])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toUpperCase());
}

/**
 * Empresa da conta de consumo/tributo (48 dígitos): segmento e identificação
 * da empresa no código de barras (4 dígitos; 8 quando o segmento é 6, CNPJ).
 */
function utilityCompanyKey(digits: string): string | null {
  if (digits.length !== 48) return null;
  const barcode = [0, 1, 2, 3].map((index) => digits.slice(index * 12, index * 12 + 11)).join('');
  const segment = barcode[1];
  return `${segment}:${barcode.slice(15, segment === '6' ? 23 : 19)}`;
}

export function suggestFromHistory(
  db: AppDatabase,
  reading: { barcode: BarcodeDetails | null; beneficiary: string | null },
): BoletoSuggestion | null {
  const history = db
    .select({
      id: scheduledBills.id,
      description: scheduledBills.description,
      dueDate: scheduledBills.dueDate,
      barcode: scheduledBills.barcode,
      categoryId: scheduledBills.categoryId,
      categoryName: categories.name,
    })
    .from(scheduledBills)
    .innerJoin(categories, eq(scheduledBills.categoryId, categories.id))
    .orderBy(desc(scheduledBills.dueDate), desc(scheduledBills.id))
    .limit(HISTORY_LIMIT)
    .all();

  const toSuggestion = (bill: (typeof history)[number], source: BoletoSuggestion['source']): BoletoSuggestion => ({
    description: bill.description,
    categoryId: bill.categoryId,
    categoryName: bill.categoryName,
    source,
    basedOn: { id: bill.id, description: bill.description, dueDate: bill.dueDate },
  });

  // 1) Conta de consumo da mesma empresa (código no próprio código de barras).
  const company = reading.barcode ? utilityCompanyKey(reading.barcode.digits) : null;
  if (company) {
    const same = history.find((bill) => bill.barcode && utilityCompanyKey(bill.barcode) === company);
    if (same) return toSuggestion(same, 'same_company');
  }

  // 2) Conta antiga com descrição parecida com o beneficiário (a mais recente entre as mais parecidas).
  if (reading.beneficiary) {
    let best: { bill: (typeof history)[number]; score: number } | null = null;
    for (const bill of history) {
      const score = descriptionSimilarity(bill.description, reading.beneficiary);
      if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) best = { bill, score };
    }
    if (best) return toSuggestion(best.bill, 'similar_bill');
    return { description: titleCase(reading.beneficiary), categoryId: null, categoryName: null, source: 'boleto', basedOn: null };
  }
  return null;
}

export async function readBoleto(db: AppDatabase, buffer: Buffer, today: string): Promise<BoletoReading> {
  if (buffer.length === 0) throw badRequest('O arquivo está vazio.');
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw badRequest('O boleto pode ter no máximo 10 MB.');
  if (sniffAttachmentType(buffer) !== 'application/pdf') throw badRequest('Envie o boleto em PDF.');
  const lines = pdfLineTexts(
    await readPdfTextLines(buffer, {
      maxPages: 10,
      maxChars: 200_000,
      pagesError: 'O PDF deve ter no máximo dez páginas.',
      textError: 'O texto do PDF passa do limite para a leitura do boleto.',
    }),
  );
  let barcode: BarcodeDetails | null = null;
  for (const text of [...lines, lines.join(' ')]) {
    barcode = findBarcodeInText(text, today);
    if (barcode) break;
  }
  const beneficiary = findBeneficiary(lines);
  return { barcode, beneficiary, suggestion: suggestFromHistory(db, { barcode, beneficiary }) };
}
