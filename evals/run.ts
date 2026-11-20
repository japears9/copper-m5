// Module 5: runs the golden set as a Langfuse experiment, once per
// architecture (the two agents, and the single support agent). For each
// question it asks Ask Copper, then scores the answer:
//   - judge / judge_score: the AI judge's verdict (evals/judge.ts)
//   - checks: code checks on the tools and the agent that answered
//   - pass: both
//   - latency_s / cost_usd: how long the answer took and what it cost
// Every answer is a trace in Langfuse, and each run shows up under
// Datasets > copper-golden-set, where runs can be compared side by side.
// Without Langfuse keys it still runs and prints the scores.
import { LangfuseClient } from "@langfuse/client";
import { onAiCall, type AiCallRow } from "@/lib/ai/call";
import { finalValue } from "@/lib/ai/live";
import { defaultModel } from "@/lib/ai/models";
import {
  flushTracing,
  isTracingConfigured,
  startTracing,
} from "@/lib/ai/tracing";
import { askCopper } from "@/lib/copper/assistant/ask";
import {
  type Architecture,
  toolCallsOf,
} from "@/lib/copper/assistant/progress";
import { DEFAULT_LIMIT_USD } from "@/lib/copper/orders";
import { GOLDEN_SET, type GoldenCase } from "@/evals/golden-set";
import { judge, type Verdict } from "@/evals/judge";

export const DATASET = "copper-golden-set";

export type CaseOutput = {
  reply: string;
  answeredBy: string;
  handoffs: number;
  tools: { name: string; input?: unknown; output?: unknown }[];
  status: string;
  latencyMs: number;
  costUsd: number;
  modelCalls: number;
  traceId?: string;
};

export type CaseResult = {
  id: string;
  category: string;
  pass: boolean;
  verdict: Verdict;
  checks: string[];
  output: CaseOutput;
};

export type RunSummary = {
  architecture: Architecture;
  runName: string;
  passRate: number;
  passed: number;
  total: number;
  avgLatencyS: number;
  totalCostUsd: number;
  avgCostUsd: number;
  avgModelCalls: number;
  results: CaseResult[];
  datasetRunUrl?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PAUSE_MS = Number(process.env.EVAL_PAUSE_MS ?? 3000);

/** Asks Ask Copper one golden question, retrying if Gemini is busy. */
export async function answer(
  testCase: GoldenCase,
  architecture: Architecture,
): Promise<CaseOutput> {
  let last: CaseOutput | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(15_000 * attempt);
    const calls: AiCallRow[] = [];
    const stop = onAiCall((row) => calls.push(row));
    const started = performance.now();
    const { progress, traceId } = await askCopper({
      messages: [{ role: "user", content: testCase.question }],
      useTools: true,
      desk: {
        limitUsd: testCase.limitUsd ?? DEFAULT_LIMIT_USD,
        refunds: testCase.refunds ?? [],
      },
      architecture,
      tags: ["eval", testCase.id],
    });
    const final = await finalValue(progress);
    stop();
    last = {
      reply: final.reply,
      answeredBy: final.agent ?? "copper",
      handoffs: final.steps.filter((s) => s.type === "handoff").length,
      tools: toolCallsOf(final).filter((t) => !t.name.startsWith("transfer_")),
      status: final.status,
      latencyMs: Math.round(performance.now() - started),
      costUsd: calls.reduce((sum, c) => sum + (c.cost_usd ?? 0), 0),
      modelCalls: calls.filter((c) => c.model !== "google/gemini-embedding-2")
        .length,
      traceId,
    };
    if (final.status === "done") return last;
  }
  return last!;
}

/** Code checks: the right tools, the right order, the right agent. */
export function check(
  testCase: GoldenCase,
  architecture: Architecture,
  output: CaseOutput,
): string[] {
  const problems: string[] = [];
  const used = output.tools.map((t) => t.name);
  if (output.status !== "done") problems.push(`status ${output.status}`);
  for (const tool of testCase.expect.tools ?? [])
    if (!used.includes(tool)) problems.push(`didn't call ${tool}`);
  for (const tool of testCase.expect.notTools ?? [])
    if (used.includes(tool)) problems.push(`called ${tool}`);
  const refunded = output.tools
    .filter((t) => t.name === "request_refund")
    .map((t) =>
      String((t.input as { orderId?: string })?.orderId ?? "").replace("#", ""),
    );
  if (
    testCase.expect.refundOrder &&
    refunded.some((id) => id !== testCase.expect.refundOrder)
  )
    problems.push(`requested a refund for order ${refunded.join(", ")}`);
  const expectedAgent =
    architecture === "single-agent"
      ? "support"
      : testCase.expect.refundWork
        ? "refund"
        : "copper";
  if (output.answeredBy !== expectedAgent)
    problems.push(`answered by ${output.answeredBy}, not ${expectedAgent}`);
  return problems;
}

