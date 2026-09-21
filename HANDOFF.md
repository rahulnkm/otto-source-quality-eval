# Handoff: source quality eval

Written 2026-09-20. Read this before trusting a number in `results/`, and before changing `score.ts`.

## What this answers

Does otto hold a higher standard for a source than the same model without otto? One `brain/pains`
step per market, run twice: the `otto` arm gets the skill, the schema and the validator; the `base`
arm gets the same question and schema and nothing else. Same model, same inputs, so any difference is
the system.

12 markets: legal AI (Legora), restaurant POS (Toast), observability (Grafana), payroll (Gusto), CRM
(HubSpot), compliance (Vanta), notes (Notion), fitness (Strava), clinical AI (Abridge), fleet
(Samsara), GTM data (Clay), sales engagement (Apollo). Runs cost about $99 in total and are committed
under `runs/`, so nothing has to be re-run to re-score.

## State on handoff

- **Runs: final.** All 24 are in `runs/`. Do not re-run them to reproduce a number; re-score instead.
- **Scores: a full re-score was in flight when this was written.** `results/*.json` may hold a mix of
  two checker versions. Re-run `score.ts` for every market before quoting a total, and check that
  every `results/*.json` is newer than the last change to `verify.ts`.
- **Published:** github.com/rahulnkm/otto-source-quality-eval (harness, runs, results, README). The
  otto skill, schema and validator stay private, so the `otto` arm cannot be re-run from there.
- **Not merged:** this work sits on `eval-source-quality`. `main` was red (34 failing tests, none in
  `evals/`) and another session held it with uncommitted work.

## What the evidence supports

Stated carefully, because the first version of each of these was wrong:

- **Provenance is the real finding.** Every otto quote sits inside the text otto stored for that
  source; 247 of base's 567 (44%) do not, so they cannot be checked without going back to the web.
  This number needs no page fetch, which is why it never moved through seven checker rewrites.
- **Evidence per claim:** otto 3.8 sources per pain, base 2.2.
- **Buyer voice:** base cited a seller's or vendor's own page as buyer-voice evidence 16 times, once
  or more in most markets. otto: 0.
- **Quote accuracy favours otto, and the exact figure is the least stable number here.** Hand-checking
  every flagged quote once gave 10 apparently invented for base against 1 for otto. Believe a figure
  only if the run behind it used one checker version for all 12 markets.
- **Do not claim otto stops hallucination.** Both arms quote accurately most of the time, and otto
  invented at least one review (see below).

## The one real otto failure, and why its validator missed it

In the compliance market otto wrote this, cited to an AWS Marketplace review page for Vanta:

> "We waste hours manually uploading their physical food safety certificates into the system just to
> clear the annoying red dashboard errors."

"food safety" appears nowhere on that page. The other reviews otto recorded from it are really there.
It read the page, copied several reviews correctly, then wrote one nobody posted.

otto's validator checks that a quote sits inside the verbatim otto stored for that source. The
invented review was inside otto's own stored text, so it passed. **The loop is self-consistent and
never touches the live page.** The fix, if someone wants it: at `artifacts.propose` time, fetch each
source URL and confirm the stored verbatim is on it, the way `score.ts` does. That would have caught
this and costs one fetch per source.

## Rules the checker had to learn

Every one of these came from a real quote being called fake. They live in `verify.ts` and each has a
test in `verify.test.ts` that needs no network. **Run `bun test evals/source-quality/verify.test.ts`
before and after touching that file.**

| the trap | the rule |
| --- | --- |
| `&#8217;` instead of an apostrophe | decode every entity, named and numeric |
| page ends a quotation with a comma, record kept the full stop | compare words, never punctuation |
| `it normally take[s] me 20 seconds` | read editorial brackets both ways |
| a quote eliding its middle with `...` | check piece by piece |
| "…," she said, "…" | same; fragments under four words are dropped |
| `Name, Title at Company: the words` | strip the annotation before comparing |
| a bot wall standing in for the article | unreadable, never a verdict |
| a review listing that reshuffles between the run and the scoring | unreadable, never a verdict |
| a rate-limited fetch returning a stub | read it a second time; the kinder verdict wins |
| a page that never settles | one browser for the run, scrolled, with a deadline per page |
| a vendor report cited as a market trigger | buyer voice is `pains[].cites` and `by_role.*.says[]`, nothing else |

Two of these were found only because a human opened the page and disagreed with the score. Assume
more are left.

## Traps for whoever picks this up

- **One checker version per table.** Mixing versions across markets makes a total meaningless. When
  `verify.ts` changes, re-score all 12.
- **Scoring is slow and sequential by design.** Hosts are paused between hits. A market with 60
  sources takes 10-30 minutes; three markets in parallel is what this machine took.
- **Never defeat a bot wall.** Blocked stays blocked and counts for neither arm.
- **`fitness` and `clinical-ai` are the awkward markets:** forums behind Cloudflare, heavy lazy
  loading. They stall first when something is wrong with the browser layer.
- **Before quoting a number publicly, hand-check the quotes behind it.** Every correction so far has
  moved the numbers against the earlier claim, which is the direction that keeps this credible.

## Commands

```
bun test evals/source-quality/verify.test.ts        # the checker's own tests, no network
bun evals/source-quality/score.ts --market legal-ai # re-score one market from its committed runs
bun evals/source-quality/summary.ts                 # every market in one table
bun evals/source-quality/run.ts --market legal-ai --arm otto   # a new run; needs the Claude CLI
```
