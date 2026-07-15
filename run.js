/**
 * run.js — Orchestrator for the idea-mvp-pipeline
 *
 * Phases on each run:
 *   A. Resume in-flight cards (state: "pr_open") — check if PR was merged,
 *      attach the PR URL + move to done list if so.
 *   B. Pick up new cards from Trello — cards with no "processed" or
 *      "mvp-building" label — and run the full pipeline on each:
 *        1. Add "mvp-building" label + save state (crash-safe checkpoint)
 *        2. Expand idea via Claude API
 *        3. Write formatted description back to Trello
 *        4. Build MVP prototype via Claude Code CLI + open PR
 *        5. Save state with prUrl / prNumber
 *
 * State is persisted to pipeline-state.json in this directory.
 * The GitHub Actions workflow commits it back after each run.
 *
 * Usage:
 *   node run.js           # live run
 *   node run.js --dry-run # read-only — shows what would happen
 *
 * Required env vars:
 *   TRELLO_KEY, TRELLO_TOKEN, TRELLO_IDEAS_LIST_ID, TRELLO_DONE_LIST_ID
 *   ANTHROPIC_API_KEY
 *   GITHUB_TOKEN, GITHUB_USERNAME, IDEA_MVPS_REPO
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { expandIdea, formatCardDescription } from "./expand.js";
import { buildMvp } from "./build.js";
import {
  updateCardDescription,
} from "./updateCard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Flags ────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");

if (DRY_RUN) {
  console.log("\n⚠️  DRY RUN mode — no writes will be made to Trello, GitHub, or state.\n");
}

// ─── Env validation ───────────────────────────────────────────────────────────

const {
  TRELLO_KEY,
  TRELLO_TOKEN,
  TRELLO_IDEAS_LIST_ID,
  TRELLO_DONE_LIST_ID,
  GITHUB_TOKEN,
  GITHUB_USERNAME,
  IDEA_MVPS_REPO,
} = process.env;

const missingVars = [
  ["TRELLO_KEY", TRELLO_KEY],
  ["TRELLO_TOKEN", TRELLO_TOKEN],
  ["TRELLO_IDEAS_LIST_ID", TRELLO_IDEAS_LIST_ID],
  ["TRELLO_DONE_LIST_ID", TRELLO_DONE_LIST_ID],
  ["GITHUB_TOKEN", GITHUB_TOKEN],
  ["GITHUB_USERNAME", GITHUB_USERNAME],
  ["IDEA_MVPS_REPO", IDEA_MVPS_REPO],
]
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missingVars.length > 0) {
  console.error(`run.js: missing required env vars: ${missingVars.join(", ")}`);
  process.exit(1);
}

// ─── State file ───────────────────────────────────────────────────────────────

const STATE_FILE = join(__dirname, "pipeline-state.json");

/**
 * State shape:
 * {
 *   "cards": {
 *     "<trelloCardId>": {
 *       "slug": "idea-slug",
 *       "name": "Card Name",
 *       "state": "building" | "pr_open" | "done",
 *       "startedAt": "ISO8601",
 *       "mvpBuildingLabelId": "trelloLabelId",
 *       "prUrl": "https://github.com/...",
 *       "prNumber": 42,
 *       "previewUrl": "https://user.github.io/...",
 *       "prOpenedAt": "ISO8601",
 *       "doneAt": "ISO8601"
 *     }
 *   }
 * }
 */
function loadState() {
  if (!existsSync(STATE_FILE)) return { cards: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    console.warn(`[state] Could not parse ${STATE_FILE}: ${err.message}. Starting fresh.`);
    return { cards: {} };
  }
}

