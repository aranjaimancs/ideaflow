/**
 * build.js — MVP building step
 *
 * Takes a slug + mvp_build_prompt, clones/updates the idea-mvps GitHub repo,
 * runs the Claude Code agent to build the prototype, then opens a PR.
 *
 * Required env vars:
 *   GITHUB_TOKEN       — personal access token with repo scope
 *   GITHUB_USERNAME    — your GitHub username
 *   IDEA_MVPS_REPO     — repo name (e.g. "idea-mvps")
 *
 * Usage as a module:
 *   import { buildMvp } from "./build.js";
 *   const { prUrl, previewUrl } = await buildMvp("my-idea-slug", promptString);
 *
 * Usage as a CLI:
 *   node build.js <slug> [path-to-prompt-file]
 *   SLUG=my-idea MVP_PROMPT="build this" node build.js
 */

import "dotenv/config";
import { execSync, spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Environment validation ───────────────────────────────────────────────────

const { GITHUB_TOKEN, GITHUB_USERNAME, IDEA_MVPS_REPO } = process.env;

if (!GITHUB_TOKEN || !GITHUB_USERNAME || !IDEA_MVPS_REPO) {
  console.error(
    "build.js: missing required env vars — GITHUB_TOKEN, GITHUB_USERNAME, IDEA_MVPS_REPO"
  );
  process.exit(1);
}

// The workspace directory IS the cloned repo root.
const WORKSPACE = join(__dirname, "workspace");

// ─── Utility helpers ──────────────────────────────────────────────────────────

/** Print a top-level step banner. */
function step(n, msg) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`[${n}] ${msg}`);
  console.log("─".repeat(60));
}

/** Log a sub-step message. */
function log(msg) {
  console.log(`    ${msg}`);
}

/**
 * Run a shell command, printing it first (masking the GitHub token).
 * By default inherits stdio so output streams live to the console.
 * Pass capture:true to return stdout as a string instead.
 */
