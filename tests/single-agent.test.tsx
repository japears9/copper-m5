// Module 5: the single support agent (every tool, no handoff), the Langfuse
// tracing switch, and the eval's code checks. Mock model, so no AI key and no
// Langfuse keys.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { cleanup } from "@testing-library/react";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalValue } from "@/lib/ai/live";
import { toolCallsOf } from "@/lib/copper/assistant/progress";
import type { Desk } from "@/lib/copper/orders";
import { check, type CaseOutput } from "@/evals/run";
import { GOLDEN_SET } from "@/evals/golden-set";
import { isTracingConfigured } from "@/lib/ai/tracing";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];

const usage = {
  inputTokens: {
    total: 500,
    noCache: 500,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};

const finish = (reason: "stop" | "tool-calls"): StreamPart => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage,
});

const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];

// Every call uses the id "call-1", as a real model may for each agent.
const calls = (toolName: string, input: unknown): StreamPart[] => [
  { type: "tool-input-start", id: "call-1", toolName },
  { type: "tool-input-end", id: "call-1" },
  {
    type: "tool-call",
    toolCallId: "call-1",
    toolName,
    input: JSON.stringify(input),
  },
  finish("tool-calls"),
];

function modelStreaming(...steps: StreamPart[][]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[step++] ?? says("")),
    }),
  });
}

const desk = (limitUsd = 50, refunds: Desk["refunds"] = []): Desk => ({
  limitUsd,
  refunds,
});

async function ask(
  request: Parameters<typeof import("@/lib/copper/assistant/ask").askCopper>[0],
) {
  vi.resetModules();
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  const { askCopper } = await import("@/lib/copper/assistant/ask");
  return finalValue((await askCopper(request)).progress);
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the single support agent (Module 5)", () => {
  it("handles a refund itself, with every tool and no handoff", async () => {
    model = modelStreaming(
      calls("request_refund", { orderId: "1001" }),
      says("Done: $7.99 is refunded to your original payment."),
    );
    const result = await ask({
      messages: [{ role: "user", content: "Refund order #1001" }],
      useTools: true,
      desk: desk(50),
      architecture: "single-agent",
    });
    expect(result.status).toBe("done");
    expect(result.agent).toBe("support");
    expect(result.steps.some((s) => s.type === "handoff")).toBe(false);
    expect(toolCallsOf(result)[0].output).toMatchObject({
      status: "refunded",
      amountUsd: 7.99,
    });
    expect(model.doStreamCalls).toHaveLength(2);
    const tools = model.doStreamCalls[0].tools?.map((t) => t.name).sort();
    expect(tools).toEqual([
      "calculate_cost",
      "check_availability",
      "get_orders",
      "get_prices",
      "get_products",
      "request_refund",
      "search_docs",
    ]);
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain(
      "you handle refunds yourself",
    );
  });

  it("still lets the app decide: over the limit waits for a supervisor", async () => {
    model = modelStreaming(
      calls("request_refund", { orderId: "1004" }),
      says("A supervisor will review it."),
    );
    const result = await ask({
      messages: [{ role: "user", content: "Refund order 1004" }],
      useTools: true,
      desk: desk(50),
      architecture: "single-agent",
    });
    expect(toolCallsOf(result)[0].output).toMatchObject({
      status: "needs_approval",
      amountUsd: 149,
    });
  });

  it("COPPER_ARCHITECTURE picks the app's default; the two agents stay the default", async () => {
    model = modelStreaming(says("Hi!"));
    vi.stubEnv("COPPER_ARCHITECTURE", "single-agent");
    expect(
      (
        await ask({
          messages: [{ role: "user", content: "Hi" }],
          useTools: true,
          desk: desk(50),
        })
      ).agent,
    ).toBe("support");
    model = modelStreaming(says("Hi!"));
    vi.stubEnv("COPPER_ARCHITECTURE", "");
    expect(
      (
        await ask({
          messages: [{ role: "user", content: "Hi" }],
          useTools: true,
          desk: desk(50),
          agent: "support",
        })
      ).agent,
    ).toBe("copper");
  });
});

describe("Langfuse tracing (Module 5)", () => {
  it("is off without Langfuse keys, so the app and tests run without them", () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    expect(isTracingConfigured()).toBe(false);
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
    expect(isTracingConfigured()).toBe(true);
  });

  it("a chat still answers with tracing off", async () => {
    model = modelStreaming(says("Copper Home is $149."));
    const result = await ask({
      messages: [{ role: "user", content: "How much is Copper Home?" }],
      useTools: true,
    });
    expect(result.reply).toBe("Copper Home is $149.");
  });
});

describe("the golden set and the eval's code checks (Module 5)", () => {
  const output = (o: Partial<CaseOutput>): CaseOutput => ({
    reply: "",
    answeredBy: "refund",
    handoffs: 1,
    tools: [],
    status: "done",
    latencyMs: 1000,
    costUsd: 0,
    modelCalls: 2,
    ...o,
  });
  const byId = (id: string) => GOLDEN_SET.find((c) => c.id === id)!;

  it("has unique ids and says what a good answer does for each", () => {
    const ids = GOLDEN_SET.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(8);
    for (const c of GOLDEN_SET) expect(c.goodAnswer.length).toBeGreaterThan(20);
  });

  it("passes the right refund by the right agent, and catches the wrong ones", () => {
    const c = byId("refund-under-limit");
    const right = output({
      tools: [{ name: "request_refund", input: { orderId: "1001" } }],
    });
    expect(check(c, "multi-agent", right)).toEqual([]);
    expect(
      check(c, "single-agent", { ...right, answeredBy: "support" }),
    ).toEqual([]);
    expect(check(c, "multi-agent", { ...right, answeredBy: "copper" })).toEqual(
      ["answered by copper, not refund"],
    );
    expect(
      check(
        c,
        "multi-agent",
        output({
          tools: [{ name: "request_refund", input: { orderId: "1004" } }],
        }),
      ),
    ).toEqual(["requested a refund for order 1004"]);
    expect(check(c, "multi-agent", output({}))).toEqual([
      "didn't call request_refund",
    ]);
  });

  it("a policy question stays with Copper and never requests a refund", () => {
    const c = byId("policy-annual-refund");
    expect(
      check(
        c,
        "multi-agent",
        output({ answeredBy: "copper", tools: [{ name: "search_docs" }] }),
      ),
    ).toEqual([]);
    expect(
      check(
        c,
        "multi-agent",
        output({
          answeredBy: "refund",
          tools: [{ name: "search_docs" }, { name: "request_refund" }],
        }),
      ),
    ).toEqual(["called request_refund", "answered by refund, not copper"]);
  });
});
