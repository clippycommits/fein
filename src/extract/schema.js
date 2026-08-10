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
  // Temporal facts: attributes of a company that can later stop being true.
  // predicate is a closed enum for the same reason status is — an open
  // predicate space cannot be contradicted, so "raising" and "is_raising"
  // would accumulate as parallel truths instead of one retiring the other.
  // as_of is optional and only honoured when the document states its own
  // period; otherwise the document's occurred_at is the valid time.
  facts: z.array(
    z.object({
      subject: z.string(),
      predicate: z.enum([
        "raising", "valuation", "arr", "stage", "headcount", "location",
        "design_partners", "employs", "investor", "decision",
      ]),
      object: z.string().nullable(),
      value: z.string(),
      as_of: z.string().nullable(),
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
