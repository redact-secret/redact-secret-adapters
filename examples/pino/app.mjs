import { createRedactingHooks } from "@redact-secret/adapter-pino";
import pino from "pino";

// Synthetic, revoked-shaped value only. Never put a real credential in an example.
const token = "ghp_SYNTHETICREVOKED00000000000000000000";

const logger = pino({ base: null, timestamp: false, hooks: await createRedactingHooks() });

logger.child({ session: token }).info("deploy with token %s", token);
