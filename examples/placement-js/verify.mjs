// The verifier. It looks only at captured output, never at how the pipeline was built, and it
// never prints captured output: only a label, a verdict and a placeholder count.

// Synthetic, revoked-shaped value only. Never use a real credential with this verifier.
export const TOKEN = "ghp_SYNTHETICREVOKED00000000000000000000";

// snippet:start verdict
/**
 * LEAKED     the synthetic credential is in the captured output
 * UNVERIFIED nothing was captured, or no sanitized placeholder is in it, so nothing was proven
 * PROTECTED  output exists, the credential is absent, and a sanitized placeholder is present
 */
export function verdict(captured) {
  if (captured.includes(TOKEN)) return "LEAKED";
  if (captured.length === 0 || !/<SECRET_\d+>/.test(captured)) return "UNVERIFIED";
  return "PROTECTED";
}
// snippet:end verdict

/** Runs every recipe and exits non-zero when a protected path leaks or a control is not detected. */
export async function run(recipes) {
  let failed = false;
  for (const recipe of recipes) {
    const captured = await recipe.capture();
    const actual = verdict(captured);
    const expected = recipe.control ? "LEAKED" : "PROTECTED";
    const placeholders = (captured.match(/<SECRET_\d+>/g) ?? []).length;
    const kind = recipe.control ? "control  " : "protected";
    const ok = actual === expected;
    if (!ok) failed = true;
    console.log(`${ok ? "ok  " : "FAIL"} ${kind} ${actual.padEnd(10)} ${recipe.label} (${placeholders} placeholders)`);
  }
  if (failed) {
    console.error("FAIL: a protected path was not proven protected, or a negative control was not detected");
    process.exit(1);
  }
  console.log("OK: every protected path passed and every negative control was detected (tested paths only)");
}
