import { describe, expect, it } from 'vitest';
import { centsToPlain, formatBRL, parseAmountToCents } from '../src/lib/money';

function cents(input: unknown): number {
  const result = parseAmountToCents(input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe('conversão de moeda brasileira', () => {
  it('converte valores negativos com símbolo e separador brasileiro', () => {
    expect(cents('-R$ 500,00')).toBe(-50000);
    expect(cents('- R$ 1.234,56')).toBe(-123456);
  });

  it('converte valores positivos com separador de milhar', () => {
    expect(cents('R$ 1.250,50')).toBe(125050);
    expect(cents('1.250,50')).toBe(125050);
    expect(cents('R$ 8.500,00')).toBe(850000);
  });

  it('converte o formato com ponto decimal', () => {
    expect(cents('-R$ 500.00')).toBe(-50000);
    expect(cents('500.00')).toBe(50000);
    expect(cents('0.5')).toBe(50);
  });

  it('interpreta ponto isolado como milhar brasileiro', () => {
    expect(cents('1.250')).toBe(125000);
    expect(cents('12.345.678')).toBe(1234567800);
  });

  it('rejeita formatos ambíguos em vez de adivinhar', () => {
    const ambiguous = parseAmountToCents('1,250');
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.error).toMatch(/ambíguo/i);

    expect(parseAmountToCents('1.2.3').ok).toBe(false);
    expect(parseAmountToCents('500,').ok).toBe(false);
    expect(parseAmountToCents('abc').ok).toBe(false);
    expect(parseAmountToCents('').ok).toBe(false);
    expect(parseAmountToCents('--500').ok).toBe(false);
  });

  it('suporta parênteses, sinais e números de planilhas', () => {
    expect(cents('(1.234,56)')).toBe(-123456);
    expect(cents('500,00-')).toBe(-50000);
    expect(cents(500.25)).toBe(50025);
    expect(cents(-1234.56)).toBe(-123456);
  });

  it('formata centavos sem usar ponto flutuante no armazenamento', () => {
    expect(formatBRL(-50000)).toBe('-R$ 500,00');
    expect(formatBRL(125050)).toBe('R$ 1.250,50');
    expect(centsToPlain(-50000)).toBe('-500,00');
    expect(centsToPlain(123456)).toBe('1.234,56');
  });

  it('trata zero corretamente', () => {
    expect(cents('R$ 0,00')).toBe(0);
    expect(cents('0')).toBe(0);
    expect(formatBRL(0)).toBe('R$ 0,00');
  });
});
