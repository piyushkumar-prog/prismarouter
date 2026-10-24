import { randomBytes } from 'node:crypto';
import { InvalidSchemaNameError } from './errors.js';

/**
 * Pattern for valid tenant schema names.
 * Format: t_<slug>_<8 hex chars>
 * Full name must be 7–50 characters total.
 */
const SCHEMA_NAME_PATTERN = /^t_[a-z0-9_]{3,40}$/;

/**
 * Validates a schema name against the strict pattern.
 * Throws InvalidSchemaNameError if invalid.
 */
export function validateSchemaName(name: string): void {
  if (!SCHEMA_NAME_PATTERN.test(name)) {
    throw new InvalidSchemaNameError(name);
  }
}

/**
 * Generates a new schema name from a human-readable slug.
 * The slug is lowercased and sanitized; a random 8-hex suffix is appended.
 *
 * Example: generateSchemaName('acme-corp') => 't_acmecorp_3f7a1b2c'
 */
export function generateSchemaName(slug: string): string {
  const sanitized = slug
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 32);

  if (sanitized.length < 1) {
    throw new Error(`Cannot generate schema name from slug: "${slug}"`);
  }

  const suffix = randomBytes(4).toString('hex');
  const name = `t_${sanitized}_${suffix}`;
  validateSchemaName(name);
  return name;
}

/**
 * Quotes an identifier for safe use in SQL.
 * Uses double-quote escaping per the SQL standard.
 */
export function quoteIdentifier(name: string): string {
  validateSchemaName(name);
  // Escape any double quotes inside the name (schema names shouldn't have them, but be safe)
  return `"${name.replace(/"/g, '""')}"`;
}