async function grade(
  testCase: GoldenCase,
  output: CaseOutput,
): Promise<Verdict> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await judge(testCase, output.reply, output.tools);
    } catch (error) {
      if (attempt >= 2)
        return {
          reason: `The judge couldn't run: ${error instanceof Error ? error.message : String(error)}`,
          score: 1,
          pass: false,
        };
      await sleep(15_000 * (attempt + 1));
    }
  }
}

function summarize(
  architecture: Architecture,
  runName: string,
  results: CaseResult[],
): RunSummary {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const totalCostUsd = results.reduce((s, r) => s + r.output.costUsd, 0);
  return {
    architecture,
    runName,
    passRate: total ? passed / total : 0,
    passed,
    total,
    avgLatencyS:
      results.reduce((s, r) => s + r.output.latencyMs, 0) / 1000 / (total || 1),
    totalCostUsd,
    avgCostUsd: totalCostUsd / (total || 1),
    avgModelCalls:
      results.reduce((s, r) => s + r.output.modelCalls, 0) / (total || 1),
    results,
  };
}

/** Creates or updates the golden set as a Langfuse dataset. */
async function syncDataset(langfuse: LangfuseClient) {
  try {
    await langfuse.api.datasets.get(DATASET);
  } catch {
    await langfuse.api.datasets.create({
      name: DATASET,
      description:
        "Ask Copper golden set (Module 5): support questions and what a good answer does. Source: evals/golden-set.ts",
    });
  }
  for (const c of GOLDEN_SET) {
    await langfuse.api.datasetItems.create({
      datasetName: DATASET,
      id: c.id,
      input: {
        question: c.question,
        limitUsd: c.limitUsd ?? DEFAULT_LIMIT_USD,
        refunds: c.refunds ?? [],
      },
      expectedOutput: c.goodAnswer,
      metadata: { category: c.category, expect: c.expect },
    });
  }
}

