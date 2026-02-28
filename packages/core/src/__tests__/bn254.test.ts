import { describe, it, expect } from 'vitest';
import {
  BN254_G,
  BN254_H,
  BN254_IDENTITY,
  BN254_SCALAR_ORDER,
  ecAdd,
  ecMul,
  ecDouble,
  ecNeg,
  isOnCurve,
  encodePoint,
  decodePoint,
  bigintToBytes32,
  bytes32ToBigint,
  randomScalar,
  derivePubKey,
  scalarMod,
  fieldMod,
} from '../index.js';

describe('BN254 curve operations', () => {
  describe('Generator points', () => {
    it('generator G is on the curve', () => {
      expect(isOnCurve(BN254_G)).toBe(true);
    });

    it('generator H is on the curve', () => {
      expect(isOnCurve(BN254_H)).toBe(true);
    });

    it('identity point is on the curve', () => {
      expect(isOnCurve(BN254_IDENTITY)).toBe(true);
    });

    it('G and H are different points', () => {
      expect(BN254_G.x !== BN254_H.x || BN254_G.y !== BN254_H.y).toBe(true);
    });
  });

  describe('Point addition', () => {
    it('P + O = P (identity element)', () => {
      const result = ecAdd(BN254_G, BN254_IDENTITY);
      expect(result.x).toBe(BN254_G.x);
      expect(result.y).toBe(BN254_G.y);
    });

    it('O + P = P (identity element)', () => {
      const result = ecAdd(BN254_IDENTITY, BN254_G);
      expect(result.x).toBe(BN254_G.x);
      expect(result.y).toBe(BN254_G.y);
    });

    it('P + (-P) = O (inverse)', () => {
      const negG = ecNeg(BN254_G);
      const result = ecAdd(BN254_G, negG);
      expect(result.x).toBe(0n);
      expect(result.y).toBe(0n);
    });

    it('G + G = 2G (doubling via addition)', () => {
      const sum = ecAdd(BN254_G, BN254_G);
      const doubled = ecDouble(BN254_G);
      expect(sum.x).toBe(doubled.x);
      expect(sum.y).toBe(doubled.y);
      expect(isOnCurve(sum)).toBe(true);
    });

    it('result is on the curve', () => {
      const result = ecAdd(BN254_G, BN254_H);
      expect(isOnCurve(result)).toBe(true);
    });
  });

  describe('Scalar multiplication', () => {
    it('0 * G = O', () => {
      const result = ecMul(BN254_G, 0n);
      expect(result.x).toBe(0n);
      expect(result.y).toBe(0n);
    });

    it('1 * G = G', () => {
      const result = ecMul(BN254_G, 1n);
      expect(result.x).toBe(BN254_G.x);
      expect(result.y).toBe(BN254_G.y);
    });

    it('2 * G = G + G', () => {
      const mul2 = ecMul(BN254_G, 2n);
      const add2 = ecAdd(BN254_G, BN254_G);
      expect(mul2.x).toBe(add2.x);
      expect(mul2.y).toBe(add2.y);
    });

    it('3 * G = 2G + G', () => {
      const mul3 = ecMul(BN254_G, 3n);
      const twoG = ecMul(BN254_G, 2n);
      const add3 = ecAdd(twoG, BN254_G);
      expect(mul3.x).toBe(add3.x);
      expect(mul3.y).toBe(add3.y);
    });

    it('R * G = O (order)', () => {
      const result = ecMul(BN254_G, BN254_SCALAR_ORDER);
      expect(result.x).toBe(0n);
      expect(result.y).toBe(0n);
    });

    it('result is on the curve for random scalar', () => {
      const s = randomScalar();
      const result = ecMul(BN254_G, s);
      expect(isOnCurve(result)).toBe(true);
    });

    it('(a + b) * G = a*G + b*G (distributive)', () => {
      const a = randomScalar();
      const b = randomScalar();
      const lhs = ecMul(BN254_G, scalarMod(a + b));
      const rhs = ecAdd(ecMul(BN254_G, a), ecMul(BN254_G, b));
      expect(lhs.x).toBe(rhs.x);
      expect(lhs.y).toBe(rhs.y);
    });
  });

  describe('Point encoding/decoding', () => {
    it('round-trips G correctly', () => {
      const encoded = encodePoint(BN254_G);
      expect(encoded.length).toBe(64);
      const decoded = decodePoint(encoded);
      expect(decoded.x).toBe(BN254_G.x);
      expect(decoded.y).toBe(BN254_G.y);
    });

    it('round-trips a random point correctly', () => {
      const s = randomScalar();
      const point = ecMul(BN254_G, s);
      const encoded = encodePoint(point);
      const decoded = decodePoint(encoded);
      expect(decoded.x).toBe(point.x);
      expect(decoded.y).toBe(point.y);
    });
  });

  describe('Byte conversion', () => {
    it('bigintToBytes32 / bytes32ToBigint round-trip', () => {
      const val = 12345678901234567890n;
      const bytes = bigintToBytes32(val);
      expect(bytes.length).toBe(32);
      const recovered = bytes32ToBigint(bytes);
      expect(recovered).toBe(val);
    });

    it('handles zero', () => {
      const bytes = bigintToBytes32(0n);
      expect(bytes32ToBigint(bytes)).toBe(0n);
    });

    it('handles max 256-bit value', () => {
      const max = (1n << 256n) - 1n;
      const bytes = bigintToBytes32(max);
      expect(bytes32ToBigint(bytes)).toBe(max);
    });
  });

  describe('Key derivation', () => {
    it('derivePubKey produces a point on the curve', () => {
      const privKey = randomScalar();
      const pubKey = derivePubKey(privKey);
      expect(isOnCurve(pubKey)).toBe(true);
    });

    it('different private keys produce different public keys', () => {
      const k1 = randomScalar();
      const k2 = randomScalar();
      const pub1 = derivePubKey(k1);
      const pub2 = derivePubKey(k2);
      expect(pub1.x !== pub2.x || pub1.y !== pub2.y).toBe(true);
    });
  });
});
