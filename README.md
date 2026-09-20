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

Nothing here is scored by a model. Every fault is a fact a reader can check by opening the URL.

A quote gets one of five verdicts, and only the fourth accuses anybody:

| verdict | meaning |
| --- | --- |
| word for word | the sentence is on the page as written |
| elided or bracketed | the words are on the page, with an ellipsis, an editorial bracket or an attribution between them |
| part on the page | some of the quote is there and some is not |
| **not on the page** | the page carries none of it, on two separate reads |
| page unreadable | a bot wall, a dead link or a review listing that has since reshuffled |

`verify.ts` holds those rules and `verify.test.ts` tests them, with no network. Every test is a quote
this eval once called fake and a human then found on the page: a `&#8217;` apostrophe, a comma where
the record kept a full stop, `it normally take[s] me 20 seconds`, a quotation broken around its
attribution, a record annotated with who spoke. Run `bun test verify.test.ts` before trusting any
number here.

The source-level faults:

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

## What eleven markets showed

Legal AI (Legora), restaurant point of sale (Toast), observability (Grafana), payroll (Gusto), CRM
(HubSpot), compliance (Vanta), notes (Notion), fitness (Strava), fleet (Samsara), GTM data (Clay) and
sales engagement (Apollo), September 2026. Per-market table in `results/summary.md`, every call with
its reason in `results/<slug>.json`.

| | base | otto |
| --- | --- | --- |
| pains written | 119 | 76 |
| sources cited | 281 (2.4 per pain) | 300 (3.9 per pain) |
| quotes | 517 | 392 |
| quotes on a page that could be read | 378 | 226 |
| of those, really on the page | 346 (91.5%) | 216 (95.6%) |
| **quotes not on the page** | **32** | **10** |
| **quotes not traceable to the stored record** | **208 (40%)** | **0** |
| seller or vendor page cited as buyer voice | 15 | 1 |
| cost | $42.62 | $47.07 |

Read it this way:

- **Quoting.** Both arms get most quotes right. base is wrong about three times as often, 8.5% of
  checkable quotes against 4.4%. At three markets this looked like a tie; it took ten to separate.
- **Provenance.** Every quote otto keeps sits inside the text it stored for that source, so a reader
  can check it without going back out to the web. Two in five of base's cannot be checked that way:
  it stored one sentence and quoted others from the same article.
- **Who gets quoted.** base cited a seller's or a vendor's own page as buyer voice in most markets.
  otto did it once, in the Clay market.
- **Blocked evidence.** 139 of base's quotes and 166 of otto's sit on sites that refuse robots,
  mostly Capterra, Trustpilot and app stores. Nobody can check those automatically, and this eval
  does not try to get past a bot wall. In the payroll and restaurant markets that swallowed otto's
  whole set, which is why its "on the page" count there is zero rather than good or bad.

Read against otto: it writes fewer pains (76 against 119), and it still put 10 quotes on pages that
do not carry them.

## Running it

```
bun evals/source-quality/run.ts --market legal-ai --arm base
bun evals/source-quality/run.ts --market legal-ai --arm otto
bun evals/source-quality/score.ts --market legal-ai
```

`run.ts` needs a Claude Code CLI on PATH and a logged-in token, the same way otto's own think steps
do. Raw outputs land in `runs/`, scores in `results/`.
