/**
 * Cross-context "which timer is running" signal.
 *
 * The extension popup and the host-page content scripts run in separate
 * JavaScript contexts and cannot observe each other's state. Focus/visibility
 * events don't help: opening the popup does not blur the underlying tab (it
 * stays "visible"), so a content script never learns that the popup started or
 * stopped a timer. The reliable channel - the same one the tokens already use -
 * is chrome.storage.local + storage.onChanged, which fires in every context.
 *
 * The popup writes the active entry here on every start/stop; content scripts
 * read it to decide button state and subscribe to live updates.
 */

import { getCurrentTimeEntry } from "./timeEntries";
import { accessToken } from "./oauth";

const ACTIVE_ENTRY_KEY = "st_active_entry";

export interface StoredActiveEntry {
  id: string;
  description: string;
}

// Dedupe writes so re-emitting the same state (e.g. repeated query refetches)
// doesn't fire redundant storage.onChanged events in every content script.
let lastWrittenJson: string | undefined;

/**
 * Records the active entry (or null when no timer is running) so content
 * scripts can reflect it. Called by the popup and by content-script toggles so
 * the signal stays authoritative regardless of which side started/stopped.
 */
export async function writeActiveEntry(
  entry: StoredActiveEntry | null,
): Promise<void> {
  const normalized = entry
    ? { id: entry.id, description: entry.description }
    : null;
  const json = JSON.stringify(normalized);
  if (json === lastWrittenJson) {
    return;
  }
  lastWrittenJson = json;
  await browser.storage.local.set({ [ACTIVE_ENTRY_KEY]: normalized });
}

/**
 * The description of the running timer, per the popup's last write.
 *   undefined = the popup has never recorded state -> fall back to the API
 *   null      = there is explicitly no running timer
 *   string    = description of the running timer
 */
export async function readActiveEntryDescription(): Promise<
  string | null | undefined
> {
  try {
    const result = await browser.storage.local.get(ACTIVE_ENTRY_KEY);
    if (!(ACTIVE_ENTRY_KEY in result)) {
      return undefined;
    }
    const entry = result[ACTIVE_ENTRY_KEY] as StoredActiveEntry | null;
    return entry?.description ?? null;
  } catch (error) {
    // Treat a storage read failure as "unknown" so callers fall back to the API
    // rather than surfacing an unhandled rejection.
    console.error("Solidtime: Failed to read active entry:", error);
    return undefined;
  }
}

/**
 * Whether the timer currently running is the one for issueDescription. Prefers
 * the popup-written storage signal (authoritative and instant); only when the
 * popup has never recorded state does it fall back to a one-off API lookup.
 */
export async function resolveIsTracking(
  issueDescription: string,
): Promise<boolean> {
  const stored = await readActiveEntryDescription();
  if (stored !== undefined) {
    return stored === issueDescription;
  }

  if (!accessToken.value) {
    return false;
  }
  try {
    const currentEntry = await getCurrentTimeEntry();
    return currentEntry?.data?.description === issueDescription;
  } catch (error) {
    console.error("Solidtime: Failed to resolve tracking state:", error);
    return false;
  }
}

/**
 * Subscribes to active-entry changes from any context (the popup starting or
 * stopping a timer, or another tab's button). Fires with the running timer's
 * description, or null when nothing is running.
 */
export function onActiveEntryChange(
  callback: (description: string | null) => void,
): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[ACTIVE_ENTRY_KEY]) {
      return;
    }
    const entry = changes[ACTIVE_ENTRY_KEY].newValue as
      | StoredActiveEntry
      | null
      | undefined;
    callback(entry?.description ?? null);
  });
}
