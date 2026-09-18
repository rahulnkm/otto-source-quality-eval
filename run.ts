import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateBrainBody } from "../../src/brain/validate";
import { validateSchema, type Schema } from "../../src/brain/schema";
import { readFileSync } from "node:fs";
import { loadMarket, ottoPrompt, basePrompt, refusalPrompt, extractBody, EVAL, OTTO } from "./prompts";

/**
 * One arm of the eval: `claude -p` on the market's question, with or without otto's skill and checker.
 * The otto arm hears every problem the checker found, the way a think step hears artifacts.propose
 * refuse it. The base arm hears only the problems a schema can state, so neither arm is scored on
 * whether it can format JSON.
 */

const MODEL = "opus";
const MAX_TURNS = 120;
const MAX_BUDGET_USD = 12;
const TIMEOUT_MS = 45 * 60_000;
const MAX_ROUNDS = 3;

interface Round { problems: string[]; costUsd: number; durationMs: number; turns: number; ok: boolean; error?: string }

function argv(resume: string | null): string[] {
  return [
    "-p",
    "--output-format", "json",
    "--max-turns", String(MAX_TURNS),
    "--max-budget-usd", String(MAX_BUDGET_USD),
    "--model", MODEL,
    "--tools", "WebSearch,WebFetch",
    "--allowedTools", "WebSearch,WebFetch",
    ...(resume ? ["--resume", resume] : []),
  ];
}

async function claude(prompt: string, resume: string | null): Promise<{ result: string; sessionId: string | null; costUsd: number; turns: number; durationMs: number; ok: boolean; error?: string }> {
  const started = Date.now();
  const proc = Bun.spawn(["claude", ...argv(resume)], {
    stdin: new TextEncoder().encode(prompt),
    stdout: "pipe",
    stderr: "pipe",
    // The child needs the same credentials the interactive CLI uses; a trimmed environment is "not logged in".
    env: { ...process.env, DISABLE_AUTOUPDATER: "1" },
  });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  const durationMs = Date.now() - started;
  try {
    const raw = JSON.parse(out.trim()) as Record<string, unknown>;
    return {
      result: String(raw.result ?? ""),
      sessionId: typeof raw.session_id === "string" ? raw.session_id : null,
      costUsd: typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : 0,
      turns: typeof raw.num_turns === "number" ? raw.num_turns : 0,
      durationMs,
      ok: code === 0 && raw.is_error !== true,
      error: raw.is_error === true ? String(raw.result ?? "") : undefined,
    };
  } catch {
    return { result: out, sessionId: null, costUsd: 0, turns: 0, durationMs, ok: false, error: err.slice(0, 2000) || `exit ${code}` };
  }
}

/** Schema shape only: the problems the base arm is allowed to hear, so a broken body is not scored as a bad source. */
function schemaProblems(bodyText: string): string[] {
  const schema = JSON.parse(readFileSync(join(OTTO, "skills/brain/pains/schema.json"), "utf8")) as Schema;
  let data: unknown;
  try { data = JSON.parse(bodyText); } catch (e) { return [`body is not JSON: ${(e as Error).message}`]; }
  return validateSchema(schema, data).map((e) => `${e.path || "(root)"}: ${e.message}`).slice(0, 40);
}

async function main() {
  const args = new Map<string, string>();
  for (let i = 2; i < Bun.argv.length; i += 2) args.set(Bun.argv[i].replace(/^--/, ""), Bun.argv[i + 1]);
  const slug = args.get("market");
  const arm = args.get("arm");
  if (!slug || (arm !== "base" && arm !== "otto")) { console.error("usage: bun run.ts --market <slug> --arm <base|otto>"); process.exit(2); }

  const market = loadMarket(slug);
  const inputs = new Map<string, unknown>([["brain/company", market.company], ["brain/market", market.market]]);
  const rounds: Round[] = [];
  let prompt = arm === "otto" ? ottoPrompt(market) : basePrompt(market);
  let resume: string | null = null;
  let body = "";

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    process.stderr.write(`[${slug}/${arm}] round ${round} starting\n`);
    const res = await claude(prompt, resume);
    resume = res.sessionId;
    body = extractBody(res.result);
    // The otto arm is checked the way a think step is checked; the base arm only on the shape of the JSON.
    const problems = arm === "otto" ? validateBrainBody("brain/pains", body, inputs) : schemaProblems(body);
    rounds.push({ problems, costUsd: res.costUsd, durationMs: res.durationMs, turns: res.turns, ok: res.ok, error: res.error });
    process.stderr.write(`[${slug}/${arm}] round ${round}: ${res.ok ? "ok" : `FAILED ${res.error?.slice(0, 200)}`}, ${problems.length} problems, $${res.costUsd.toFixed(2)}, ${Math.round(res.durationMs / 1000)}s\n`);
    if (!res.ok || !problems.length || !resume) break;
    prompt = refusalPrompt(problems);
  }

  const dir = join(EVAL, "runs", slug);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${arm}-${stamp}.json`);
  writeFileSync(file, JSON.stringify({
    market: slug, arm, model: MODEL, ranAt: new Date().toISOString(),
    rounds: rounds.map((r) => ({ ...r, problems: r.problems })),
    costUsd: rounds.reduce((n, r) => n + r.costUsd, 0),
    durationMs: rounds.reduce((n, r) => n + r.durationMs, 0),
    accepted: rounds.at(-1)?.problems.length === 0,
    body,
  }, null, 1));
  console.log(file);
}

await main();
