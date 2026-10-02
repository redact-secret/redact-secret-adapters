## Summary

<!-- What observable behavior changes, and why. Link the issue: "Closes #123". -->

## Verification

<!-- The commands you ran and what they showed. -->

## Checklist

- [ ] Behavior changes and new functionality come with tests; a bug fix includes a test that fails without it.
- [ ] The change holds to the [security boundary](../ARCHITECTURE.md#security-boundary): no network, filesystem, environment, or telemetry work, and no plaintext in error paths.
- [ ] Fixtures, logs, and examples use only unmistakably synthetic values — no real credentials.
- [ ] A user-visible change adds an `Unreleased` entry to the affected package's `CHANGELOG.md`.
- [ ] I certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/) for this contribution, which is licensed under the repository's MIT License.
