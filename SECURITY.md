# Security Policy

## Supported versions

Security fixes are applied to the latest minor release on the `main` branch. Older minor versions do not receive backports unless the vulnerability is critical and the fix is trivially portable.

| Version         | Supported |
| --------------- | --------- |
| 0.1.x (current) | ✅        |
| < 0.1           | ❌        |

---

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

To report a vulnerability, email **security@piyushkumar-prog.example** with:

- A description of the vulnerability and its potential impact.
- Steps to reproduce or a proof-of-concept (even a rough script is helpful).
- The version(s) affected.
- Whether you have a proposed fix.

We will acknowledge receipt within **72 hours** and aim to triage within **7 days**.

If you prefer encrypted communication, request our PGP key in the initial email.

---

## Disclosure policy

We follow coordinated disclosure:

1. You report the vulnerability privately.
2. We confirm and assess impact within 7 days.
3. We develop and test a fix.
4. We release the fix and publish a security advisory simultaneously.
5. We credit you in the advisory (unless you prefer to remain anonymous).

We ask that you give us at least **90 days** from initial report to public disclosure. If we fail to respond or ship a fix within a reasonable time, you may proceed with disclosure at your discretion.

---

## Scope

Issues in scope:

- Tenant isolation bypass — a query landing in the wrong schema.
- AsyncLocalStorage context leaks that cause cross-tenant data exposure.
- HMAC sig verification bypass in `router.wrapJob()`.
- SQL injection via schema names or raw SQL helpers.
- Authentication / authorisation bypass in the registry or guard layers.
- Denial of service via the pool governor or client cache.

Out of scope:

- Vulnerabilities in Prisma, pg, or other dependencies (report those upstream).
- Issues that require an attacker to have direct database access.
- Application-level bugs in code written by the library's users (the library reduces risk, it does not prevent all bugs).

---

## Security design notes

For a full description of what the guard covers and what remains the application's responsibility, see the **Threat model** section in [README.md](README.md#threat-model).
