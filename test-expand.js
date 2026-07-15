/**
 * Sanity-check script for the idea-expansion step.
 *
 * Usage:
 *   npm run test-expand
 *   node test-expand.js
 *   node test-expand.js path/to/other-idea.txt
 *
 * The idea file should be a JSON text file with "name" and "desc" fields:
 *   { "name": "My App Idea", "desc": "Longer description here..." }
 */

import "dotenv/config";
import { readFileSync } from "fs";
import { expandIdea, formatCardDescription } from "./expand.js";

const ideaFile = process.argv[2] ?? "./sample-idea.txt";

let idea;
try {
  idea = JSON.parse(readFileSync(ideaFile, "utf8"));
} catch (err) {
  console.error(`Failed to read or parse idea file "${ideaFile}": ${err.message}`);
  process.exit(1);
}

if (!idea.name) {
  console.error('Idea file must have a "name" field.');
  process.exit(1);
}

console.log(`\nExpanding idea: "${idea.name}"\n`);
console.log("─".repeat(60));

const expansion = await expandIdea(idea.name, idea.desc ?? "");

console.log("\n=== Raw JSON from API ===\n");
console.log(JSON.stringify(expansion, null, 2));

console.log("\n=== Formatted Trello Card Description ===\n");
console.log(formatCardDescription(expansion));
