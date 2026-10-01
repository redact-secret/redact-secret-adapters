"""A deterministic stand-in for ``scan_and_redact``, shaped exactly like
the real ``ScanResult`` (``.text``, ``.findings``, each finding's
``.action``), keyed on magic substrings. Kept in sync by hand with
``fixtures/fake-scanner.ts``; both implement the same four rules so the
``*-cases.json`` files in the root ``fixtures/`` directory mean the same
thing in either language.

- text containing ``BOOM`` raises (a simulated core failure).
- text containing ``BLOCK_ME`` gets a ``block`` finding.
- text matching ``SECRET_TOKEN_\\d+`` gets one ``redact`` finding over
  that span.
- text containing ``WARN_ME`` gets a ``warn`` finding (core leaves
  ``warn`` text untouched).
- anything else has no findings.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class FakeFinding:
    action: str
    id: str = "finding-1"
    type: str = "generic_token"
    detector: str = "fake"
    confidence: str = "high"
    obfuscation: str = "none"
    start: int = 0
    end: int = 0


@dataclass(frozen=True)
class FakeResult:
    text: str
    findings: list = field(default_factory=list)


_SECRET_TOKEN = re.compile(r"SECRET_TOKEN_\d+")


def fake_scan_and_redact(text: str, policy=None) -> FakeResult:
    if "BOOM" in text:
        raise RuntimeError("simulated core failure - must never surface to a caller")
    if "BLOCK_ME" in text:
        return FakeResult(text.replace("BLOCK_ME", "<SECRET_1>"), [FakeFinding("block")])
    match = _SECRET_TOKEN.search(text)
    if match:
        redacted = text[: match.start()] + "<SECRET_1>" + text[match.end() :]
        return FakeResult(redacted, [FakeFinding("redact")])
    if "WARN_ME" in text:
        return FakeResult(text, [FakeFinding("warn", confidence="medium")])
    return FakeResult(text, [])


class RecordingScanner:
    """``fake_scan_and_redact`` that also records each ``(text, policy)``
    call, so a test can assert what reached the core. Python-only; not part
    of the cross-language fixture contract."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []

    def __call__(self, text: str, policy=None) -> FakeResult:
        self.calls.append((text, policy))
        return fake_scan_and_redact(text, policy)


_KEYS = ("api_key", "password", "client_secret")
_VIEW = re.compile(r'^\{"(api_key|password|client_secret)":"([\s\S]*)"\}$')


class KeyAwareScanner:
    """A stand-in for a core whose detection is key-aware, for tests that
    must control what the key-context view reports (the Python twin of
    ``fixtures/key-aware-scanner.ts``). It detects nothing on its own text:
    only a leaf's view ``{"<key>":"<leaf>"}`` whose key is one of ``_KEYS``
    and whose leaf is at least eight characters, over the leaf's span.
    Everything else falls through to ``fake_scan_and_redact``. Offsets are
    Unicode code points, like the real Python binding."""

    def __init__(self, *, action="redact", span_key=False, corrupt_text=False, throw_on_view=False) -> None:
        self.action = action
        self.span_key = span_key
        self.corrupt_text = corrupt_text
        self.throw_on_view = throw_on_view
        self.calls: list[str] = []

    def __call__(self, text: str, policy=None) -> FakeResult:
        self.calls.append(text)
        match = _VIEW.match(text)
        if match is None:
            return fake_scan_and_redact(text, policy)
        if self.throw_on_view:
            raise RuntimeError("simulated view failure for " + text)
        key, leaf = match.group(1), match.group(2)
        start = len(key) + 5
        findings = []
        if self.span_key:
            findings.append(FakeFinding("redact", start=2, end=2 + len(key), type="contextual_secret"))
        if len(leaf) < 8:
            return FakeResult(text, findings)
        findings.append(FakeFinding(self.action, start=start, end=start + len(leaf), type="contextual_secret"))
        if self.corrupt_text:
            return FakeResult("<SECRET_1>", findings)
        replaced = "<SECRET_1>" if self.action in ("redact", "block") else leaf
        return FakeResult(text[:start] + replaced + text[start + len(leaf) :], findings)
