#!/usr/bin/env node
// Thin launcher — delegates to the compiled CLI.
// Run `pnpm build` (or `turbo run build`) before using this command.
import('../dist/cli.js').catch((err) => {
  if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') {
    console.error(
      '[psr] Package not built yet. Run `pnpm --filter @psr/migrate build` first.\n' +
        'In the monorepo: `pnpm run build`',
    );
    process.exit(1);
  }
  console.error('[psr]', err);
  process.exit(1);
});
