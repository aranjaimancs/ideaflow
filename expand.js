import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Missing required env var: ANTHROPIC_API_KEY");
  process.exit(1);
}

const client = new Anthropic();

const MODEL = "claude-sonnet-5";

const SYSTEM_PROMPT = `You are a sharp, honest product advisor evaluating raw app and website ideas for a solo developer working on side projects.

Your job is to cut through excitement and give a clear-eyed assessment. You are NOT a cheerleader. Actively look for reasons an idea might not be worth pursuing: low differentiation, unclear target user, too much scope for a solo project, no obvious monetization path, saturated market, timing that doesn't matter, etc.

Return a single JSON object with exactly these fields:

- problem: 1-2 sentences describing the actual problem being solved. If the problem is vague or unclear, say so plainly.
- target_user: who feels this problem most acutely — be specific (not "everyone" or "developers"). If there is no clear target user, say so.
- why_now: is there a genuine reason this matters now vs any other time? Mention relevant trends, regulatory changes, new tech, etc. If there is no particular urgency, say exactly "No particular urgency."
- core_features: an array of 3-5 strings, ranked by importance, describing only what constitutes a true MVP. No nice-to-haves. Nothing that can be deferred.
- suggested_stack: a short technical recommendation for a fast, cheap MVP. Bias toward Next.js, TypeScript, Supabase, and static HTML/JS when even that suffices. Keep it to 1-3 sentences.
- worth_pursuing: an object with two fields:
    - verdict: exactly one of "yes", "maybe", or "probably not"
    - reasoning: 2-3 sentences of honest assessment. If verdict is "probably not", explain specifically why — don't soften it. If "yes" or "maybe", name the biggest risk or unknown.
- mvp_build_prompt: a single paragraph written as a prompt you would hand to a coding agent. Describe the minimal single-page or minimal Next.js app that makes this idea's core value testable by a real user. Be concrete about what gets built, what it looks like, and what interaction proves the concept works.

Respond with valid JSON only. No markdown fences, no explanation outside the JSON object.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    problem: { type: "string" },
    target_user: { type: "string" },
    why_now: { type: "string" },
    core_features: {
      type: "array",
      items: { type: "string" },
    },
    suggested_stack: { type: "string" },
    worth_pursuing: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["yes", "maybe", "probably not"] },
        reasoning: { type: "string" },
      },
      required: ["verdict", "reasoning"],
      additionalProperties: false,
    },
    mvp_build_prompt: { type: "string" },
  },
  required: [
    "problem",
    "target_user",
    "why_now",
    "core_features",
    "suggested_stack",
    "worth_pursuing",
    "mvp_build_prompt",
  ],
  additionalProperties: false,
};

/**
 * Calls the Anthropic API to expand a raw idea into a structured evaluation.
 * @param {string} name  - The card name / idea title
 * @param {string} desc  - The card description / idea details
 * @returns {Promise<object>} The parsed expansion object
 */
export async function expandIdea(name, desc) {
  const userMessage = `Evaluate this idea:

Title: ${name}

Description:
${desc || "(no description provided)"}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) {
    throw new Error("No text content in API response");
  }

  return JSON.parse(textBlock.text);
}

/**
 * Formats an expansion object into Markdown suitable for a Trello card description.
 * @param {object} expansion - The object returned by expandIdea()
 * @returns {string} Markdown string
 */
export function formatCardDescription(expansion) {
  const { verdict, reasoning } = expansion.worth_pursuing;
  const verdictLabel =
    verdict === "yes"
      ? "Yes"
      : verdict === "maybe"
        ? "Maybe"
        : "Probably Not";

  const featuresMarkdown = expansion.core_features
    .map((f, i) => `${i + 1}. ${f}`)
    .join("\n");

  return `## Problem
${expansion.problem}

## Target User
${expansion.target_user}

## Why Now
${expansion.why_now}

## Core MVP Features
${featuresMarkdown}

## Suggested Stack
${expansion.suggested_stack}

## Worth Pursuing: ${verdictLabel}
${reasoning}

## MVP Build Prompt
${expansion.mvp_build_prompt}`;
}
