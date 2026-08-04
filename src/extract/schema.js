import { z } from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

/**
 * The extraction contract. Structured outputs constrain the model to this
 * shape at the API level, so a prompt-injected body can at worst distort
 * *which mentions* come back — it can never make the model call tools, emit
 * free text, or change pipeline behavior. Range/length rules are enforced
 * in code (grounding), not the schema: structured outputs don't support
 * numeric bounds, and we never want a client-side schema failure to burn a
 * paid extraction.
 */
export const ExtractionResult = z.object({
  people: z.array(
    z.object({
      name: z.string(),
      email: z.string().nullable(),
      org: z.string().nullable(),
      confidence: z.number(),
      quote: z.string(),
    })
  ),
  orgs: z.array(
    z.object({
      name: z.string(),
      confidence: z.number(),
      quote: z.string(),
    })
  ),
  // Deal signals: only when the document itself records an investment
  // decision or round. status is a closed enum so injected text can't invent
  // new states; everything else is grounded or discarded in code.
  deals: z.array(
    z.object({
      company: z.string(),
      stage: z.string().nullable(),
      status: z.enum(["active", "invested", "passed", "exited", "unknown"]),
      summary: z.string(),
      confidence: z.number(),
      quote: z.string(),
    })
  ),
});

export const extractionOutputFormat = () => zodOutputFormat(ExtractionResult, "extraction");
