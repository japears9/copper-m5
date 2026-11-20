// Module 5: `npm run eval` runs this. It runs the golden set on the
// architectures in EVAL_ARCHITECTURES (default: both), writes the report to
// eval-report.md (and the GitHub Actions job summary), and fails when the
// multi-agent app's pass rate is below EVAL_MIN_PASS_RATE (default 0.8), so
// CI blocks the merge.
import { appendFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { Architecture } from "@/lib/copper/assistant/progress";
import { markdownReport, runGoldenSet } from "@/evals/run";

const architectures = (
  process.env.EVAL_ARCHITECTURES ?? "multi-agent,single-agent"
)
  .split(",")
  .map((a) => a.trim()) as Architecture[];
const minPassRate = Number(process.env.EVAL_MIN_PASS_RATE ?? 0.8);
const gated = (process.env.EVAL_GATE ?? "multi-agent").split(",");

it(
  "Ask Copper passes the golden set",
  { timeout: 60 * 60 * 1000 },
  async () => {
    const commit = process.env.EVAL_COMMIT || process.env.GITHUB_SHA;
    const label = commit
      ? `ci ${commit.slice(0, 7)}`
      : `local ${new Date().toISOString().slice(0, 16)}`;
    const summaries = await runGoldenSet(architectures, { label });
    const report = markdownReport(summaries, minPassRate);
    writeFileSync("eval-report.md", report);
    writeFileSync("eval-results.json", JSON.stringify(summaries, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
    console.info(`\n${report}`);
    for (const s of summaries.filter((s) => gated.includes(s.architecture)))
      expect(
        s.passRate,
        `${s.architecture} pass rate ${s.passed}/${s.total}`,
      ).toBeGreaterThanOrEqual(minPassRate);
  },
);
