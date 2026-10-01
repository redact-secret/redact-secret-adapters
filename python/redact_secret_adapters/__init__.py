"""Host integrations for Redact Secret: stdlib ``logging`` and, under the
``otel`` extra, OpenTelemetry.

Importing this package imports neither ``redact_secret`` nor any host SDK.
``logging_filter`` and ``otel`` are imported explicitly by the code that
needs them.
"""

from importlib.metadata import PackageNotFoundError, version

from ._activation import CoreActivationError
from .budget import DEFAULT_OPERATION_LIMITS, OperationBudget
from .key_context import KeyContextFailure, scan_leaf_in_key_context
from .mask_leaf import (
    BLOCK_MARKER,
    CYCLE_MARKER,
    DEFAULT_LIMITS,
    ERROR_MARKER,
    LIMIT_MARKER,
    MaskedLeaf,
    count_leaf,
    mask_leaf_outcome_with,
    mask_leaf_with,
)
from .mask_log_value import mask_log_value_with
from .mask_secrets import mask_secrets_with
from .outcome import LogRecordOutcome, OutcomeCounter, SpanOutcome, ValueCounts
from .scan_options import CoreOptionsError, ScanConfig, resolve_scan_config, verify_scan_options

# pyproject.toml is the single source of the version.
try:
    __version__ = version("redact-secret-adapters")
except PackageNotFoundError:  # imported from a source tree that was never installed
    __version__ = "0+unknown"

__all__ = [
    "BLOCK_MARKER",
    "CYCLE_MARKER",
    "CoreActivationError",
    "DEFAULT_LIMITS",
    "DEFAULT_OPERATION_LIMITS",
    "ERROR_MARKER",
    "LIMIT_MARKER",
    "CoreOptionsError",
    "KeyContextFailure",
    "LogRecordOutcome",
    "MaskedLeaf",
    "OperationBudget",
    "OutcomeCounter",
    "ScanConfig",
    "SpanOutcome",
    "ValueCounts",
    "count_leaf",
    "mask_leaf_outcome_with",
    "mask_leaf_with",
    "mask_log_value_with",
    "mask_secrets_with",
    "resolve_scan_config",
    "scan_leaf_in_key_context",
    "verify_scan_options",
]
