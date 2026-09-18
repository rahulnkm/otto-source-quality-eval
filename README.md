# Source quality eval

Does otto hold a higher standard for a source than the same model without otto?

One step, `brain/pains`, run twice per market on the same model with the same inputs. The `otto`
arm gets the skill, the schema and the validator that refuses a body; the `base` arm gets the same
research question and the same schema and nothing else. Every difference in the result is the
system, not the model.

`brain/pains` is the step where source quality bites: its checks name `pains[]` and
`pains[].by_role.*.says[]` as buyer voice, so a quote that came from a seller, a vendor or an
astroturfed post is a refusal rather than a footnote.

## What is scored, and by whom

Nothing here is scored by a model. Every fault is a fact a reader can check by opening the URL:

| Fault | How it is decided |
| --- | --- |
| `dead` | The URL does not resolve or answers 404/410. |
| `quote_not_found` | The source's `verbatim` is not in the text of its own page. |
| `quote_stitched` | A quote in `says[]` is not a substring of the verbatim it cites. No fetch needed. |
| `sells_as_buyer` | A buyer-voice field cites a page on a domain that sells into this market. |
| `speaker_mislabel` | A source called buyer, practitioner or customer sits on a domain that sells into this market. |
| `sponsored_as_independent` | The page says sponsored, advertorial or paid partnership, and is cited as independent. |

A page that cannot be fetched (403, bot wall, paywall) is `unverifiable`, never a fault. That is
otto's own rule about blocked sources: a blocked source is reported blocked, never counted as empty
and never counted as clean.

## The answer key

"Sells into this market" is decided per domain, from the site's own front page: a sales call to
action (book a demo, start free trial, talk to sales) together with the market's vocabulary from
`markets/<slug>/meta.json`. Both present is a seller. Neither is independent. One of the two is a
call a person has to make, and those land in `results/<slug>-gray.csv`.

No curated vendor list, because a list is only as good as whoever wrote it and it has to be rewritten
for every new market. Every verdict, with its reason, is written to `results/<slug>.json` so a reader
can disagree with a specific call. Hand calls that beat the rule live in `markets/<slug>/overrides.json`,
each with the reason it was overridden.

## Fairness

- Same model, same tools (WebSearch, WebFetch), same turn and budget caps for both arms.
- Same inputs: `markets/<slug>/company.json` and `market.json` are handed to both arms verbatim.
- Same schema. The base arm gets `skills/brain/pains/schema.json` too, or its output could not be
  parsed at all, and the eval would measure JSON formatting instead of source quality.
- Both arms may retry on a malformed body. Only the otto arm hears the source checks. Rounds and
  cost per arm are recorded in the run file, so the extra rounds otto takes are visible.

## What this does not claim

- One step, not the whole product. Nothing here says the other eight brain steps behave this way.
- The arms differ by the whole skill, not only its source rules. This measures otto against plain
  Claude on the same task, which is the comparison a buyer cares about, not an ablation of one rule.
- Small samples. Markets are counted in the results; a run of three markets is three markets.

## What three markets showed

Legal AI (Legora), restaurant point of sale (Toast) and observability (Grafana), September 2026.
Full table in `results/summary.md`, per-market detail in `results/<slug>.json`.

- **Quote accuracy is a tie.** Of the quotes whose pages could be read, 97% of base's and 98% of
  otto's were really there. Neither arm invented a source. Three quotes across six runs could not be
  found on the page cited, all three on review sites that paginate or gate their content.
- **Provenance is not a tie.** 98 of base's 147 quotes (67%) could not be traced to the record it
  stored for that source: it kept one sentence and quoted others. otto: 0 of 90, because the
  validator refuses a body whose quote is not inside the verbatim it cites.
- **Evidence per claim:** otto 4.7 sources per pain, base 1.5.
- **Buyer voice:** base cited the seller's or a vendor's own page as buyer voice three times, once in
  each market. otto never did.
- **Cost:** $15.16 for otto's three runs, $10.99 for base's. otto took a second round once, when the
  validator refused five pains for missing cites; the fix cost $0.97.

Read against otto: it writes fewer pains (19 vs 32), and in the restaurant market it put 44 of its 48
sources on Capterra, which sits behind a bot wall, so most of that market's evidence cannot be
checked by anyone automatically. Concentration like that is a finding about the research, not a bug
in the scoring.

## What is here, and what is not

Here: the harness, the market inputs both arms were given, every raw run both arms produced, the
scorer, and the scores. Enough to re-score the runs yourself, disagree with any single call, or point
the scorer at your own runs.

Not here: otto's skill text, its schema and its validator, which are the product and stay closed.
That means `run.ts` cannot reproduce the otto arm from this repo alone; it reads those files from a
local otto checkout. `score.ts` and `summary.ts` need nothing but this repo and a browser.

## Running it

Re-score what is committed here, or summarise every market:

```
bun score.ts --market legal-ai
bun summary.ts
```

Scoring opens every page a run cited, twice: once with a plain fetch, once rendered in headless
Chrome, because some publications only put the article text on the page after JavaScript runs. It
expects Chrome at the usual macOS path and makes one request per cited URL.

Producing new runs needs a Claude Code CLI on PATH, a logged-in token, and the otto checkout for the
otto arm's skill files:

```
bun run.ts --market legal-ai --arm base
bun run.ts --market legal-ai --arm otto
```
