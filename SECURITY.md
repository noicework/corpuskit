# Security policy

## Supported versions

Only the latest commit on the `main` branch (the branch that auto-deploys the reference instance -
see `CONTRIBUTING.md`) is supported. There are no maintained release branches or version tags at
this time.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.

Email: **security@noice.net.au**

Alternatively, use GitHub's private vulnerability reporting on this repository (Security -> Report a
vulnerability).

Please include:

- A description of the issue and its potential impact.
- Steps to reproduce, or a proof of concept if you have one.
- Any affected version/commit.

We will acknowledge reports as soon as practicable and aim to keep you updated as we investigate and
fix.

## Scope

In scope:

- The application code in this repository (`apps/`, `packages/`, `content/`, deployment
  configuration in `Dockerfile`, `fly.toml` and `.github/workflows/`).
- Authentication/authorisation of the admin surface (passcode gate), rate limiting on the paid-LLM
  routes, and handling of Progress Agentic RAG credentials.

Out of scope:

- The Progress Agentic RAG platform itself - report platform-level issues to Progress, not here.
- Third-party services this project depends on (esm.sh, JSR, Fly.io, Google Fonts) - report to those
  providers directly.
- Denial of service against a specific deployed instance you do not own.

## Deployment model and assumptions

This project is designed around a **single trusted administrator per deployment**. The admin surface
(provisioning, corpus management, labels, knowledge graph configuration, agents, branding) is gated
behind a single shared passcode (`ADMIN_PASSCODE` - see `.env.example`), not per-user accounts or
roles. If `ADMIN_PASSCODE` is unset, the admin surface is disabled entirely (`503 admin_disabled`)
rather than defaulting open.

If you need multi-administrator access control, audit logging of admin actions, or any other
access-control model beyond a single shared passcode, that is a known gap rather than a
vulnerability report - feel free to raise it as a feature request instead.
