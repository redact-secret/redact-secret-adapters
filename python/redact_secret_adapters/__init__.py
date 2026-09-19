"""Host integrations for Redact Secret: stdlib ``logging`` and, under the
``otel`` extra, OpenTelemetry.

Importing this package imports neither ``redact_secret`` nor any host SDK.
``logging_filter`` and ``otel`` are imported explicitly by the code that
needs them.
"""

from .mask_leaf import BLOCK_MARKER, CYCLE_MARKER, DEFAULT_LIMITS, ERROR_MARKER, LIMIT_MARKER, mask_leaf_with
from .mask_log_value import mask_log_value_with
from .mask_secrets import mask_secrets_with

__version__ = "0.1.0"

__all__ = [
    "BLOCK_MARKER",
    "CYCLE_MARKER",
    "DEFAULT_LIMITS",
    "ERROR_MARKER",
    "LIMIT_MARKER",
    "mask_leaf_with",
    "mask_log_value_with",
    "mask_secrets_with",
]
