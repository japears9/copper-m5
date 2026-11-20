"use server";

// The server action the Ask Copper chat calls. It streams the conversation to
// the model through callStream (lib/ai/call.ts), with or without the tools,
// and sends back each step as it happens, so the panel can show Copper
// thinking and using its tools.
// Module 4: on the Support page the chat also sends the Refund Console's
// "desk" (the auto-refund limit and the refunds so far) and which agent is
// talking. Copper can hand the conversation to the Refund agent, a second
// agent with its own instructions and tools, and the Refund agent can hand it
// back. The agent that ends the turn answers the next message too.
// Module 5: each turn is one trace in Langfuse ("ask-copper"), with one
// "agent" observation per agent that worked on it, and the AI SDK's model and
// tool calls (tokens, cost, time) inside it. A single support agent with every
// tool and no handoff ("single-agent") can stand in for the two agents, so the
// evals can compare them.
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { hasToolCall, stepCountIs } from "ai";
import { callStream, THOUGHT_SUMMARIES } from "@/lib/ai/call";
import { createLive, type Live } from "@/lib/ai/live";
import {
  COPPER_HANDOFF,
  COPPER_INSTRUCTIONS,
  REFUND_AGENT_INSTRUCTIONS,
  SUPPORT_AGENT_INSTRUCTIONS,
} from "@/lib/copper/assistant/instructions";
import {
  AGENT_NAMES,
  type Agent,
  type Architecture,
  type Progress,
  type ToolStep,
} from "@/lib/copper/assistant/progress";
import {
  copperTools,
  refundAgentTools,
  supportAgentTools,
  transferToRefundAgent,
} from "@/lib/copper/assistant/tools";
import type { Desk } from "@/lib/copper/orders";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AskCopperRequest = {
  messages: ChatMessage[];
  useTools: boolean;
  /** The Refund Console's limit and refunds (Support page only). */
  desk?: Desk;
  /** Who answers first: whoever ended the last turn. Copper by default. */
  agent?: Agent;
  /**
   * Module 5: two agents with a handoff (the default) or one support agent
   * with every tool. COPPER_ARCHITECTURE sets the app's default.
   */
  architecture?: Architecture;
  /** Groups a conversation's turns into one Langfuse session. */
  sessionId?: string;
  /** Extra Langfuse tags, like "eval" (Module 5). */
  tags?: string[];
};

export type AskCopperResult = {
  progress: Live<Progress>;
  /** The turn's Langfuse trace (Module 5), when tracing is on. */
  traceId?: string;
};

/** The app's default: COPPER_ARCHITECTURE, or the two agents. */
function defaultArchitecture(): Architecture {
  return process.env.COPPER_ARCHITECTURE === "single-agent"
    ? "single-agent"
    : "multi-agent";
}

/** At most this many model steps (tool calls plus the reply) per agent. */
const MAX_STEPS = 5;

/** Copper → Refund agent → Copper at most, so a turn can't bounce forever. */
const MAX_HANDOFFS = 2;

const HANDOFF_TOOLS: Record<string, Agent> = {
  transfer_to_refund_agent: "refund",
  transfer_to_copper: "copper",
};

// A handoff ends the agent's turn: the other agent answers.
const STOP = [
  stepCountIs(MAX_STEPS),
  hasToolCall("transfer_to_refund_agent", "transfer_to_copper"),
];

/** Each agent's observation name in Langfuse: stable, so filters keep working. */
const AGENT_OBSERVATIONS: Record<Agent, string> = {
  copper: "copper-agent",
  refund: "refund-agent",
  support: "support-agent",
};

const SORRY = "Sorry, something went wrong on my end. Please try again.";

/** One agent's call: its instructions and only its own tools. */
function agentCall(agent: Agent, messages: ChatMessage[], desk?: Desk) {
  if (agent === "support" && desk)
    return callStream(
      { module: 5, feature: "support-agent" },
      {
        messages,
        providerOptions: THOUGHT_SUMMARIES,
        instructions: SUPPORT_AGENT_INSTRUCTIONS,
        tools: supportAgentTools(desk),
        stopWhen: stepCountIs(MAX_STEPS),
      },
    );
  if (agent === "refund" && desk)
    return callStream(
      { module: 4, feature: "refund-agent" },
      {
        messages,
        providerOptions: THOUGHT_SUMMARIES,
        instructions: REFUND_AGENT_INSTRUCTIONS,
        tools: refundAgentTools(desk),
        stopWhen: STOP,
      },
    );
  return callStream(
    { module: 2, feature: "ask-copper" },
    {
      messages,
      providerOptions: THOUGHT_SUMMARIES,
      instructions: desk
        ? `${COPPER_INSTRUCTIONS}\n\n${COPPER_HANDOFF}`
        : COPPER_INSTRUCTIONS,
      tools: desk
        ? { ...copperTools, transfer_to_refund_agent: transferToRefundAgent }
        : copperTools,
      stopWhen: STOP,
    },
  );
}

