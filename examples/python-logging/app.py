import logging

from redact_secret_adapters.logging_filter import RedactSecretFilter

# Synthetic, revoked-shaped value only. Never put a real credential in an example.
token = "ghp_SYNTHETICREVOKED00000000000000000000"

handler = logging.StreamHandler()
handler.addFilter(RedactSecretFilter())  # on the handler, not the logger
logging.getLogger().addHandler(handler)

logging.warning("deploy with token %s", token)
