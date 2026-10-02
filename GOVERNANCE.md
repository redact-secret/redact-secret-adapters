# Governance

This document says who runs Redact Secret adapters, how decisions are made,
and how the project keeps going if a maintainer becomes unavailable. The
repositories in the [`redact-secret`](https://github.com/redact-secret)
organization share one maintainer team and one model; this file states it
for this repository.

## Model

The adapters are a maintainer-led open source project. Maintainers make
final decisions after public discussion, and a decision is recorded where
anyone can read why it was made.

## Roles

| Role | Who | Responsibilities |
| --- | --- | --- |
| **Maintainer** | [@milocosmopolitan](https://github.com/milocosmopolitan) (Milo Kang), lead maintainer | Sets direction and the [roadmap](ROADMAP.md); reviews and merges pull requests; accepts or rejects ADRs; triages issues and security reports; cuts and approves release trains; enforces the [code of conduct](CODE_OF_CONDUCT.md). |
| **Contributor** | Anyone who opens an issue, discussion, or pull request | Follows [CONTRIBUTING.md](CONTRIBUTING.md), the [code of conduct](CODE_OF_CONDUCT.md), and the synthetic-data rule in [SECURITY.md](SECURITY.md). |
| **Security reporter** | Anyone who reports a vulnerability privately | Follows [SECURITY.md](SECURITY.md#reporting-a-vulnerability); is credited unless they ask not to be. |

`.github/CODEOWNERS` routes review requests to the maintainers. The
maintainer list here and `.github/CODEOWNERS` change together.

### Becoming a maintainer

A contributor with a sustained record of accepted, well-tested pull requests
and careful review may be invited by the existing maintainers. The invitation
is recorded by a pull request that updates this file and `.github/CODEOWNERS`.
A maintainer who steps down, or has been inactive for twelve months, moves to
an emeritus line in this file.

## How decisions are made

- **Day-to-day changes** — bug fixes, host-range updates, documentation — are
  decided in pull request review. A pull request merges into `develop` once
  CI is green and a maintainer approves it.
- **New policy, a new host, or a change to a public contract** (such as the
  [fail-closed markers](ARCHITECTURE.md#fail-closed-rules)) needs an
  Architecture Decision Record under [`docs/decisions/`](docs/decisions/),
  accepted or rejected by a maintainer in its pull request. What counts as a
  secret is decided in the core repository, not here.
- **Releases** ship as trains per [RELEASING.md](RELEASING.md); a maintainer
  approves each train's merge into `release`.
- **Disagreements** are discussed on the issue or pull request first. If
  maintainers cannot reach consensus, the lead maintainer decides and records
  the reasoning in the thread or ADR.

## Access continuity

The project must be able to continue with minimal interruption if any one
person becomes unavailable. These measures apply:

- **Source and history** are public on GitHub and owned by the
  `redact-secret` organization, not a personal account. Every release is
  tagged and has a GitHub Release.
- **Publication needs no personal credentials.** npm and PyPI use Trusted
  Publishing bound to `release.yml` in the `release` environment, so there is
  no long-lived registry token for anyone to hold or lose.
- **Administrative access** — GitHub organization ownership and owner rights
  on the npm `@redact-secret` scope and the `redact-secret-adapters` PyPI
  project — must be held by at least two people: the maintainers listed above
  and the designated backup listed below. The backup does not take part in
  day-to-day work; they keep access so they can appoint new maintainers or
  transfer the project if no maintainer is reachable for 30 days.
- **Designated backup:** _to be named by the lead maintainer_.
- **Documentation** — [ARCHITECTURE.md](ARCHITECTURE.md),
  [RELEASING.md](RELEASING.md) (including its one-time setup), and the ADRs —
  lets a new maintainer build, test, and release without private knowledge.

## Changing this document

Changes to governance are made by pull request, are open for comment for at
least seven days unless they only update the people listed, and are approved
by a maintainer.
