export function formatBRL(cents: number, options: { absolute?: boolean } = {}): string {
  const value = options.absolute ? Math.abs(cents) : cents;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const reais = Math.floor(abs / 100);
  const centavos = String(abs % 100).padStart(2, '0');
  const grouped = reais.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}R$ ${grouped},${centavos}`;
}

export function formatCents(cents: number, options: { absolute?: boolean } = {}): string {
  const value = options.absolute ? Math.abs(cents) : cents;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const reais = Math.floor(abs / 100);
  const centavos = String(abs % 100).padStart(2, '0');
  const grouped = reais.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${grouped},${centavos}`;
}

export function centsToPlain(cents: number): string {
  return formatCents(cents);
}

export function formatDateBR(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [year, month, day] = iso.slice(0, 10).split('-');
  if (!year || !month || !day) return iso;
  return `${day}/${month}/${year}`;
}

export function formatDateTimeBR(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function todayISO(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function isoToParts(iso: string | null | undefined): { year: number; month: number } | null {
  if (!iso) return null;
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
  return { year, month };
}

export const MONTHS_SHORT = [
  'Jan',
  'Fev',
  'Mar',
  'Abr',
  'Mai',
  'Jun',
  'Jul',
  'Ago',
  'Set',
  'Out',
  'Nov',
  'Dez',
];

export const MONTHS_LONG = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
];

export function formatInstallments(
  number: number | null,
  total: number | null,
): string {
  if (number !== null && total !== null) return `${number}/${total}`;
  if (number !== null) return String(number);
  if (total !== null) return `${total}x`;
  return '—';
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

const CATEGORY_COLORS = [
  'bg-blue-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-violet-500',
  'bg-rose-500',
  'bg-cyan-500',
  'bg-orange-500',
  'bg-indigo-500',
  'bg-teal-500',
  'bg-fuchsia-500',
];

export function categoryColor(id: number): string {
  return CATEGORY_COLORS[id % CATEGORY_COLORS.length];
}

/** Paleta estável para categorias sem cor cadastrada. */
export const CATEGORY_PALETTE = [
  '#2563eb',
  '#059669',
  '#d97706',
  '#7c3aed',
  '#e11d48',
  '#0891b2',
  '#ea580c',
  '#4f46e5',
  '#0d9488',
  '#c026d3',
  '#65a30d',
  '#475569',
];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Cor efetiva da categoria: usa a cadastrada ou cai numa cor padrão estável. */
export function categoryColorHex(id: number, color?: string | null): string {
  if (color && HEX_COLOR.test(color)) return color;
  return CATEGORY_PALETTE[Math.abs(id) % CATEGORY_PALETTE.length];
}

/** Cor de fundo suave derivada da cor da categoria (compatível com tema claro/escuro). */
export function categoryTint(color: string, alpha = '1f'): string {
  return `${color}${alpha}`;
}
