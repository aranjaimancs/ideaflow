# idea-mvp-pipeline

Agentic pipeline that watches a Trello list and processes new idea cards.
Currently implements the **watcher** only — reads unprocessed cards and prints
them to stdout.

## Prerequisites

- Node.js 18 or later (uses native `fetch` and top-level `await`)

## Setup

```bash
npm install
cp .env.example .env
# Fill in the values in .env (see sections below)
```

## Running the watcher

```bash
npm run watch
```

Each unprocessed card is printed as a JSON object on its own line:

```json
{"id":"abc123","name":"My idea","desc":"A longer description"}
```

A card is considered **unprocessed** if it has no label named `processed`
(case-insensitive) attached to it.

---

## Getting a Trello API key and token

1. Log in to Trello, then go to <https://trello.com/power-ups/admin>.
2. Click **New** to create a Power-Up (the name doesn't matter — it's just a
   wrapper for your credentials).
3. On the Power-Up's page, click **API key** in the left sidebar. Copy the key
   into `TRELLO_KEY`.
4. On the same page, click the **Token** link next to your API key. Authorize
   the app and copy the token into `TRELLO_TOKEN`.

---

## Finding list IDs

### Option A — the `.json` trick

Append `.json` to any Trello board URL in your browser:

```
https://trello.com/b/BOARD_SHORT_ID/board-name.json
```

Search the JSON for `"lists"` to find every list and its `"id"`.

### Option B — Trello REST API

If you already have your key/token, fetch the lists for a board directly:

```bash
BOARD_ID=your_board_id

curl "https://api.trello.com/1/boards/${BOARD_ID}/lists?fields=id,name&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}"
```

The board ID is the short alphanumeric code in your board's URL
(`https://trello.com/b/<BOARD_ID>/...`).

Copy the `id` of the list you want to watch into `TRELLO_IDEAS_LIST_ID`, and
the destination list's `id` into `TRELLO_DONE_LIST_ID` (used in later pipeline
stages).

---

## Environment variables

| Variable | Description |
|---|---|
| `TRELLO_KEY` | Trello Power-Up API key |
| `TRELLO_TOKEN` | Trello user token (authorizes access to your boards) |
| `TRELLO_IDEAS_LIST_ID` | ID of the list to watch for new idea cards |
| `TRELLO_DONE_LIST_ID` | ID of the list to move cards to after processing (future use) |
| `ANTHROPIC_API_KEY` | Anthropic API key for the idea-expansion step |
| `GITHUB_TOKEN` | GitHub PAT with `repo` scope (see GitHub setup below) |
| `GITHUB_USERNAME` | Your GitHub username |
| `IDEA_MVPS_REPO` | Name of the target repo for MVP prototypes (e.g. `idea-mvps`) |

---

## Running the full pipeline

```bash
npm start          # live run — expands ideas, builds MVPs, updates Trello
npm run dry-run    # read-only preview — shows what would happen, no writes
```

`pipeline-state.json` is written to disk after each run. Commit it to the
repo so subsequent runs can resume in-flight cards.

---

## GitHub Actions automation

The workflow at `.github/workflows/pipeline.yml` runs the pipeline on a
15-minute schedule and commits `pipeline-state.json` back to the repo
automatically.

### Required GitHub secrets

Go to your repository → **Settings** → **Secrets and variables** → **Actions**
→ **New repository secret** and add each of these:

| Secret name | Value |
|---|---|
| `TRELLO_KEY` | Trello Power-Up API key |
| `TRELLO_TOKEN` | Trello user token |
| `TRELLO_IDEAS_LIST_ID` | ID of the ideas list |
| `TRELLO_DONE_LIST_ID` | ID of the done list |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `PIPELINE_GITHUB_TOKEN` | GitHub PAT with `repo` scope* |
| `GITHUB_USERNAME` | Your GitHub username |
| `IDEA_MVPS_REPO` | Name of the MVP prototypes repo (e.g. `idea-mvps`) |

> \* The built-in `GITHUB_TOKEN` in Actions cannot push to *other* repos, so
> the pipeline uses a Personal Access Token stored under the name
> `PIPELINE_GITHUB_TOKEN`. The workflow maps it to `GITHUB_TOKEN` in the job
> environment. Create a PAT at **GitHub → Settings → Developer settings →
> Personal access tokens → Fine-grained tokens** (or Classic tokens) with
> `repo` scope covering both this repo and the `idea-mvps` repo.

### Manually triggering the workflow

1. Open your repository on GitHub.
2. Click the **Actions** tab.
3. Select **Idea MVP Pipeline** from the left sidebar.
4. Click **Run workflow** (top-right of the workflow runs table).
5. Choose the branch (`main`) and optionally check **Dry run** to preview
   without making any writes.
6. Click **Run workflow** to confirm.
