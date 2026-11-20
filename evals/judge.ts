// Module 5: the AI judge ("LLM as a judge"). It reads the customer's question,
// what a good answer does, the tools the agent called and the reply, and
// decides pass or fail with a one-sentence reason. It's a Gemini call through
// lib/ai/call.ts like every other AI call, so it's logged and traced too.
import { z } from "zod";
import { callObject } from "@/lib/ai/call";
import type { ModelId } from "@/lib/ai/models";
import type { GoldenCase } from "@/evals/golden-set";

export const verdictSchema = z.object({
  reason: z
    .string()
    .describe("One or two sentences: what the reply got right or wrong."),
  score: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe(
      "5 = does everything a good answer does; 3 = partly; 1 = wrong or harmful.",
    ),
  pass: z
    .boolean()
    .describe(
      "True only if the reply does what a good answer does and breaks none of its 'must not' rules.",
    ),
});

export type Verdict = z.infer<typeof verdictSchema>;

const JUDGE_INSTRUCTIONS = `You grade replies from Copper, the customer support assistant of Copper State Labs.
You get the customer's message, a description of what a good answer does, the tools the assistant called (with their results), and the assistant's reply.
Grade only against the description of a good answer and the tool results. Be strict about every "must not" rule, and about amounts, order numbers and refund status. Don't reward extra detail, and don't punish a different wording or a friendly tone.
Citations in square brackets, like [Copper Plus FAQ, p. 5], are expected for policy and troubleshooting answers.
Write the reason first, then the score, then pass.`;

export async function judge(
  testCase: GoldenCase,
  reply: string,
  tools: { name: string; input?: unknown; output?: unknown }[],
  model?: ModelId,
): Promise<Verdict> {
  const toolLog = tools.length
    ? tools
        .map(
          (t) =>
            `- ${t.name}(${JSON.stringify(t.input ?? {})}) -> ${short(t.output)}`,
        )
        .join("\n")
    : "(no tools)";
  const { output } = await callObject(
    { module: 5, feature: "eval-judge", model },
    {
      instructions: JUDGE_INSTRUCTIONS,
      prompt: `Customer's message:
${testCase.question}

What a good answer does:
${testCase.goodAnswer}

Tools the assistant called:
${toolLog}

The assistant's reply:
${reply}`,
      schema: verdictSchema,
      temperature: 0,
    },
  );
  return output;
}

/** Tool results can be long (search_docs passages): keep the judge's prompt small. */
function short(value: unknown): string {
  const text = JSON.stringify(value ?? null);
  return text.length > 600 ? `${text.slice(0, 600)}...` : text;
}
