"""The shared vault-token fixture, read from the root
``fixtures/vault-token-cases.json`` (redact-secret/redact-secret-adapters#52).
Kept in sync by hand with ``fixtures/vault-token.ts``; both build the same
token and the same context strings from the same file, so a case means the
same thing in either language.

``@redact-secret/vault`` lives in the sibling ``redact-secret-vault``
repository and is **not** a dependency of this one. Only the shape of its
token is reproduced here -- a ``<rsv_`` prefix, 32 hex digits, a ``>`` --
because that shape is its published contract and an adapter that rewrote one
would silently destroy a value the application still needs. The token is
assembled from its parts at load time, the way every other synthetic value in
this repository is: it is a placeholder shape, never a credential.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import NamedTuple

_FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "fixtures" / "vault-token-cases.json").read_text(encoding="utf-8")
)

#: One vault-shaped token: ``<rsv_`` + 32 hex digits + ``>``.
VAULT_TOKEN = _FIXTURE["token"]["prefix"] + _FIXTURE["token"]["body"] + _FIXTURE["token"]["suffix"]

#: The literal the vault refuses to accept in its own input (``TOKEN_LITERAL_IN_INPUT``).
VAULT_TOKEN_LITERAL = _FIXTURE["token"]["prefix"][1:]


class VaultTokenContext(NamedTuple):
    """One adversarial placement of :data:`VAULT_TOKEN`, with the text to feed an adapter."""

    name: str
    text: str


#: Every context in the fixture, as ready-to-scan text: an SDK call argument,
#: an ``Authorization: Bearer`` header, an environment assignment, a JSON value
#: under an ``api_key`` key, plain prose, and the bare token.
VAULT_TOKEN_CONTEXTS = tuple(
    VaultTokenContext(context["name"], context["before"] + VAULT_TOKEN + context["after"])
    for context in _FIXTURE["contexts"]
)