function exec(cmd, { cwd = WORKSPACE, capture = false } = {}) {
  // Mask any GitHub token embedded in HTTPS URLs (https://TOKEN@github.com).
  const display = cmd.replace(/https:\/\/[^@\s]+@github\.com/g, "https://***@github.com");
  console.log(`    $ ${display}`);
  return execSync(cmd, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
}

/** Authenticated HTTPS URL for the idea-mvps repo. */
function repoUrl() {
  return `https://${GITHUB_TOKEN}@github.com/${GITHUB_USERNAME}/${IDEA_MVPS_REPO}.git`;
}

// ─── Step 1: Clone or pull the repo ──────────────────────────────────────────

async function ensureRepo() {
  step(1, `Ensuring local clone of ${GITHUB_USERNAME}/${IDEA_MVPS_REPO} at ./workspace`);

  if (existsSync(join(WORKSPACE, ".git"))) {
    log("Repo already cloned. Fetching + resetting to origin/main...");
    exec(`git remote set-url origin "${repoUrl()}"`);
    exec("git fetch origin");
    exec("git checkout main");
    exec("git reset --hard origin/main");
  } else {
    log("Cloning repo into ./workspace ...");
    mkdirSync(WORKSPACE, { recursive: true });
    exec(`git clone "${repoUrl()}" .`);
  }

  // Always set git identity — git config exits with code 1 when unset,
  // which would throw. Simpler to just always write it.
  exec(`git config user.email "idea-pipeline@local"`);
  exec(`git config user.name "Idea Pipeline"`);

  // Keep the remote URL fresh so token rotation works across runs.
  exec(`git remote set-url origin "${repoUrl()}"`);
  log("✓ Repo ready.");
}

// ─── Step 2: Set up branch + slug directory ───────────────────────────────────

async function setupSlugDir(slug) {
  step(2, `Setting up branch '${slug}' and directory ./workspace/${slug}`);

  // Fetch remote branches so we can detect if this one already exists.
  exec("git fetch origin --prune", { capture: false });
  const remoteBranches = exec("git branch -r", { capture: true });
  const branchExistsRemotely = remoteBranches
    .split("\n")
    .some((b) => b.trim() === `origin/${slug}`);

  if (branchExistsRemotely) {
    log(`Branch 'origin/${slug}' exists remotely — checking it out.`);
    exec(`git checkout -B "${slug}" "origin/${slug}"`);
  } else {
    log(`Creating new branch '${slug}' from main.`);
    exec(`git checkout -B "${slug}"`);
  }

  const slugDir = join(WORKSPACE, slug);
  if (!existsSync(slugDir)) {
    mkdirSync(slugDir, { recursive: true });
    log(`Created ./workspace/${slug}`);
  } else {
    log(`Directory ./workspace/${slug} already exists.`);
  }

  return slugDir;
}

// ─── Step 3: Run the Claude Code agent ───────────────────────────────────────

/**
 * Wraps the user-supplied mvpBuildPrompt with operational constraints and
 * invokes the `claude` CLI non-interactively with streaming-JSON output.
 */
async function runClaudeAgent(slug, mvpBuildPrompt, slugDir) {
  step(3, `Running Claude Code agent in ./workspace/${slug}`);

  const agentPrompt = `
You are building a minimal MVP web prototype for a single idea. Your working directory is already set to the correct folder — build everything here and nowhere else.

===== WHAT TO BUILD =====

${mvpBuildPrompt}

===== HOW TO BUILD IT =====

1. Default to plain HTML + CSS + vanilla JavaScript. Use a single index.html as the entry point. The prototype must be fully viewable by opening index.html directly in a browser with no local server required.

2. Only reach for a Next.js static export if the idea genuinely requires client-side routing or React component composition. If you do use Next.js:
   - Bootstrap with: npx create-next-app@latest . --ts --tailwind --no-eslint --app --use-npm
   - Export with: npm run build (ensure "output": "export" is set in next.config.* and add a .nojekyll file)

3. Mock all data inline in JavaScript. Zero external API calls. No secrets. No back-end.

4. Keep it minimal. The goal is to make the core interaction tangible in under 30 seconds, not to build the full product. Skip auth, settings pages, help text, etc.

5. Create an empty file named .nojekyll in your working directory (prevents GitHub Pages from running Jekyll on the output).

6. Include a README.md that describes:
   - What was built and what the core interaction is
   - How to open / run it
   - What a user should do in the first 30 seconds to feel the value

Begin building now. Create the files.
`.trim();

  log("Invoking: claude --print --output-format stream-json");
  log("(streaming agent events below)\n");

  await new Promise((resolve, reject) => {
    // Pass the prompt via stdin to avoid Windows cmd.exe's ~8 KB argument
    // length limit, which silently truncates long prompts when shell:true.
    const proc = spawn(
      "claude",
      [
        "--print",
        "--verbose",
        "--output-format", "stream-json",
        "--permission-mode", "bypassPermissions",
        "--max-budget-usd", "2",
        // "--bare" is for CI only (API-key-only auth, no keychain).
        ...(process.env.CI ? ["--bare"] : []),
      ],
      {
        cwd: slugDir,
        // Pass only what the agent needs — don't expose Trello/GitHub tokens.
        env: {
          ...process.env,
          TRELLO_KEY: undefined,
          TRELLO_TOKEN: undefined,
          TRELLO_IDEAS_LIST_ID: undefined,
          TRELLO_DONE_LIST_ID: undefined,
          GITHUB_TOKEN: undefined,
          GITHUB_USERNAME: undefined,
          IDEA_MVPS_REPO: undefined,
        },
        shell: true,   // needed on Windows so PATH resolves correctly
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    // Write prompt to stdin and close it so claude knows input is complete.
    proc.stdin.write(agentPrompt, "utf8");
    proc.stdin.end();

    let lineBuffer = "";

    proc.stdout.on("data", (chunk) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop(); // hold the (possibly incomplete) last fragment

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          logAgentEvent(JSON.parse(line));
        } catch {
          // Not JSON — pass through raw.
          console.log("  ·", line);
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString().trimEnd();
      if (text) console.error("  [stderr]", text);
    });

    proc.on("close", (code) => {
      // Flush any trailing buffered content.
      if (lineBuffer.trim()) {
        try {
          logAgentEvent(JSON.parse(lineBuffer));
        } catch {
          console.log("  ·", lineBuffer);
        }
      }
      code === 0 ? resolve() : reject(new Error(`claude exited with code ${code}`));
    });

    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            'claude CLI not found in PATH. Install Claude Code from https://claude.ai/code\n' +
            'After installing, run: claude --version'
          )
        );
      } else {
        reject(err);
      }
    });
  });

  log("\n✓ Agent finished.");
}