export async function askCopper({
  messages,
  useTools,
  desk,
  agent = "copper",
  architecture = defaultArchitecture(),
  sessionId,
  tags = [],
}: AskCopperRequest): Promise<AskCopperResult> {
  const { live, update, done } = createLive<Progress>();
  const single = architecture === "single-agent";
  // The single agent answers everything; the two agents never see "support".
  const first: Agent =
    desk && useTools
      ? single
        ? "support"
        : agent === "support"
          ? "copper"
          : agent
      : "copper";
  const progress: Progress = {
    steps: [],
    reply: "",
    status: "working",
    agent: first,
  };
  // A fresh copy each time, so earlier updates never change underneath the
  // panel.
  const snapshot = (): Progress => ({
    ...progress,
    steps: progress.steps.map((step) => ({ ...step })),
  });
  // Tool call ids are per agent call, so each call's are kept apart.
  let call = 0;
  const toolStep = (id: string) =>
    progress.steps.find(
      (step): step is ToolStep =>
        step.type === "tool" && step.id === `${call}:${id}`,
    );

  /** Reads one agent's stream into progress. Returns who to hand off to. */
  async function follow(
    current: Agent,
    result: ReturnType<typeof callStream>,
  ): Promise<Agent | undefined> {
    let handoff: Agent | undefined;
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "reasoning-delta": {
          const last = progress.steps.at(-1);
          if (last?.type === "thinking" && last.agent === current)
            last.text += part.text;
          else
            progress.steps.push({
              type: "thinking",
              text: part.text,
              agent: current,
            });
          break;
        }
        case "tool-input-start":
          progress.steps.push({
            type: "tool",
            id: `${call}:${part.id}`,
            agent: current,
            name: part.toolName,
            state: "calling",
          });
          break;
        case "tool-call": {
          const step = toolStep(part.toolCallId);
          if (step) step.input = part.input;
          else
            progress.steps.push({
              type: "tool",
              id: `${call}:${part.toolCallId}`,
              agent: current,
              name: part.toolName,
              state: "calling",
              input: part.input,
            });
          break;
        }
        case "tool-result": {
          const step = toolStep(part.toolCallId);
          if (step) Object.assign(step, { output: part.output, state: "done" });
          if (part.toolName in HANDOFF_TOOLS)
            handoff = HANDOFF_TOOLS[part.toolName];
          break;
        }
        case "tool-error": {
          const step = toolStep(part.toolCallId);
          const message =
            part.error instanceof Error
              ? part.error.message
              : String(part.error);
          if (step) Object.assign(step, { output: message, state: "error" });
          break;
        }
        case "text-delta":
          progress.reply += part.text;
          break;
        case "error":
          throw part.error;
        default:
          continue;
      }
      update(snapshot());
    }
    return handoff;
  }

  /** One agent's turn, as an "agent" observation in the Langfuse trace. */
  const runAgent = (
    current: Agent,
    result: () => ReturnType<typeof callStream>,
  ) =>
    startActiveObservation(
      AGENT_OBSERVATIONS[current],
      async (observation) => {
        const handoff = await follow(current, result());
        observation.update({
          output: handoff
            ? { handedTo: AGENT_NAMES[handoff] }
            : { reply: progress.reply },
          metadata: { agent: current, tools: toolsUsedBy(current) },
        });
        return handoff;
      },
      { asType: "agent" },
    );
  const toolsUsedBy = (current: Agent) =>
    progress.steps.flatMap((step) =>
      step.type === "tool" && (step.agent ?? "copper") === current
        ? [step.name]
        : [],
    );

  // Read the stream in the background, so the panel gets the first update now.
  // The whole turn is one Langfuse trace (a no-op when tracing is off).
  let traceId: string | undefined;
  void startActiveObservation("ask-copper", (trace) => {
    traceId = trace.traceId;
    const question = messages.at(-1)?.content ?? "";
    // The customer's message in, Copper's reply out: what a reviewer needs.
    trace.update({ input: question });
    return propagateAttributes(
      {
        traceName: "ask-copper",
        sessionId,
        tags: [architecture, ...tags],
        metadata: { architecture },
      },
      async () => {
        try {
          if (!useTools) {
            // Without tools, send no instructions either: "always use your
            // tools" with no tools makes the model answer with nothing.
            await runAgent("copper", () =>
              callStream(
                { module: 2, feature: "ask-copper" },
                { messages, providerOptions: THOUGHT_SUMMARIES },
              ),
            );
          } else {
            let current = first;
            for (let handoffs = 0; ; handoffs++) {
              const agentNow = current;
              const next = await runAgent(agentNow, () =>
                agentCall(agentNow, messages, desk),
              );
              if (!next || next === current || handoffs >= MAX_HANDOFFS) break;
              progress.steps.push({ type: "handoff", from: current, to: next });
              progress.agent = current = next;
              progress.reply = "";
              call++;
              update(snapshot());
            }
          }
          progress.status = "done";
          if (!progress.reply.trim()) progress.reply = SORRY;
        } catch {
          progress.status = "error";
          if (!progress.reply.trim()) progress.reply = SORRY;
        }
        const answeredBy = progress.agent ?? "copper";
        trace.update({
          output: {
            reply: progress.reply,
            answeredBy: AGENT_NAMES[answeredBy],
          },
          metadata: {
            architecture,
            answeredBy,
            status: progress.status,
            handoffs: progress.steps.filter((s) => s.type === "handoff").length,
            tools: progress.steps.flatMap((s) =>
              s.type === "tool" ? [s.name] : [],
            ),
          },
          ...(progress.status === "error" && { level: "ERROR" as const }),
        });
        done(snapshot());
      },
    );
  });

  return { progress: live, traceId };
}
