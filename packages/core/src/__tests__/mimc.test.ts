import { describe, it, expect, beforeAll } from 'vitest';
import { initMimc, mimcHash, mimcHashSingle, mimcHashMulti } from '../index.js';

describe('MiMC hash (circomlibjs)', () => {
  beforeAll(async () => {
    await initMimc();
  });

  it('produces a non-zero result', () => {
    const result = mimcHash(1n, 2n);
    expect(result).not.toBe(0n);
  });

  it('is deterministic', () => {
    const a = mimcHash(42n, 99n);
    const b = mimcHash(42n, 99n);
    expect(a).toBe(b);
  });

  it('is sensitive to input changes', () => {
    const a = mimcHash(1n, 2n);
    const b = mimcHash(1n, 3n);
    expect(a).not.toBe(b);
  });

  it('is sensitive to input order', () => {
    const a = mimcHash(1n, 2n);
    const b = mimcHash(2n, 1n);
    expect(a).not.toBe(b);
  });

  it('mimcHashSingle works', () => {
    const result = mimcHashSingle(12345n);
    expect(result).not.toBe(0n);
    expect(typeof result).toBe('bigint');
  });

  it('mimcHashMulti with 2 inputs matches mimcHash', () => {
    const a = mimcHash(10n, 20n);
    const b = mimcHashMulti(10n, 20n);
    expect(a).toBe(b);
  });

  it('mimcHashMulti with 3 inputs works', () => {
    const result = mimcHashMulti(1n, 2n, 3n);
    expect(result).not.toBe(0n);
    expect(typeof result).toBe('bigint');
  });

  it('produces values in the BN254 scalar field', () => {
    const BN254_SCALAR_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    for (let i = 0n; i < 10n; i++) {
      const h = mimcHash(i, i + 1n);
      expect(h).toBeGreaterThanOrEqual(0n);
      expect(h).toBeLessThan(BN254_SCALAR_ORDER);
    }
  });
});