/**
 * Pretty-print a single stream-json event from the claude CLI.
 *
 * The stream emits newline-delimited JSON with these event types:
 *   system   — initialisation metadata (session_id, tool list)
 *   assistant — Claude's response (text blocks + tool_use blocks)
 *   user      — tool results fed back to the model
 *   result    — final summary (cost, duration, exit status)
 */
function logAgentEvent(event) {
  switch (event.type) {
    case "system": {
      if (event.subtype === "init") {
        const tools = (event.tools ?? []).join(", ");
        console.log(`  [init] session=${event.session_id ?? "?"} tools=[${tools}]`);
      } else {
        console.log(`  [system:${event.subtype ?? "?"}]`, JSON.stringify(event).slice(0, 120));
      }
      break;
    }

    case "assistant": {
      const blocks = event.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === "text" && block.text?.trim()) {
          for (const line of block.text.trim().split("\n")) {
            console.log("  🤖", line);
          }
        } else if (block.type === "tool_use") {
          const inputPreview = JSON.stringify(block.input ?? {});
          console.log(
            `  🔧 ${block.name}(${inputPreview.slice(0, 140)}${inputPreview.length > 140 ? "…" : ""})`
          );
        }
      }
      break;
    }

    case "user": {
      // Tool results coming back in — just show a compact summary.
      const blocks = event.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === "tool_result") {
          const content = Array.isArray(block.content)
            ? block.content.map((c) => c.text ?? "").join("")
            : String(block.content ?? "");
          const preview = content.slice(0, 100).replace(/\n/g, "↵");
          console.log(`  ✓  [tool_result] ${preview}${content.length > 100 ? "…" : ""}`);
        }
      }
      break;
    }

    case "result": {
      const ok = !event.is_error;
      const cost = event.total_cost_usd != null ? ` cost=$${event.total_cost_usd.toFixed(4)}` : "";
      const dur = event.duration_ms != null ? ` dur=${(event.duration_ms / 1000).toFixed(1)}s` : "";
      console.log(`\n  ${ok ? "✅" : "❌"} result: ${event.subtype ?? ""}${dur}${cost}`);
      if (event.result?.trim()) {
        for (const line of event.result.trim().split("\n")) {
          console.log("     ", line);
        }
      }
      break;
    }

    default: {
      console.log(`  [${event.type}]`, JSON.stringify(event).slice(0, 140));
    }
  }
}

// ─── Step 4: Commit and push ──────────────────────────────────────────────────

async function commitAndPush(slug) {
  step(4, `Committing ./workspace/${slug} and pushing to origin/${slug}`);

  const status = exec(`git status --porcelain "${slug}"`, { capture: true });
  if (!status.trim()) {
    log("⚠  No changes detected in the slug directory.");
    log("   The agent may not have created files. Proceeding with an empty commit.");
    // Empty commit so the branch and PR still exist for inspection.
    exec(`git commit --allow-empty -m "feat(${slug}): placeholder — agent produced no files"`);
  } else {
    exec(`git add "${slug}"`);
    exec(`git commit -m "feat(${slug}): add MVP prototype"`);
  }

  // Rebase onto the latest main so there are no conflicts when the PR merges.
  exec("git fetch origin main");
  try {
    exec("git rebase origin/main");
  } catch (e) {
    exec("git rebase --abort");
    throw new Error(`Rebase onto origin/main failed for "${slug}": ${e.message}`);
  }

  exec(`git push -u origin "${slug}" --force-with-lease`);
  log("✓ Pushed.");
}

// ─── Step 5: Create or update PR ─────────────────────────────────────────────

