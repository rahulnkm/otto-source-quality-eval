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

Nothing here is scored by a model. Every verdict is a fact a reader can check by opening the URL.
Every quote in `says[]` gets one, from the cited page as fetched at scoring time:

| Quote verdict | How it is decided |
| --- | --- |
| word for word | The quote's words are on the page, punctuation and entities aside. |
| elided | Every piece of a quote that skips with `...` or splits around "she said" is on the page. |
| part on the page | Some pieces are on the page and some are not. |
| not on the page | None of it is, on a page that was read twice. |
| unreadable | 404, bot wall, empty render, or a review listing that has moved on since the run. |
| not in the stored record | The quote is not inside the verbatim stored for the source it cites. No fetch needed. |

Every source gets checked too:

| Source fault | How it is decided |
| --- | --- |
| `dead` | The URL does not resolve or answers 404/410. |
| `sells_as_buyer` | A buyer-voice field cites a page on a domain that sells into this market. |
| `speaker_mislabel` | A source called buyer, practitioner or customer sits on a domain that sells into this market. |

A page that cannot be fetched (403, bot wall, paywall) is unreadable, never a fault. That is
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

## What twelve markets showed

Legal AI (Legora), restaurant point of sale (Toast), observability (Grafana), payroll (Gusto), CRM
(HubSpot), compliance (Vanta), notes (Notion), fitness (Strava), clinical AI (Abridge), fleet
(Samsara), GTM data (Clay) and sales engagement (Apollo). Runs September 2026; every market scored
on 2026-10-12 in one pass with one version of the checker. Per-market table in `results/summary.md`,
every call with its reason in `results/<slug>.json`.

| | base | otto |
| --- | --- | --- |
| pains written | 131 | 83 |
| sources cited | 294 (2.2 per pain) | 316 (3.8 per pain) |
| quotes | 567 | 422 |
| **quotes not traceable to the stored record** | **247 (44%)** | **0** |
| quotes on a page that could be read | 380 | 206 |
| of those, word for word or honestly elided | 372 (97.9%) | 204 (99.0%) |
| part on the page | 5 | 2 |
| **not on the page at all** | **3** | **0** |
| seller or vendor page cited as buyer voice | 16 | 0 |
| cost | $45.62 | $53.59 |

Read it this way:

- **Provenance.** Every quote otto keeps sits inside the text it stored for that source, so a reader
  can check it without going back out to the web. 44% of base's cannot be checked that way: it
  stored one sentence and quoted others from the same article. This number needs no page fetch, so
  no change to the checker moves it.
- **Quoting.** Where a page can be read, both arms quote accurately. base's three misses are one
  LinkedIn post, checked by hand: it turned the author's list of numbers into first-person sentences
  and added a line the post does not have. otto's two partials are interview quotes from academic papers
  with a word changed or added.
- **Who gets quoted.** base cited a seller's or a vendor's own page as buyer voice 16 times, in most
  markets. otto: never.
- **Blocked evidence.** 187 of base's quotes and 216 of otto's cannot be checked. Capterra,
  Trustpilot, Software Advice and GetApp answer a robot with 403, and review listings reorder as new
  reviews arrive, so a quote missing from one weeks later proves nothing. This eval does not get
  past a bot wall. In the payroll and restaurant markets that covers every otto quote.

Read against otto: it writes fewer pains (83 against 131), costs more ($53.59 against $45.62), and it
invented at least one review. In the compliance market it quoted a "food safety certificates" review
to an AWS Marketplace page that, when checked by hand in September, showed every other review otto
had recorded from it but not that one. otto's validator checks quotes against otto's own stored
text, which the invented review was part of. By October the listing had moved on, so the scorer now
counts that quote as unreadable. A missing quote on a review listing counts as not on the page only
when at least two other reviews recorded from the same listing are still there.

## Running it

```
bun evals/source-quality/run.ts --market legal-ai --arm base
bun evals/source-quality/run.ts --market legal-ai --arm otto
bun evals/source-quality/score.ts --market legal-ai
```

`run.ts` needs a Claude Code CLI on PATH and a logged-in token, the same way otto's own think steps
do. Raw outputs land in `runs/`, scores in `results/`.
