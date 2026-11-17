/**
 * Perfis de arquivo por banco: reconhecem o formato (cabeçalho do CSV ou
 * banco do OFX), fixam o mapeamento das colunas e resumem as descrições do
 * banco. Arquivos sem perfil seguem o reconhecimento genérico.
 */
import { normalizeName } from '../../lib/normalize';
import type { ColumnMapping } from './types';

export interface FileProfile {
  id: string;
  /** Nome mostrado na prévia ("Nubank · conta corrente"). */
  label: string;
  accountKind: 'checking' | 'credit_card';
}

interface ProfileDefinition extends FileProfile {
  /** CSV: cabeçalho exato, já normalizado (minúsculas, sem acento). */
  csvHeaders?: string[];
  /** Mapeamento do CSV pelas posições do cabeçalho. */
  csvMapping?: ColumnMapping;
  /** OFX: reconhecido pelo banco (BANKID/FID) ou pela instituição (ORG). */
  ofx?: { kind: 'bank' | 'credit_card'; bankIds: string[]; org: RegExp };
  /** Resumo da descrição do banco; devolve o texto original quando não reconhece o padrão. */
  cleanDescription?: (text: string) => string;
  /** Colunas juntadas (com " - ") na descrição, quando o banco separa o tipo do favorecido. */
  combineDescription?: number[];
}

/** CPF mascarado (•••.123.456-••) ou CNPJ (12.345.678/0001-90) que o Nubank põe depois do nome. */
const NUBANK_DOCUMENT = /^(?:•••\.\d{3}\.\d{3}-••|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})$/;

/**
 * "Transferência enviada pelo Pix - FULANO - •••.123.456-•• - BANCO (0000) Agência: 1 Conta: 2"
 * vira "Pix enviado - FULANO"; boleto e débito também ficam só com o favorecido.
 */
export function cleanNubankDescription(text: string): string {
  const value = text.trim();
  const pix = /^Transferência (enviada|recebida) pelo Pix - (.+)$/.exec(value);
  if (pix) {
    const parts = pix[2].split(' - ');
    const documentIndex = parts.findIndex((part) => NUBANK_DOCUMENT.test(part.trim()));
    // Sem documento, o nome é o primeiro trecho (o resto é banco, agência e conta).
    const name = (documentIndex > 0 ? parts.slice(0, documentIndex).join(' - ') : parts[0])
      .replace(/^\d{2}\.\d{3}\.\d{3}\s+/, '') // MEI: raiz do CNPJ antes do nome
      .replace(/\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (name) return `Pix ${pix[1] === 'enviada' ? 'enviado' : 'recebido'} - ${name}`;
  }
  const boleto = /^Pagamento de boleto efetuado - (.+)$/.exec(value);
  if (boleto) return `Boleto - ${boleto[1].trim()}`;
  const debit = /^Compra no débito - (.+)$/.exec(value);
  if (debit) return `Débito - ${debit[1].trim()}`;
  return value;
}

/**
 * Inter: "Pix enviado: \"Cp :12345678-FULANO\"" (OFX) e "Pix enviado - FULANO" (CSV, já
 * juntando Histórico e Descrição) viram "Pix enviado - FULANO"; "Pagamento efetuado"
 * vira "Pagamento".
 */
export function cleanInterDescription(text: string): string {
  const value = text.replace(/\s+/g, ' ').trim();
  const quoted = /^([^:"]+):\s*"(?:Cp\s*:\s*\d+-)?(.+?)"$/.exec(value);
  const [kind, party] = quoted
    ? [quoted[1].trim(), quoted[2].trim()]
    : (() => {
        const split = /^(.+?) - (.+)$/.exec(value);
        return split ? [split[1].trim(), split[2].trim()] : [value, ''];
      })();
  if (!party) return value;
  const label = /^pagamento efetuado$/i.test(kind) ? 'Pagamento' : kind;
  return `${label} - ${party}`;
}

const PROFILES: ProfileDefinition[] = [
  {
    id: 'nubank-checking',
    label: 'Nubank · conta corrente',
    accountKind: 'checking',
    // Data,Valor,Identificador,Descrição — valor com ponto decimal e sinal (saída negativa).
    csvHeaders: ['data', 'valor', 'identificador', 'descricao'],
    csvMapping: {
      purchaseDate: null,
      dueDate: 0,
      description: 3,
      amount: 1,
      paymentMethod: null,
      installments: null,
      category: null,
      transfer: null,
    },
    ofx: { kind: 'bank', bankIds: ['0260', '260'], org: /NU PAGAMENTOS/i },
    cleanDescription: cleanNubankDescription,
  },
  {
    id: 'inter-checking',
    label: 'Inter · conta corrente',
    accountKind: 'checking',
    // Preâmbulo (conta, período, saldo) e depois: Data Lançamento;Histórico;Descrição;Valor;Saldo.
    csvHeaders: ['data lancamento', 'historico', 'descricao', 'valor', 'saldo'],
    csvMapping: {
      purchaseDate: null,
      dueDate: 0,
      description: 2,
      amount: 3,
      paymentMethod: null,
      installments: null,
      category: null,
      transfer: null,
    },
    combineDescription: [1, 2],
    ofx: { kind: 'bank', bankIds: ['077', '0077', '77'], org: /INTERMEDIUM|BANCO INTER/i },
    cleanDescription: cleanInterDescription,
  },
];

function publicProfile(profile: ProfileDefinition): FileProfile {
  return { id: profile.id, label: profile.label, accountKind: profile.accountKind };
}

export interface CsvProfileMatch {
  profile: FileProfile;
  mapping: ColumnMapping;
  cleanDescription: (text: string) => string;
  combineDescription: number[] | null;
}

/** Perfil pelo cabeçalho exato do CSV/planilha. */
export function detectCsvProfile(headers: string[]): CsvProfileMatch | null {
  const normalized = headers.map((header) => normalizeName(header).replace(/\s+/g, ' ').trim());
  // Colunas vazias no fim (ou geradas como "Coluna F") não contam.
  while (normalized.length > 0 && (normalized[normalized.length - 1] === '' || /^coluna [a-z]+$/.test(normalized[normalized.length - 1]))) {
    normalized.pop();
  }
  const profile = PROFILES.find(
    (candidate) =>
      candidate.csvHeaders &&
      candidate.csvMapping &&
      candidate.csvHeaders.length === normalized.length &&
      candidate.csvHeaders.every((header, index) => header === normalized[index]),
  );
  if (!profile?.csvMapping) return null;
  return {
    profile: publicProfile(profile),
    mapping: profile.csvMapping,
    cleanDescription: profile.cleanDescription ?? ((text) => text),
    combineDescription: profile.combineDescription ?? null,
  };
}

/** Perfil do OFX pelo banco (BANKID ou FID) ou pela instituição (ORG). */
export function detectOfxProfile(statement: {
  kind: 'bank' | 'credit_card';
  bankId: string | null;
  fid: string | null;
  org: string | null;
}): { profile: FileProfile; cleanDescription: (text: string) => string } | null {
  const profile = PROFILES.find(
    (candidate) =>
      candidate.ofx &&
      candidate.ofx.kind === statement.kind &&
      ((statement.bankId !== null && candidate.ofx.bankIds.includes(statement.bankId)) ||
        (statement.fid !== null && candidate.ofx.bankIds.includes(statement.fid)) ||
        (statement.org !== null && candidate.ofx.org.test(statement.org))),
  );
  if (!profile) return null;
  return { profile: publicProfile(profile), cleanDescription: profile.cleanDescription ?? ((text) => text) };
}
