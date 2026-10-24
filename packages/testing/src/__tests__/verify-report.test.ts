import { describe, it, expect } from 'vitest';
import { formatMarkdownReport } from '../verify.js';
import type { VerifyReport } from '../types.js';

describe('formatMarkdownReport', () => {
  it('renders a PASS report with the probe table', () => {
    const report: VerifyReport = {
      passed: 2,
      failed: 0,
      skipped: 0,
      total: 2,
      durationMs: 123,
      probes: [
        { name: 'context-throws-outside-run', status: 'pass', durationMs: 1 },
        { name: 'sequential-cross-reads', status: 'pass', durationMs: 2 },
      ],
    };

    const md = formatMarkdownReport(report);

    expect(md).toContain('✅ PASS');
    expect(md).toContain('**Passed:** 2 / **Failed:** 0 / **Total:** 2');
    expect(md).toContain('| ✅ context-throws-outside-run | pass | 1ms |  |');
    expect(md).toContain('| ✅ sequential-cross-reads | pass | 2ms |  |');
  });

  it('renders a FAIL report with the error detail', () => {
    const report: VerifyReport = {
      passed: 0,
      failed: 1,
      skipped: 0,
      total: 1,
      durationMs: 5,
      probes: [
        {
          name: 'concurrent-isolation',
          status: 'fail',
          durationMs: 5,
          error: 'leak detected',
        },
      ],
    };

    const md = formatMarkdownReport(report);

    expect(md).toContain('❌ FAIL');
    expect(md).toContain('| ❌ concurrent-isolation | fail | 5ms | leak detected |');
  });
});