function saveState(state) {
  if (DRY_RUN) {
    console.log("  [DRY RUN] Would write pipeline-state.json");
    return;
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

// ─── Display helpers ──────────────────────────────────────────────────────────

function banner(msg) {
  const line = "═".repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${msg}`);
  console.log(line);
}

function section(msg) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${msg}`);
  console.log("─".repeat(60));
}

// ─── Dry-run wrapper ──────────────────────────────────────────────────────────

/**
 * Wraps a write operation so it becomes a no-op in dry-run mode.
 *
 * @param {string} description  - human-readable description of the write
 * @param {() => Promise<any>} fn - the actual write function
 * @param {any} mockReturn      - value to return in dry-run mode
 */
async function write(description, fn, mockReturn = null) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would: ${description}`);
    return mockReturn;
  }
  return fn();
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Convert a card name to a URL-safe slug. */
function toSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Extract PR number from a GitHub PR URL. */
function prNumberFromUrl(url) {
  const m = url.match(/\/pull\/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

// ─── Trello helpers ───────────────────────────────────────────────────────────

const TRELLO_BASE = "https://api.trello.com/1";

async function trelloGet(path, params = {}) {
  const url = new URL(`${TRELLO_BASE}${path}`);
  url.searchParams.set("key", TRELLO_KEY);
  url.searchParams.set("token", TRELLO_TOKEN);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Trello GET ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function trelloPost(path, body) {
  const url = new URL(`${TRELLO_BASE}${path}`);
  url.searchParams.set("key", TRELLO_KEY);
  url.searchParams.set("token", TRELLO_TOKEN);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Trello POST ${path} → ${res.status}: ${await res.text()}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Fetch all cards in the ideas list, filtering out any with a label whose
 * name (lowercased) matches "processed" or "mvp-building".
 */
async function getNewCards() {
  const cards = await trelloGet(`/lists/${TRELLO_IDEAS_LIST_ID}/cards`, {
    fields: "id,name,desc,labels",
  });

  return cards.filter((card) => {
    const labelNames = (card.labels ?? []).map((l) => l.name.toLowerCase());
    return !labelNames.includes("processed") && !labelNames.includes("mvp-building");
  });
}

/**
 * Return the ID of the "mvp-building" label on the list's board,
 * creating it (purple) if it doesn't exist.
 */
async function ensureMvpBuildingLabel(listId) {
  const list = await trelloGet(`/lists/${listId}`, { fields: "idBoard" });
  return ensureLabel(list.idBoard, "mvp-building", "purple");
}

/** Add a label to a card (idempotent — Trello ignores duplicates). */
async function addLabelToCard(cardId, labelId) {
  await trelloPost(`/cards/${cardId}/idLabels`, { value: labelId });
}

/**
 * Return the ID of a label by name on a board, creating it if absent.
 *
 * @param {string} boardId
 * @param {string} name   - label name (case-insensitive match, exact on create)
 * @param {string} color  - Trello color string (e.g. "green", "purple", "black")
 */
async function ensureLabel(boardId, name, color) {
  const labels = await trelloGet(`/boards/${boardId}/labels`, { limit: 1000 });
  const existing = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;

  console.log(`  Creating "${name}" label (${color}) on board ${boardId}…`);
  const created = await trelloPost(`/labels`, { name, color, idBoard: boardId });
  console.log(`  Created label id: ${created.id}`);
  return created.id;
}

// ─── GitHub helper ────────────────────────────────────────────────────────────

/**
 * Return true if the PR has been merged.
 * Queries GET /repos/{owner}/{repo}/pulls/{pull_number} and checks merged_at.
 */
async function isPRMerged(prNumber) {
  const url = `https://api.github.com/repos/${GITHUB_USERNAME}/${IDEA_MVPS_REPO}/pulls/${prNumber}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "idea-mvp-pipeline",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API PR check → ${res.status}: ${await res.text()}`);
  }
  const pr = await res.json();
  return Boolean(pr.merged_at);
}

// ─── Phase A: Resume in-flight pr_open cards ─────────────────────────────────

async function phaseA(state) {
  const prOpenCards = Object.entries(state.cards).filter(
    ([, entry]) => entry.state === "pr_open"
  );

  if (prOpenCards.length === 0) {
    console.log("  No in-flight PR cards to check.");
    return;
  }

  console.log(`  Found ${prOpenCards.length} card(s) with open PRs. Checking merge status…\n`);

  for (const [cardId, entry] of prOpenCards) {
    section(`Resuming: "${entry.name}" (${cardId})`);
    console.log(`  PR: ${entry.prUrl}`);

    let merged;
    try {
      merged = await isPRMerged(entry.prNumber);
    } catch (err) {
      console.warn(`  ⚠  Could not check PR status: ${err.message}. Skipping.`);
      continue;
    }

    if (!merged) {
      console.log("  PR is not yet merged — nothing to do this run.");
      continue;
    }

    console.log("  ✅ PR is merged! Prepending preview URL to description…");

    // Fetch the current card description and prepend the preview URL.
    const card = await trelloGet(`/cards/${cardId}`, { fields: "desc,idBoard" });
    const previewLine = `🔗 **Live preview:** ${entry.previewUrl}\n\n---\n\n`;
    const updatedDesc = previewLine + (card.desc ?? "");
    await write(
      `prepend preview URL to description of card ${cardId}`,
      () => updateCardDescription(cardId, updatedDesc)
    );

    // Attach the PR URL to the card.
    console.log("  Attaching PR URL…");
    await write(
      `attach PR URL to card ${cardId}`,
      () => trelloPost(`/cards/${cardId}/attachments`, {
        url: entry.prUrl,
        name: "MVP PR",
      })
    );

    // Add a "done" label (green) — keep the card in the Ideas list.
    console.log(`  Adding "done" label…`);
    const doneLabelId = await write(
      `ensure "done" label exists on board`,
      () => ensureLabel(card.idBoard, "done", "green"),
      "dry-run-done-label-id"
    );
    await write(
      `add "done" label to card ${cardId}`,
      () => trelloPost(`/cards/${cardId}/idLabels`, { value: doneLabelId })
    );

    entry.state = "done";
    entry.doneAt = new Date().toISOString();
    saveState(state);
    console.log(`  Card ${cardId} marked done.`);
  }
}

