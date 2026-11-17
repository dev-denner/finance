/**
 * Dias úteis bancários no Brasil: segunda a sexta, fora os feriados nacionais
 * e os dias sem expediente bancário em todo o país (Carnaval e Corpus
 * Christi). Feriados estaduais e municipais não entram. Módulo puro, sobre ISO
 * AAAA-MM-DD em calendário civil (UTC).
 */

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shift(year: number, month: number, day: number, days: number): string {
  const date = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  return iso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher, calendário gregoriano). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

const holidayCache = new Map<number, Set<string>>();

/** Feriados bancários nacionais do ano. */
export function bankHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const fixed: [number, number][] = [
    [1, 1], // Confraternização Universal
    [4, 21], // Tiradentes
    [5, 1], // Dia do Trabalho
    [9, 7], // Independência
    [10, 12], // Nossa Senhora Aparecida
    [11, 2], // Finados
    [11, 15], // Proclamação da República
    [12, 25], // Natal
  ];
  // Dia Nacional de Zumbi e da Consciência Negra: feriado nacional desde 2024 (Lei 14.759/2023).
  if (year >= 2024) fixed.push([11, 20]);
  const days = new Set(fixed.map(([month, day]) => iso(year, month, day)));
  const [ey, em, ed] = easterSunday(year).split('-').map(Number);
  for (const offset of [-48, -47, -2, 60]) days.add(shift(ey, em, ed, offset)); // Carnaval (seg e ter), Sexta-feira Santa, Corpus Christi
  holidayCache.set(year, days);
  return days;
}

export function isBusinessDay(date: string): boolean {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !bankHolidays(year).has(date);
}

/** Último dia útil bancário do mês (1–12). */
export function lastBusinessDayOfMonth(year: number, month: number): string {
  let day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // Nenhum mês tem mais de uma semana seguida sem dia útil.
  while (day > 1 && !isBusinessDay(iso(year, month, day))) day -= 1;
  return iso(year, month, day);
}
