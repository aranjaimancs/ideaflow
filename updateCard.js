/**
 * updateCard.js — Trello write-back step
 *
 * Exports:
 *   updateCardDescription(cardId, markdown)
 *     Replaces the card's description with the given Markdown string.
 *
 *   attachAndMoveCard(cardId, url, doneListId)
 *     Attaches `url` as a link on the card, then moves the card to doneListId.
 *     Falls back to markProcessed() if the move fails.
 *
 *   markProcessed(cardId)
 *     Ensures a label named "processed" exists on the card's board, then
 *     adds it to the card. Safe to call multiple times — idempotent.
 *
 * Required env vars: TRELLO_KEY, TRELLO_TOKEN
 */

import "dotenv/config";

const { TRELLO_KEY, TRELLO_TOKEN } = process.env;

if (!TRELLO_KEY || !TRELLO_TOKEN) {
  console.error("updateCard.js: missing required env vars TRELLO_KEY, TRELLO_TOKEN");
  process.exit(1);
}

const BASE = "https://api.trello.com/1";

// ─── Core request helper ──────────────────────────────────────────────────────

/**
 * Make an authenticated Trello API request.
 *
 * @param {"GET"|"POST"|"PUT"|"DELETE"} method
 * @param {string} path   - e.g. "/cards/abc123"
 * @param {object} params - query-string params (merged with key/token)
 * @param {object} body   - JSON body for POST/PUT (omit for GET)
 * @returns {Promise<any>} parsed JSON response
 */
async function trello(method, path, params = {}, body = null) {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("key", TRELLO_KEY);
  url.searchParams.set("token", TRELLO_TOKEN);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const init = { method, headers: {} };
  if (body !== null) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trello ${method} ${path} → ${res.status}: ${text}`);
  }

  // 204 No Content — nothing to parse.
  if (res.status === 204) return null;
  return res.json();
}

// ─── Exported functions ───────────────────────────────────────────────────────

/**
 * Replace a card's description with `markdown`.
 *
 * @param {string} cardId
 * @param {string} markdown  - Trello supports Markdown in card descriptions
 */
export async function updateCardDescription(cardId, markdown) {
  console.log(`[updateCard] Updating description on card ${cardId}…`);
  await trello("PUT", `/cards/${cardId}`, {}, { desc: markdown });
  console.log(`[updateCard] Description updated.`);
}

/**
 * Attach `url` as a link on the card, then move the card to `doneListId`.
 *
 * If the move fails (e.g. the list no longer exists, or the token lacks
 * write access to the destination board), falls back to markProcessed() so
 * the card is never picked up again by the watcher.
 *
 * @param {string} cardId
 * @param {string} url        - the PR or preview URL to attach
 * @param {string} doneListId - destination list ID (TRELLO_DONE_LIST_ID)
 */
export async function attachAndMoveCard(cardId, url, doneListId) {
  // Step 1: Attach the URL. Treat this as best-effort — a failed attachment
  // should not block the card from being moved.
  console.log(`[updateCard] Attaching URL to card ${cardId}: ${url}`);
  try {
    await trello("POST", `/cards/${cardId}/attachments`, {}, { url, name: "MVP PR / Preview" });
    console.log(`[updateCard] Attachment added.`);
  } catch (err) {
    console.warn(`[updateCard] ⚠  Attachment failed (continuing): ${err.message}`);
  }

  // Step 2: Move the card to the done list.
  console.log(`[updateCard] Moving card ${cardId} to list ${doneListId}…`);
  try {
    await trello("PUT", `/cards/${cardId}`, {}, { idList: doneListId });
    console.log(`[updateCard] Card moved to done list.`);
  } catch (err) {
    console.warn(
      `[updateCard] ⚠  Move failed: ${err.message}\n` +
      `[updateCard]    Falling back to markProcessed() to prevent re-processing.`
    );
    await markProcessed(cardId);
  }
}

/**
 * Add a "processed" label to the card, creating the label on the board first
 * if it doesn't already exist. Idempotent — safe to call even if the label
 * is already present on the card.
 *
 * Color: "black" (neutral/done). Trello's available colors:
 *   yellow, purple, blue, red, green, orange, black, sky, pink, lime, null
 *
 * @param {string} cardId
 */
export async function markProcessed(cardId) {
  console.log(`[updateCard] markProcessed: adding "processed" label to card ${cardId}…`);

  // 1. Fetch the card to get its board ID and current labels.
  const card = await trello("GET", `/cards/${cardId}`, {
    fields: "idBoard,idLabels,labels",
  });

  // 2. Check if the card already carries a "processed" label.
  const alreadyLabelled = (card.labels ?? []).some(
    (l) => l.name.toLowerCase() === "processed"
  );
  if (alreadyLabelled) {
    console.log(`[updateCard] Card already has "processed" label — nothing to do.`);
    return;
  }

  const boardId = card.idBoard;

  // 3. Find or create the "processed" label on the board.
  const labelId = await ensureProcessedLabel(boardId);

  // 4. Add the label to the card.
  await trello("POST", `/cards/${cardId}/idLabels`, {}, { value: labelId });
  console.log(`[updateCard] "processed" label added (labelId: ${labelId}).`);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Return the ID of the "processed" label on `boardId`, creating it if needed.
 *
 * @param {string} boardId
 * @returns {Promise<string>} label ID
 */
async function ensureProcessedLabel(boardId) {
  // Fetch all labels on the board.
  const labels = await trello("GET", `/boards/${boardId}/labels`, { limit: 1000 });

  const existing = labels.find((l) => l.name.toLowerCase() === "processed");
  if (existing) {
    console.log(`[updateCard] Found existing "processed" label (id: ${existing.id}).`);
    return existing.id;
  }

  // Not found — create it.
  console.log(`[updateCard] "processed" label not found on board. Creating…`);
  const created = await trello("POST", `/labels`, {}, {
    name: "processed",
    color: "black",
    idBoard: boardId,
  });
  console.log(`[updateCard] Created label (id: ${created.id}).`);
  return created.id;
}