// ─── Phase B/C: Process new cards ────────────────────────────────────────────

async function processSingleCard(card, state, mvpBuildingLabelId) {
  const cardId = card.id;
  const slug = toSlug(card.name);

  section(`Processing: "${card.name}" → slug: ${slug}`);

  // ── Step 1: Add "mvp-building" label + checkpoint ────────────────────────
  console.log("  [1/4] Adding mvp-building label…");
  await write(
    `add "mvp-building" label to card ${cardId}`,
    () => addLabelToCard(cardId, mvpBuildingLabelId)
  );

  state.cards[cardId] = {
    slug,
    name: card.name,
    state: "building",
    startedAt: new Date().toISOString(),
    mvpBuildingLabelId,
  };
  saveState(state);
  console.log("  Checkpoint saved (state: building).");

  // ── Step 2: Expand idea ──────────────────────────────────────────────────
  console.log("\n  [2/4] Expanding idea via Claude API…");
  let expansion;
  try {
    expansion = await expandIdea(card.name, card.desc ?? "");
  } catch (err) {
    console.error(`  ❌ expand failed: ${err.message}`);
    console.error("  Leaving card in 'building' state — will need manual cleanup.");
    return;
  }

  const markdown = formatCardDescription(expansion);

  // ── Step 3: Write description ────────────────────────────────────────────
  console.log("\n  [3/4] Writing formatted description to Trello…");
  await write(
    `update description on card ${cardId}`,
    () => updateCardDescription(cardId, markdown)
  );

  // ── Step 4: Build MVP ────────────────────────────────────────────────────
  console.log("\n  [4/4] Building MVP prototype…");
  let prUrl, previewUrl;
  try {
    ({ prUrl, previewUrl } = await write(
      `build MVP for slug "${slug}" and open PR`,
      () => buildMvp(slug, expansion.mvp_build_prompt),
      // dry-run mock:
      {
        prUrl: `https://github.com/${GITHUB_USERNAME}/${IDEA_MVPS_REPO}/pull/0`,
        previewUrl: `https://${GITHUB_USERNAME}.github.io/${IDEA_MVPS_REPO}/${slug}/`,
      }
    ));
  } catch (err) {
    console.error(`  ❌ build failed: ${err.message}`);
    console.error("  Leaving card in 'building' state — will need manual cleanup.");
    return;
  }

  const prNumber = prNumberFromUrl(prUrl);

  // Update state to pr_open.
  state.cards[cardId] = {
    ...state.cards[cardId],
    state: "pr_open",
    prUrl,
    prNumber,
    previewUrl,
    prOpenedAt: new Date().toISOString(),
  };
  saveState(state);

  console.log(`\n  ✅ Done. PR: ${prUrl}`);
  console.log(`     Preview (after merge): ${previewUrl}`);
}

async function phaseBC(state) {
  let newCards;
  try {
    newCards = await getNewCards();
  } catch (err) {
    console.error(`  ❌ Failed to fetch Trello cards: ${err.message}`);
    return;
  }

  if (newCards.length === 0) {
    console.log("  No new cards to process.");
    return;
  }

  console.log(`  Found ${newCards.length} new card(s) to process.\n`);

  // Warn about any cards stuck in 'building' (orphaned from a crash).
  const orphans = Object.entries(state.cards).filter(
    ([, e]) => e.state === "building"
  );
  if (orphans.length > 0) {
    console.warn(
      `  ⚠  ${orphans.length} card(s) stuck in 'building' state (orphaned build):`
    );
    for (const [id, e] of orphans) {
      console.warn(`     ${id} — "${e.name}" (started: ${e.startedAt})`);
    }
    console.warn("     These will need manual investigation.\n");
  }

  // Get (or create) the mvp-building label once for the entire run.
  let mvpBuildingLabelId;
  try {
    mvpBuildingLabelId = await write(
      `ensure "mvp-building" label exists on board`,
      () => ensureMvpBuildingLabel(TRELLO_IDEAS_LIST_ID),
      "dry-run-label-id"
    );
  } catch (err) {
    console.error(`  ❌ Could not ensure mvp-building label: ${err.message}`);
    return;
  }

  for (const card of newCards) {
    // Skip cards already tracked in state (they have a label but state file
    // is the ground truth for resumability).
    if (state.cards[card.id] && state.cards[card.id].state !== "done") {
      console.log(`  Skipping ${card.id} ("${card.name}") — already in state as "${state.cards[card.id].state}".`);
      continue;
    }
    await processSingleCard(card, state, mvpBuildingLabelId);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

banner(`idea-mvp-pipeline  ${DRY_RUN ? "[DRY RUN]" : ""}  ${new Date().toISOString()}`);

const state = loadState();

section("Phase A — Check in-flight PRs");
await phaseA(state);

section("Phase B/C — Process new cards");
await phaseBC(state);

banner("Run complete.");
