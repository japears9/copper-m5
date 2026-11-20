// Module 5: observability. Every AI call is traced in Langfuse: which agent
// answered, each model call (tokens, cost, time) and each tool call.
// Set up as Langfuse's AI SDK 7 guide says: the Langfuse integration
// (@langfuse/vercel-ai-sdk) turns each AI SDK call into Langfuse observations
// (generations with model, tokens and thinking; tools; embeddings), and the
// Langfuse span processor sends them to Langfuse over OpenTelemetry. Ask Copper wraps each chat
// turn in a trace and each agent in an "agent" observation (lib/copper/assistant/ask.ts).
// Tracing is off until LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set, so
// the app and its tests run without Langfuse.
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerTelemetry } from "ai";

export function isTracingConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim(),
  );
}

// Kept on globalThis so Next.js dev reloads don't register it twice.
const state = globalThis as typeof globalThis & {
  __copperLangfuse?: LangfuseSpanProcessor;
};

/**
 * Starts sending traces to Langfuse (once per process). Next.js calls this
 * from instrumentation.ts; the evals call it before they run.
 */
export function startTracing(): LangfuseSpanProcessor | null {
  if (state.__copperLangfuse) return state.__copperLangfuse;
  if (!isTracingConfigured()) return null;
  const processor = new LangfuseSpanProcessor({
    environment:
      process.env.LANGFUSE_TRACING_ENVIRONMENT ?? defaultEnvironment(),
    // Serverless functions can freeze right after replying, so send at once.
    exportMode: process.env.VERCEL ? "immediate" : "batched",
  });
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  provider.register();
  // Model calls, tool calls and embeddings, with tokens and timing.
  registerTelemetry(new LangfuseVercelAiSdkIntegration());
  state.__copperLangfuse = processor;
  return processor;
}

function defaultEnvironment(): string {
  if (process.env.GITHUB_ACTIONS) return "ci";
  if (process.env.VERCEL_ENV) return process.env.VERCEL_ENV;
  return "development";
}

/** Sends any traces still waiting. Call before a script or test run exits. */
export async function flushTracing(): Promise<void> {
  await state.__copperLangfuse?.forceFlush();
}
