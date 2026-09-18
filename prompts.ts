import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The two arms' prompts. Both carry the same research question, the same inputs and the same schema;
 * only the otto arm carries the skill body and hears the validator. Kept in one file so the diff
 * between the arms is one function call away from anyone auditing the result.
 */

/** This eval's own folder: markets, runs and results sit beside this file, in otto or on its own. */
export const EVAL = new URL(".", import.meta.url).pathname;
/** The otto checkout, for the skill files the otto arm runs on. Only `run.ts` needs it. */
export const OTTO = process.env.OTTO_REPO ?? new URL("../..", import.meta.url).pathname;
export const MARKETS = join(EVAL, "markets");

export interface MarketInputs { slug: string; company: unknown; market: unknown; question: string }

export function loadMarket(slug: string): MarketInputs {
  const read = (f: string) => JSON.parse(readFileSync(join(MARKETS, slug, f), "utf8")) as unknown;
  const meta = read("meta.json") as { question: string };
  return { slug, company: read("company.json"), market: read("market.json"), question: meta.question };
}

const inputsBlock = (m: MarketInputs) => `### brain/company\n\n${JSON.stringify(m.company, null, 1)}\n\n### brain/market\n\n${JSON.stringify(m.market, null, 1)}`;

/** The body contract otto's runner gives a think step, minus the MCP call: here the body comes back on stdout. */
const OUTPUT = `Return the body as JSON in a single \`\`\`json fenced block and nothing else after it. No commentary, no second block.`;

/**
 * The otto arm: the skill body, the inputs, the schema and the same provenance sentence
 * `buildPrompt` puts in front of a real think step.
 */
export function ottoPrompt(m: MarketInputs): string {
  const skill = readFileSync(join(OTTO, "skills/brain/pains.md"), "utf8");
  const body = skill.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  const schema = readFileSync(join(OTTO, "skills/brain/pains/schema.json"), "utf8");
  const elements = readFileSync(join(OTTO, "skills/brain/pains/elements.json"), "utf8");
  return `${body}

---

## otto context

Client: ${(m.company as { company?: { name?: string } }).company?.name ?? m.slug}.

Inputs. These are the artifacts you work from:

${inputsBlock(m)}

Body contract. The body must be JSON that passes this schema and the provenance checks (every claim cites a source id in sources[], every source is cited or marked unused, buyer-voice fields never cite a seller, vendor or astroturf source). The checker refuses anything else and tells you what is wrong; fix and answer again.

${schema}

The element slugs, one of which every pain must carry:

${elements}

Tools. WebSearch and WebFetch.

${OUTPUT}`;
}

/**
 * The base arm: what someone gets from Claude today. The question and the schema, so the output can
 * be parsed and scored the same way, and no word about what makes a source worth citing.
 */
export function basePrompt(m: MarketInputs): string {
  const schema = readFileSync(join(OTTO, "skills/brain/pains/schema.json"), "utf8");
  const elements = readFileSync(join(OTTO, "skills/brain/pains/elements.json"), "utf8");
  return `Research the pains of the buyers in this market and write them up as a pain map.

${m.question}

Work from these inputs:

${inputsBlock(m)}

Fill in this JSON schema. Every field is required unless the schema says otherwise:

${schema}

The element slugs, one of which every pain must carry:

${elements}

Tools. WebSearch and WebFetch.

${OUTPUT}`;
}

/** The text handed back to a child that returned a body the checker refused. */
export function refusalPrompt(problems: string[]): string {
  return `The body was refused. Fix every problem below and answer again with the whole corrected body, not a patch.\n\n${problems.map((p) => `- ${p}`).join("\n")}\n\n${OUTPUT}`;
}

/** The fenced JSON in a CLI result, or the whole text when it came back bare. */
export function extractBody(result: string): string {
  const fenced = /```json\s*([\s\S]*?)```/.exec(result) ?? /```\s*([\s\S]*?)```/.exec(result);
  return (fenced ? fenced[1] : result).trim();
}
