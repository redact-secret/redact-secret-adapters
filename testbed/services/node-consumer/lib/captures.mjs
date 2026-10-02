/**
 * A bounded in-memory capture sink for scenarios (#194/#195 destinations).
 * At most MAX_ENTRIES entries of at most MAX_ENTRY_BYTES each; older entries
 * are dropped first. `reset()` runs between runs via the control API.
 */
export const MAX_ENTRIES = 100;
export const MAX_ENTRY_BYTES = 4096;

export class BoundedCaptures {
  #entries = [];

  add(label, text) {
    const body = String(text).slice(0, MAX_ENTRY_BYTES);
    this.#entries.push({ label: String(label).slice(0, 80), body });
    if (this.#entries.length > MAX_ENTRIES) this.#entries.shift();
  }

  snapshot() {
    return this.#entries.map((e) => ({ ...e }));
  }

  reset() {
    this.#entries = [];
  }
}
