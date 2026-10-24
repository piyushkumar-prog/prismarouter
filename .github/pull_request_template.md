## Summary

<!-- What does this PR change and why? Link the issue it resolves, e.g. "Closes #123". -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing behaviour)
- [ ] Documentation only
- [ ] Refactor / internal change (no behaviour change)
- [ ] CI / tooling

## Packages touched

<!-- e.g. @psr/core, @psr/migrate -->

## Checklist

- [ ] The PR title follows [Conventional Commits](https://www.conventionalcommits.org/) (`feat(scope): ...`).
- [ ] `pnpm build` passes.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test:run` passes.
- [ ] We added or updated tests covering the change (or explained why not).
- [ ] `@psr/core` remains dependency-free (no new entries under `dependencies`).
- [ ] Routing or guard changes: the isolation conformance suite passes (`DATABASE_URL=... psr verify`).
- [ ] We added a Changeset (`pnpm changeset`) for user-facing changes.

## Notes for reviewers

<!-- Anything reviewers should know: design trade-offs, follow-up work, migration steps. -->