async function createOrUpdatePR(slug, mvpBuildPrompt) {
  step(5, `Creating/updating pull request for branch '${slug}'`);

  const apiBase = `https://api.github.com/repos/${GITHUB_USERNAME}/${IDEA_MVPS_REPO}`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "idea-mvp-pipeline",
  };

  // Check for an existing open PR on this branch.
  const listRes = await fetch(
    `${apiBase}/pulls?head=${GITHUB_USERNAME}:${encodeURIComponent(slug)}&state=open`,
    { headers }
  );
  if (!listRes.ok) {
    throw new Error(`GitHub API list-PRs error: ${listRes.status} ${await listRes.text()}`);
  }
  const existing = await listRes.json();

  if (existing.length > 0) {
    log(`Existing PR found: ${existing[0].html_url}`);
    return existing[0].html_url;
  }

  // Build the PR body.
  const promptExcerpt =
    mvpBuildPrompt.length > 600
      ? mvpBuildPrompt.slice(0, 600) + "…"
      : mvpBuildPrompt;

  const prBody = [
    `## MVP Prototype: \`${slug}\``,
    "",
    "Built automatically by the idea-mvp-pipeline agent.",
    "",
    "### Build prompt",
    "",
    "```",
    promptExcerpt,
    "```",
    "",
    "### Preview URL (live after merge + Pages build)",
    "",
    `🔗 https://${GITHUB_USERNAME}.github.io/${IDEA_MVPS_REPO}/${slug}/`,
    "",
    "---",
    "",
    "*Review the generated files before merging. Delete the branch after merge.*",
  ].join("\n");

  const createRes = await fetch(`${apiBase}/pulls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: `MVP: ${slug}`,
      head: slug,
      base: "main",
      body: prBody,
    }),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`GitHub API create-PR error: ${createRes.status} ${errText}`);
  }

  const pr = await createRes.json();
  log(`✓ PR created: ${pr.html_url}`);

  // GitHub computes mergeability asynchronously — poll until it's settled.
  log("Waiting for GitHub to compute mergeability…");
  let mergeable = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    const checkRes = await fetch(`${apiBase}/pulls/${pr.number}`, { headers });
    if (!checkRes.ok) break;
    const checkPr = await checkRes.json();
    if (checkPr.mergeable !== null) {
      mergeable = checkPr.mergeable;
      break;
    }
    log(`  mergeability still computing… (${attempt + 1}/12)`);
  }
  if (mergeable === false) {
    throw new Error(`PR #${pr.number} has merge conflicts even after rebase — manual inspection needed: ${pr.html_url}`);
  }

  // Auto-merge the PR via squash merge.
  log(`Auto-merging PR #${pr.number}…`);
  const mergeRes = await fetch(`${apiBase}/pulls/${pr.number}/merge`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      merge_method: "squash",
      commit_title: `feat(${slug}): add MVP prototype (#${pr.number})`,
    }),
  });
  if (!mergeRes.ok) {
    const errText = await mergeRes.text();
    throw new Error(`Auto-merge failed (${mergeRes.status}): ${errText}\nPR is open at ${pr.html_url} — merge it manually to continue.`);
  }
  log(`✓ PR auto-merged.`);

  return pr.html_url;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Full pipeline: clone/pull → branch → agent build → commit/push → PR.
 *
 * @param {string} slug          - kebab-case identifier (e.g. "invoice-tracker")
 * @param {string} mvpBuildPrompt - the build paragraph from expand.js
 * @returns {Promise<{ prUrl: string, previewUrl: string }>}
 */
export async function buildMvp(slug, mvpBuildPrompt) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  build.js — starting MVP build for "${slug}"`);
  console.log(`${"═".repeat(60)}`);

  await ensureRepo();
  const slugDir = await setupSlugDir(slug);
  await runClaudeAgent(slug, mvpBuildPrompt, slugDir);
  await commitAndPush(slug);

  const prUrl = await createOrUpdatePR(slug, mvpBuildPrompt);
  const previewUrl = `https://${GITHUB_USERNAME}.github.io/${IDEA_MVPS_REPO}/${slug}/`;

  console.log(`\n${"═".repeat(60)}`);
  console.log("  ✅  All done.");
  console.log(`      PR:      ${prUrl}`);
  console.log(`      Preview: ${previewUrl}`);
  console.log(`               (resolves after merge + GitHub Pages build)`);
  console.log(`${"═".repeat(60)}\n`);

  return { prUrl, previewUrl };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────
//
// node build.js <slug> [prompt-file]
// SLUG=my-idea MVP_PROMPT="build this" node build.js

if (process.argv[1] === __filename) {
  const slug = process.argv[2] ?? process.env.SLUG;

  let mvpBuildPrompt;
  if (process.argv[3]) {
    mvpBuildPrompt = readFileSync(process.argv[3], "utf8").trim();
  } else if (process.env.MVP_PROMPT) {
    mvpBuildPrompt = process.env.MVP_PROMPT;
  }

  if (!slug || !mvpBuildPrompt) {
    console.error(
      "Usage:\n" +
      "  node build.js <slug> <prompt-file>\n" +
      "  SLUG=my-idea MVP_PROMPT='build this' node build.js"
    );
    process.exit(1);
  }

  await buildMvp(slug, mvpBuildPrompt);
}
