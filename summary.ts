import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVAL } from "./prompts";

/** Every market's scores in one table, plus the totals the whole eval stands on. */

interface Arm {
  arm: string; pains: number; sources: number; domains: number; unverifiable: number; faultySources: number; costUsd: number; rounds: number;
  faults: Record<string, number>;
  quotes: { total: number; onPage: number; wordForWord: number; notOnPage: number; unverifiable: number; notInRecord: number };
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "-");

const dir = join(EVAL, "results");
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const totals: Record<string, Arm> = {};
const rows: string[] = [];

for (const f of files) {
  const res = JSON.parse(readFileSync(join(dir, f), "utf8")) as { market: string; arms: Arm[] };
  for (const a of res.arms) {
    rows.push(`| ${res.market} | ${a.arm} | ${a.pains} | ${a.sources} | ${(a.sources / Math.max(a.pains, 1)).toFixed(1)} | ${a.quotes.total} | ${a.quotes.onPage} (${pct(a.quotes.onPage, a.quotes.total)}) | ${a.quotes.notOnPage} | ${a.quotes.notInRecord} (${pct(a.quotes.notInRecord, a.quotes.total)}) | ${a.faults.sells_as_buyer ?? 0} | $${a.costUsd.toFixed(2)} |`);
    const t = (totals[a.arm] ??= { arm: a.arm, pains: 0, sources: 0, domains: 0, unverifiable: 0, faultySources: 0, costUsd: 0, rounds: 0, faults: {}, quotes: { total: 0, onPage: 0, wordForWord: 0, notOnPage: 0, unverifiable: 0, notInRecord: 0 } });
    t.pains += a.pains; t.sources += a.sources; t.unverifiable += a.unverifiable; t.faultySources += a.faultySources; t.costUsd += a.costUsd; t.rounds += a.rounds;
    for (const [k, v] of Object.entries(a.faults)) t.faults[k] = (t.faults[k] ?? 0) + v;
    for (const k of Object.keys(t.quotes) as (keyof Arm["quotes"])[]) t.quotes[k] += a.quotes[k];
  }
}

const totalRows = Object.values(totals).map((t) => `| **all ${files.length} markets** | ${t.arm} | ${t.pains} | ${t.sources} | ${(t.sources / Math.max(t.pains, 1)).toFixed(1)} | ${t.quotes.total} | ${t.quotes.onPage} (${pct(t.quotes.onPage, t.quotes.total)}) | ${t.quotes.notOnPage} | ${t.quotes.notInRecord} (${pct(t.quotes.notInRecord, t.quotes.total)}) | ${t.faults.sells_as_buyer ?? 0} | $${t.costUsd.toFixed(2)} |`);

const md = `# Source quality: all markets

One \`brain/pains\` step per market per arm, same model, same inputs. "otto" has the skill, schema and
validator; "base" has the question and schema alone. Every number below is a fact a reader can check
by opening the cited page; see the README for how each is decided.

| market | arm | pains | sources | sources per pain | quotes | on the page | not on the page | not in the stored record | seller as buyer voice | cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}
${totalRows.join("\n")}
`;
writeFileSync(join(dir, "summary.md"), md);
console.log(md);