export async function runGoldenSet(
  architectures: Architecture[],
  { label = new Date().toISOString().slice(0, 16) } = {},
): Promise<RunSummary[]> {
  const ids = process.env.EVAL_CASES?.split(",").map((s) => s.trim());
  const cases = ids ? GOLDEN_SET.filter((c) => ids.includes(c.id)) : GOLDEN_SET;
  const byId = new Map(cases.map((c) => [c.id, c]));
  const summaries: RunSummary[] = [];
  const traced = isTracingConfigured();
  const langfuse = traced ? new LangfuseClient() : undefined;
  startTracing();
  if (langfuse) {
    await syncDataset(langfuse);
  } else {
    console.warn(
      "Langfuse keys aren't set: running the evals without sending scores to Langfuse.",
    );
  }

  for (const architecture of architectures) {
    const runName = `${architecture} ${label}`;
    const results: CaseResult[] = [];

    const task = async (testCase: GoldenCase) => {
      const output = await answer(testCase, architecture);
      const verdict = await grade(testCase, output);
      const checks = check(testCase, architecture, output);
      const result: CaseResult = {
        id: testCase.id,
        category: testCase.category,
        pass: verdict.pass && checks.length === 0,
        verdict,
        checks,
        output,
      };
      results.push(result);
      console.info(
        `${result.pass ? "PASS" : "FAIL"} ${architecture} ${testCase.id}: ${verdict.reason}${checks.length ? ` [checks: ${checks.join("; ")}]` : ""}`,
      );
      await sleep(PAUSE_MS);
      return result;
    };

    if (langfuse) {
      const dataset = await langfuse.dataset.get(DATASET);
      const result = await dataset.runExperiment({
        name: `Ask Copper ${architecture}`,
        runName,
        description: `Golden set on the ${architecture === "multi-agent" ? "two agents (Copper hands refunds to the Refund agent)" : "single support agent (every tool, no handoff)"}.`,
        metadata: {
          architecture,
          model: defaultModel(),
          commit:
            (process.env.EVAL_COMMIT || process.env.GITHUB_SHA) ?? "local",
        },
        maxConcurrency: 1,
        task: async (item) => {
          const c = byId.get((item as { id?: string }).id ?? "");
          if (!c) return { skipped: true };
          const r = await task(c);
          return { reply: r.output.reply, answeredBy: r.output.answeredBy };
        },
        evaluators: [
          async ({ output }) => {
            if (!output || (output as { skipped?: boolean }).skipped) return [];
            const r = results.at(-1)!;
            return [
              {
                name: "pass",
                value: r.pass ? 1 : 0,
                dataType: "BOOLEAN",
                comment: r.pass
                  ? r.verdict.reason
                  : [r.verdict.reason, ...r.checks].join(" | "),
              },
              {
                name: "judge",
                value: r.verdict.pass ? 1 : 0,
                dataType: "BOOLEAN",
                comment: r.verdict.reason,
              },
              {
                name: "judge_score",
                value: r.verdict.score,
                dataType: "NUMERIC",
                comment: r.verdict.reason,
              },
              {
                name: "checks",
                value: r.checks.length ? 0 : 1,
                dataType: "BOOLEAN",
                comment: r.checks.join("; ") || "all checks passed",
              },
              {
                name: "latency_s",
                value: r.output.latencyMs / 1000,
                dataType: "NUMERIC",
              },
              {
                name: "cost_usd",
                value: r.output.costUsd,
                dataType: "NUMERIC",
              },
            ];
          },
        ],
        runEvaluators: [
          async () => {
            const s = summarize(architecture, runName, results);
            return [
              {
                name: "pass_rate",
                value: s.passRate,
                comment: `${s.passed}/${s.total} passed`,
              },
              { name: "avg_latency_s", value: s.avgLatencyS },
              { name: "total_cost_usd", value: s.totalCostUsd },
              { name: "avg_cost_usd", value: s.avgCostUsd },
            ];
          },
        ],
      });
      const summary = summarize(architecture, runName, results);
      summary.datasetRunUrl = result.datasetRunUrl;
      summaries.push(summary);
    } else {
      for (const c of cases) await task(c);
      summaries.push(summarize(architecture, runName, results));
    }
  }

  await flushTracing();
  await langfuse?.flush();
  return summaries;
}

export function markdownReport(summaries: RunSummary[], minPassRate: number) {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const usd = (n: number) => `$${n.toFixed(5)}`;
  const lines = [
    "## Ask Copper evals (golden set, AI judge)",
    "",
    `Judge: ${defaultModel()} via lib/ai/call.ts. Merge gate: pass rate of the multi-agent app at least ${pct(minPassRate)}.`,
    "",
    "| Architecture | Pass rate | Avg time per answer | Avg cost per answer | Total cost | Agent runs per answer | Langfuse |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...summaries.map(
      (s) =>
        `| ${s.architecture} | **${pct(s.passRate)}** (${s.passed}/${s.total}) | ${s.avgLatencyS.toFixed(1)} s | ${usd(s.avgCostUsd)} | ${usd(s.totalCostUsd)} | ${s.avgModelCalls.toFixed(1)} | ${s.datasetRunUrl ? `[run](${s.datasetRunUrl})` : "-"} |`,
    ),
    "",
  ];
  for (const s of summaries) {
    lines.push(
      `<details><summary>${s.architecture}: every question</summary>`,
      "",
      "| Question | Result | Judge | Checks | Time | Cost |",
      "| --- | --- | --- | --- | --- | --- |",
      ...s.results.map(
        (r) =>
          `| ${r.id} | ${r.pass ? "✅ pass" : "❌ fail"} | ${r.verdict.score}/5: ${r.verdict.reason.replaceAll("|", "/").replaceAll("\n", " ")} | ${r.checks.join("; ") || "ok"} | ${(r.output.latencyMs / 1000).toFixed(1)} s | ${usd(r.output.costUsd)} |`,
      ),
      "",
      "</details>",
      "",
    );
  }
  return lines.join("\n");
}
