import { describe, expect, it } from 'vitest';
import { bankMod11, dueDateFromFactor, formatBarcodeDigits, mod10, parseBarcode, utilityMod11 } from '../src/lib/barcode';

/** Monta uma linha digitável bancária válida a partir do código de barras (padrão FEBRABAN). */
function bankLine(factor: string, amount: string, free = '1234567890123456789012345', bank = '0019'): string {
  const withoutDv = bank + factor + amount + free;
  const dv = bankMod11(withoutDv);
  const field1 = bank + free.slice(0, 5);
  const field2 = free.slice(5, 15);
  const field3 = free.slice(15, 25);
  return `${field1}${mod10(field1)}${field2}${mod10(field2)}${field3}${mod10(field3)}${dv}${factor}${amount}`;
}

/** Linha de arrecadação válida: 8 + segmento + identificador de valor + valor (11) + resto (29). */
function utilityLine(valueId: '6' | '7' | '8' | '9', amount: string): string {
  const check = valueId === '6' || valueId === '7' ? mod10 : utilityMod11;
  const withoutDv = `82${valueId}${amount}${'00010203040506070809101112131'.slice(0, 29)}`;
  const barcode = withoutDv.slice(0, 3) + check(withoutDv) + withoutDv.slice(3);
  return [0, 1, 2, 3].map((index) => barcode.slice(index * 11, index * 11 + 11)).map((block) => block + check(block)).join('');
}

describe('linha digitável', () => {
  it('módulos 10 e 11 conferem com cálculos feitos à mão', () => {
    expect(mod10('123')).toBe(0); // 3×2 + 2×1 + 1×2 = 10
    expect(mod10('7')).toBe(5); // 7×2 = 14 → 1+4 = 5
    expect(bankMod11('1')).toBe(9); // 1×2 = 2 → 11 − 2
    expect(bankMod11('0000')).toBe(1); // 11 vira 1
    expect(utilityMod11('0')).toBe(0);
    expect(utilityMod11('5')).toBe(1); // 5×2 = 10 → 11 − 10
  });

  it('boleto bancário: valida os campos, lê valor e vencimento e formata', () => {
    const line = bankLine('1000', '0000015075');
    expect(line).toHaveLength(47);
    const parsed = parseBarcode(formatBarcodeDigits(line), '2026-11-17');
    expect(parsed).toEqual({
      ok: true,
      value: { digits: line, kind: 'bank', amountCents: 15075, dueDate: '2025-02-22', formatted: formatBarcodeDigits(line) },
    });
    expect(formatBarcodeDigits(line)).toMatch(/^\d{5}\.\d{5} \d{5}\.\d{6} \d{5}\.\d{6} \d \d{14}$/);

    // Um dígito trocado no 2º campo e no valor (DV geral).
    const typo = line.slice(0, 12) + ((Number(line[12]) + 1) % 10) + line.slice(13);
    expect(parseBarcode(typo, '2026-11-17')).toEqual({ ok: false, error: expect.stringContaining('2º campo') });
    const wrongAmount = line.slice(0, 46) + ((Number(line[46]) + 1) % 10);
    expect(parseBarcode(wrongAmount, '2026-11-17')).toEqual({ ok: false, error: expect.stringContaining('geral') });
    // Fator e valor zerados: sem vencimento nem valor.
    expect(parseBarcode(bankLine('0000', '0000000000'), '2026-11-17')).toMatchObject({ ok: true, value: { amountCents: null, dueDate: null } });
  });

  it('fator de vencimento usa o ciclo mais próximo de hoje (recomeço em 22/02/2025)', () => {
    expect(dueDateFromFactor(9999, '2025-01-10')).toBe('2025-02-21');
    expect(dueDateFromFactor(1000, '2026-11-17')).toBe('2025-02-22');
    expect(dueDateFromFactor(1000, '2000-07-01')).toBe('2000-07-03');
    expect(dueDateFromFactor(1634, '2026-11-17')).toBe('2026-11-18');
  });

  it('arrecadação: módulo 10 ou 11 pelo 3º dígito; 7 e 9 não trazem valor efetivo', () => {
    const energy = utilityLine('6', '00000012345');
    expect(parseBarcode(energy, '2026-11-17')).toMatchObject({ ok: true, value: { kind: 'utility', amountCents: 12345, dueDate: null } });
    expect(parseBarcode(utilityLine('8', '00000009990'), '2026-11-17')).toMatchObject({ ok: true, value: { amountCents: 9990 } });
    expect(parseBarcode(utilityLine('7', '00000009990'), '2026-11-17')).toMatchObject({ ok: true, value: { amountCents: null } });
    expect(formatBarcodeDigits(energy)).toMatch(/^(\d{11}-\d ){3}\d{11}-\d$/);
    const broken = energy.slice(0, 30) + ((Number(energy[30]) + 1) % 10) + energy.slice(31);
    expect(parseBarcode(broken, '2026-11-17')).toEqual({ ok: false, error: expect.stringContaining('3º bloco') });
  });

  it('recusa tamanho errado e arrecadação que não começa com 8', () => {
    expect(parseBarcode('123', '2026-11-17')).toEqual({ ok: false, error: expect.stringContaining('47 dígitos') });
    expect(parseBarcode(`7${utilityLine('6', '00000012345').slice(1)}`, '2026-11-17')).toEqual({ ok: false, error: expect.stringContaining('começar com 8') });
  });
});
