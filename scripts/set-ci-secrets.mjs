// Module 5: copies the keys CI needs from .env.local into this repo's GitHub
// Actions secrets with the GitHub CLI, without printing them.
// Run: npm run ci:secrets
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const NAMES = [
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
];

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => {
      const at = line.indexOf("=");
      return [
        line.slice(0, at),
        line
          .slice(at + 1)
          .trim()
          .replace(/^"|"$/g, ""),
      ];
    }),
);

// The student's own repo (origin), not the course repo.
const origin = spawnSync("git", ["remote", "get-url", "origin"], {
  encoding: "utf8",
}).stdout.trim();
const repo = origin.match(/github\.com[:/](.+?)(\.git)?$/)?.[1];
if (!repo) {
  console.error("Couldn't find this repo's GitHub origin.");
  process.exit(1);
}

let failed = false;
for (const name of NAMES) {
  if (!env[name]) {
    console.error(`${name} isn't in .env.local yet.`);
    failed = true;
    continue;
  }
  const result = spawnSync("gh", ["secret", "set", name, "--repo", repo], {
    input: env[name],
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) failed = true;
}
console.log(
  failed ? "Some secrets weren't set (see above)." : "CI secrets are set.",
);
process.exit(failed ? 1 : 0);
