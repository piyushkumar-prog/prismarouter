import { describe, it, expect } from 'vitest';
import { validateSchemaName, generateSchemaName, quoteIdentifier } from '../schema-name.js';
import { InvalidSchemaNameError } from '../errors.js';

describe('validateSchemaName', () => {
  it('accepts valid names', () => {
    expect(() => validateSchemaName('t_acme_3f7a1b2c')).not.toThrow();
    expect(() => validateSchemaName('t_abc_00000000')).not.toThrow();
    expect(() => validateSchemaName('t_a1b_12345678')).not.toThrow();
  });

  it('rejects names not starting with t_', () => {
    expect(() => validateSchemaName('public')).toThrow(InvalidSchemaNameError);
    expect(() => validateSchemaName('acme_3f7a1b2c')).toThrow(InvalidSchemaNameError);
  });

  it('rejects names that are too short', () => {
    expect(() => validateSchemaName('t_ab')).toThrow(InvalidSchemaNameError);
  });

  it('rejects names with uppercase', () => {
    expect(() => validateSchemaName('t_ACME_3f7a1b2c')).toThrow(InvalidSchemaNameError);
  });

  it('rejects names with special chars', () => {
    expect(() => validateSchemaName('t_acme-corp_3f7a1b2c')).toThrow(InvalidSchemaNameError);
  });
});

describe('generateSchemaName', () => {
  it('generates a valid schema name', () => {
    const name = generateSchemaName('acme');
    expect(name).toMatch(/^t_[a-z0-9_]{3,40}$/);
  });

  it('strips non-alphanumeric from slug', () => {
    const name = generateSchemaName('Acme Corp!');
    expect(name).toMatch(/^t_acmecorp_[0-9a-f]{8}$/);
  });

  it('generates unique names for same slug', () => {
    const a = generateSchemaName('test');
    const b = generateSchemaName('test');
    // Very unlikely to collide (random 4 bytes)
    expect(a).not.toBe(b);
  });

  it('throws on empty slug after sanitisation', () => {
    expect(() => generateSchemaName('!!!')).toThrow();
  });
});

describe('quoteIdentifier', () => {
  it('wraps valid name in double quotes', () => {
    expect(quoteIdentifier('t_acme_3f7a1b2c')).toBe('"t_acme_3f7a1b2c"');
  });

  it('rejects invalid names', () => {
    expect(() => quoteIdentifier('public')).toThrow(InvalidSchemaNameError);
  });
});
