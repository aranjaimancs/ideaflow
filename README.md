# idea-mvp-pipeline

An agentic pipeline that turns Trello idea cards into live MVP prototypes — fully automated.

**Add a card → wait ~15 minutes → get a live website link back in the card.**

Under the hood it:
1. Watches a Trello list for new cards
2. Evaluates and expands the idea using Claude (problem, target user, core features, build prompt)
3. Writes the structured analysis back to the Trello card description
4. Invokes Claude Code to build a static HTML/JS prototype
5. Commits the prototype, opens a PR, and auto-merges it
6. Detects the merge, adds the live preview URL to the card, and labels it "done"

GitHub Pages hosts every prototype automatically at `https://<you>.github.io/<repo>/<slug>/`.

---

## Two repos, one pipeline

This project uses **two separate GitHub repositories**:

| Repo | Purpose |
|---|---|
| `idea-mvp-pipeline` (this repo) | The brains — all the automation code, GitHub Actions workflow, and state tracking. You set this up once and leave it running. |
| `idea-mvps` (you create this) | The output — every prototype gets committed here as a subfolder. GitHub Pages serves it as a live website. |

**Why separate?** The prototypes repo stays clean — just static files, no pipeline code — so GitHub Pages can serve it with no build step. Anyone can browse your `idea-mvps` repo and see every prototype that's ever been built, each at its own URL (`https://<you>.github.io/idea-mvps/<slug>/`).

---

## Prerequisites

- Node.js 18+
- A [Trello](https://trello.com) account with a board set up
- An [Anthropic API key](https://console.anthropic.com/settings/keys)
- A GitHub account with two repos:
  - This pipeline repo (where you're reading this)
  - A prototypes repo (e.g. `idea-mvps`) with GitHub Pages enabled
- [Claude Code CLI](https://claude.ai/code) installed (`npm install -g @anthropic-ai/claude-code`)

---

## Setup

### 1. Clone this repo

```bash
git clone https://github.com/<you>/idea-mvp-pipeline.git
cd idea-mvp-pipeline
npm install
```

### 2. Create the prototypes repo on GitHub

Create a new empty GitHub repo (e.g. `idea-mvps`) and enable GitHub Pages:
- **Settings → Pages → Source:** Deploy from branch `main`, folder `/ (root)`

Add a `.nojekyll` file to the root of that repo so GitHub Pages doesn't run Jekyll:
```bash
# In the idea-mvps repo
touch .nojekyll
git add .nojekyll && git commit -m "add .nojekyll" && git push
```

### 3. Get your Trello credentials

1. Go to [trello.com/power-ups/admin](https://trello.com/power-ups/admin) → create a Power-Up
2. Click **API key** in the sidebar → copy your key
3. Click the **Token** link → authorize → copy the token

**Find your list IDs** — append `.json` to your board URL and search for `"lists"`, or run:
```bash
curl "https://api.trello.com/1/boards/<BOARD_ID>/lists?fields=id,name&key=<KEY>&token=<TOKEN>"
```

### 4. Create a GitHub Personal Access Token

Go to **GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)**:
- Check the **`repo`** scope
- Copy the generated token

### 5. Configure environment variables

```bash
cp .env.example .env
```

Fill in `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-...
TRELLO_KEY=your_trello_api_key
TRELLO_TOKEN=your_trello_token
TRELLO_IDEAS_LIST_ID=the_list_id_to_watch
TRELLO_DONE_LIST_ID=the_list_id_to_move_done_cards_to
GITHUB_TOKEN=ghp_your_personal_access_token
GITHUB_USERNAME=your_github_username
IDEA_MVPS_REPO=idea-mvps
```

### 6. Validate your setup

```bash
npm run setup
```

This checks that all env vars are set and that your Trello and GitHub credentials work.

### 7. Run it

```bash
npm start          # live run
npm run dry-run    # preview what would happen — no writes
```

---

## GitHub Actions automation (runs every 15 minutes)

Push this repo to GitHub, then add the following secrets under **Settings → Secrets and variables → Actions**:

| Secret name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `TRELLO_KEY` | Trello API key |
| `TRELLO_TOKEN` | Trello token |
| `TRELLO_IDEAS_LIST_ID` | ID of the list to watch |
| `TRELLO_DONE_LIST_ID` | ID of the done list |
| `PIPELINE_GITHUB_TOKEN` | Your GitHub PAT (repo scope) |
| `GH_USERNAME` | Your GitHub username |
| `IDEA_MVPS_REPO` | Name of the prototypes repo (e.g. `idea-mvps`) |

> Note: GitHub reserves the `GITHUB_` prefix for its own secrets, so the PAT is stored as `PIPELINE_GITHUB_TOKEN` and the username as `GH_USERNAME`.

Once secrets are set, the workflow runs automatically every 15 minutes. You can also trigger it manually from the **Actions** tab → **Idea MVP Pipeline** → **Run workflow**.

---

## How it works

```
Trello card added
       ↓
Pipeline run (every 15 min)
       ↓
Idea expanded by Claude → written to card description
       ↓
Claude Code builds static HTML/JS prototype
       ↓
PR opened → auto-merged
       ↓
GitHub Pages deploys (~1 min)
       ↓
Preview URL added to card description
"done" label added to card
```

### Card lifecycle

| Trello label | Meaning |
|---|---|
| *(none)* | New — will be picked up on next run |
| `mvp-building` (purple) | Pipeline is working on this card |
| `done` (green) | Prototype is live, preview URL is in the description |

### State file

`pipeline-state.json` tracks in-progress cards across runs (PR URLs, numbers, timestamps). It is gitignored and committed back by the Actions workflow after each run. If a card gets stuck with the `mvp-building` label, remove the label from the card in Trello — the pipeline will pick it up fresh on the next run.

---

## Project structure

```
idea-mvp-pipeline/
├── run.js          # Orchestrator — runs the full pipeline
├── watch.js        # Fetches unprocessed cards from Trello
├── expand.js       # Expands idea via Claude API
├── build.js        # Builds MVP via Claude Code, opens PR
├── updateCard.js   # Writes results back to Trello
├── .env.example    # Environment variable template
└── .github/
    └── workflows/
        └── pipeline.yml   # GitHub Actions workflow
```

---

## License

MIT
