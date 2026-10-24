# Contributing to prisma-schema-router

Thank you for your interest in contributing. This document covers how to get the project running locally, the branching and PR workflow, coding standards, and how contributions are reviewed.

---

## Table of contents

1. [Code of Conduct](#code-of-conduct)
2. [We found a bug](#we-found-a-bug)
3. [We have a feature idea](#we-have-a-feature-idea)
4. [Development setup](#development-setup)
5. [Project structure](#project-structure)
6. [Making changes](#making-changes)
7. [Tests](#tests)
8. [Commit messages](#commit-messages)
9. [Changesets](#changesets)
10. [Opening a pull request](#opening-a-pull-request)
11. [Review process](#review-process)
12. [Maintainers](#maintainers)

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to abide by its terms. Violations can be reported to the maintainers via the contact in [SECURITY.md](SECURITY.md).

---

## We found a bug

1. Search [existing issues](https://github.com/piyushkumar-prog/prisma-schema-router/issues) — it may already be tracked.
2. If not, open a **Bug report** using the issue template. Include:
   - Minimal reproduction (ideally a failing test or a short script)
   - Prisma version, Node version, and pooler (PgBouncer / Supabase / RDS / direct)
   - Expected vs. actual behaviour
   - Relevant stack trace

For security vulnerabilities, do **not** open a public issue — see [SECURITY.md](SECURITY.md).

---

## We have a feature idea

Open a **Feature request** using the issue template. Describe the problem you are solving, not just the solution, so we can discuss the right approach before implementation work begins.

Large features (new packages, new CLI commands, changes to the public API) should be discussed in an issue before a PR is opened. Small fixes and documentation improvements do not need prior discussion.

---

## Development setup

### Prerequisites

| Tool       | Version | Notes                                                         |
| ---------- | ------- | ------------------------------------------------------------- |
| Node.js    | ≥ 18    | `node --version`                                              |
| pnpm       | ≥ 9     | `npm install -g pnpm`                                         |
| PostgreSQL | ≥ 14    | Local or Docker — only needed for `psr verify` and migrations |

### Clone and install

```bash
git clone https://github.com/piyushkumar-prog/prisma-schema-router.git
cd prisma-schema-router
pnpm install
```

### Bootstrap the control schema

```bash
# Set up a local Postgres database and export the connection strings:
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/psr_dev"
export PSR_CONTROL_URL="$DATABASE_URL"

psql $DATABASE_URL -f packages/migrate/sql/001_create_control_tables.sql
```

### Build all packages

```bash
pnpm build
```

### Run unit tests (no Postgres required)

```bash
pnpm test:run
```

---

## Project structure

```
prisma-schema-router/
├── packages/
│   ├── core/           @psr/core — router, context, LRU cache, guard, registry
│   ├── migrate/        @psr/migrate — fleet migration engine + psr CLI
│   ├── provision/      @psr/provision — tenant lifecycle
│   ├── governor/       @psr/governor — per-tenant concurrency
│   ├── testing/        @psr/testing — isolation conformance suite
│   ├── otel/           @psr/otel — OpenTelemetry metrics + tracing
│   ├── adapters-express/
│   └── adapters-fastify/
├── apps/
│   └── example/        working Express demo app
├── .github/
│   ├── workflows/ci.yml
│   ├── ISSUE_TEMPLATE/
│   └── pull_request_template.md
├── CONTRIBUTING.md     ← you are here
├── SECURITY.md
├── CODE_OF_CONDUCT.md
└── README.md
```

Each package is independent — it has its own `tsconfig.json`, `vitest.config.ts`, and `package.json`. Turbo orchestrates builds and tests.

---

## Making changes

1. **Fork** the repo and create a branch from `main`:

   ```bash
   git checkout -b fix/issue-123-context-leak
   # or
   git checkout -b feat/nestjs-adapter
   ```

2. **Edit** source files in `packages/<name>/src/`. Never edit `dist/` — it is generated.

3. **Build** your package to check for type errors:

   ```bash
   pnpm --filter @psr/<name> build
   ```

4. **Add or update tests** in `packages/<name>/src/__tests__/`. Unit tests must run with no
   database — anything that needs a real PostgreSQL belongs in the isolation conformance
   suite (`@psr/testing`) and is exercised with `psr verify` instead.

5. **Run the full test suite** before pushing:
   ```bash
   pnpm test:run
   ```

### Coding standards

- TypeScript strict mode (`strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`). Do not disable strict checks to make code compile.
- All imports from within a package use `.js` extensions (required for Node16 ESM — TypeScript resolves `.js` → `.ts` at build time).
- No circular dependencies between packages.
- `@psr/core` must remain dependency-free (peer deps only: `pg`, `@prisma/adapter-pg`, `@prisma/client`, plus the optional `@psr/governor`). Do not add `dependencies` to its `package.json`.
- SQL identifiers must always go through `quoteIdentifier()` — never concatenate schema names directly into SQL strings.
- Guard layers must remain fail-closed. A missing or wrong tenant context must produce an error, never a query against `public`.

---

## Tests

### Unit tests (no Postgres)

Located in `src/__tests__/*.test.ts`. Run with:

```bash
pnpm test:run
# or for a single package:
pnpm --filter @psr/core run test:run
```

The CI matrix runs `pnpm test:run` on Node 18, 20 and 22 against two Prisma versions, with a
real Postgres 16 service and PgBouncer (transaction mode) available for the steps that need it.

### Isolation conformance (requires Postgres)

The suite that actually needs a database is `@psr/testing`, run through the CLI:

```bash
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/psr_test"
export PSR_CONTROL_URL="$DATABASE_URL"
psql $DATABASE_URL -f packages/migrate/sql/001_create_control_tables.sql # once
pnpm build                                                                # the CLI runs from dist
pnpm psr verify
```

It exits non-zero if any probe fails and writes `psr-verify-report.json` / `psr-verify-report.md`.
This must pass before a PR that touches routing, the context, or the guard layers can be merged.

---

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`, `ci`.

Scopes match package names without the `@psr/` prefix: `core`, `migrate`, `provision`, `governor`, `testing`, `otel`, `adapters-express`, `adapters-fastify`, `example`.

Examples:

```
feat(core): add router.wrapJob() with HMAC sig verification
fix(migrate): set lock_timeout per tenant in applyNative()
docs(readme): add wrapJob usage example
test(governor): assert TenantBusyError on queue timeout
```

---

## Changesets

This project uses [Changesets](https://github.com/changesets/changesets) to manage versions and changelogs.

Every PR that changes published package behaviour (features, fixes, breaking changes) must include a changeset:

```bash
pnpm changeset
```

This opens an interactive prompt:

1. Select which packages changed.
2. Choose the bump type: `patch` (bug fix), `minor` (new feature, non-breaking), `major` (breaking change).
3. Write one sentence describing the change from a consumer's perspective.

Documentation-only and test-only PRs do not need a changeset.

---

## Opening a pull request

1. Push your branch and open a PR against `main`.
2. Fill in the PR template.
3. Ensure all CI checks pass — `build`, `typecheck`, `test:run`.
4. Link the issue your PR resolves (e.g., `Closes #123`).

PRs are squash-merged. The PR title becomes the commit message, so follow the Conventional Commits format for the title.

---

## Review process

- Maintainers aim to review PRs within a week.
- A PR needs one approving review from a maintainer before merge.
- Breaking API changes need discussion in the linked issue before review begins.
- Reviewers may ask for changes. Please address all review comments — even if the change is just "acknowledged, not fixing now" with a follow-up issue.

---

## Maintainers

prisma-schema-router is built and maintained by:

- **Piyush Kumar** — [@piyushkumar-prog](https://github.com/piyushkumar-prog)
- **Shivanghi Sharma** — [@shivanghi-sharma](https://github.com/shivanghi-sharma)

---

Thank you for helping make schema-per-tenant PostgreSQL on Prisma less painful for everyone.
