import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { EVAL, MARKETS } from "./prompts";
import { Browser } from "./browser";
import { classifyQuote, buyerVoiceIds, allReviewListings, pageUsable, htmlToText as toText, words as wordsOf, type Verdict as QuoteVerdict } from "./verify";

/**
 * Scores both arms' bodies on facts a reader can check by opening a page: it answers, the quoted
 * words are on it, and its own front page does or does not sell software to this market's buyers.
 * No model grades anything here, and every domain verdict is written out so it can be argued with.
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 25_000;
const WIRES = ["prnewswire.com", "businesswire.com", "globenewswire.com", "einpresswire.com", "prweb.com", "accesswire.com", "newswire.com"];
const SPONSORED = /\b(sponsored content|sponsored post|sponsored by|advertorial|paid partnership|promoted content)\b/i;
/** What a page selling software says to get you into a pipeline. A publication asking for a subscription says none of it. */
const SELLS = /\b(book a demo|request a demo|get a demo|schedule a demo|see it in action|start free trial|start a free trial|start for free|try it free|free trial|talk to sales|contact sales|request a quote|request pricing|get started free|our products|our solutions|product tour)\b/i;
const BUYER_CLASS = new Set(["buyer", "practitioner", "customer", "prospect"]);
/** What a bot wall says instead of the article. A page showing this was not read, either way. */
const BOT_WALL = /just a moment|performing security verification|enable javascript and cookies|verify you are (a )?human|access denied|attention required/i;
/**
 * Review listings paginate and reorder: the page that carried a review yesterday carries different
 * ones today. A quote missing from one of these pages is a quote we cannot check, never a quote
 * someone invented, and the rule applies to both arms alike.
 */
const REVIEW_HOSTS = ["capterra.com", "trustpilot.com", "g2.com", "getapp.com", "softwareadvice.com", "sitejabber.com", "producthunt.com", "apps.apple.com", "play.google.com", "glassdoor.com", "indeed.com", "bbb.org"];

type Fault = "dead" | "record_verbatim_not_on_page" | "sells_as_buyer" | "speaker_mislabel";

interface Source { id: string; url: string; speaker: string; verbatim: string; venue?: string; title?: string; unused?: string }
interface Meta { seller_domain: string; market_keywords: string[] }
/** Hand calls that beat the rule, each with the reason, so the answer key stays readable. */
interface Overrides { sells?: Record<string, string>; independent?: Record<string, string> }

const words = wordsOf;
const squash = (s: string) => s.toLowerCase().replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"').replace(/[–—−]/g, "-").replace(/\s+/g, " ").trim();
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
/** A domain covers its own subdomains: a vendor's help centre is still the vendor. */
const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

const htmlToText = toText;

interface Page { status: number | null; text: string; rendered: string; alt: string; error?: string }

/** A host that just rate-limited us gets a pause before the next request, so one busy site does not read as a wall of dead links. */
const lastHit = new Map<string, number>();
const politeWait = async (url: string) => {
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  const since = Date.now() - (lastHit.get(host) ?? 0);
  if (since < 1200) await Bun.sleep(1200 - since);
  lastHit.set(host, Date.now());
};

/** One browser for the whole run: starting Chrome per page cost about forty seconds each. */
const browser = new Browser();

/**
 * A page as a reader sees it: the raw HTML, the text a real browser shows after scrolling to the
 * bottom, and for a forum thread the whole thread as JSON. All three are kept because each catches
 * what the others miss, and a quote counts as found when any of them holds it.
 */
async function fetchPage(url: string, attempt = 0): Promise<Page> {
  let status: number | null = null;
  let fetched = "";
  await politeWait(url);
  try {
    const res = await fetch(url, { method: "GET", headers: { "user-agent": UA, accept: "text/html,*/*" }, redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    status = res.status;
    // Too many requests is our own fault, not the page's: back off and ask again before calling it unreadable.
    if ((status === 429 || status === 503) && attempt < 3) { await Bun.sleep(4000 * (attempt + 1)); return fetchPage(url, attempt + 1); }
    fetched = res.headers.get("content-type")?.includes("text") !== false ? htmlToText(await res.text()) : "";
  } catch (e) {
    if (attempt < 1) { await Bun.sleep(2000); return fetchPage(url, attempt + 1); }
    return { status: null, text: "", rendered: "", alt: "", error: (e as Error).message };
  }
  const rendered = await browser.text(url);
  // A forum thread shows about twenty posts and loads the rest as you scroll a container no window
  // scroll can reach. Discourse hands the whole thread over as JSON at the same path.
  let alt = "";
  if (/\/t\/[^/]+\/\d+/.test(url)) {
    try {
      const res = await fetch(`${url.replace(/[?#].*$/, "").replace(/\/$/, "")}.json`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) alt = htmlToText(await res.text());
    } catch { /* the thread simply is not Discourse */ }
  }
  return { status, text: fetched, rendered, alt };
}

type Verdict = "sells" | "independent" | "unknown";
interface DomainCall { host: string; verdict: Verdict; why: string }

/**
 * Does this domain sell into the market? Decided on the site's own front page: a sales call to
 * action plus the market's vocabulary. Both present is a seller, neither is independent, one of the
 * two is a call for a person, which is what the gray file is for.
 */
async function classify(host: string, meta: Meta, overrides: Overrides, cache: Map<string, DomainCall>): Promise<DomainCall> {
  const hit = cache.get(host);
  if (hit) return hit;
  let call: DomainCall;
  const overrideSells = Object.keys(overrides.sells ?? {}).find((d) => under(host, d));
  const overrideIndep = Object.keys(overrides.independent ?? {}).find((d) => under(host, d));
  if (overrideSells) call = { host, verdict: "sells", why: `override: ${overrides.sells![overrideSells]}` };
  else if (overrideIndep) call = { host, verdict: "independent", why: `override: ${overrides.independent![overrideIndep]}` };
  else if (under(host, meta.seller_domain)) call = { host, verdict: "sells", why: "the company being researched" };
  else if (WIRES.some((d) => under(host, d))) call = { host, verdict: "sells", why: "press release wire: the page is whatever the payer wrote" };
  else {
    // Apex then www: plenty of sites answer on one and not the other, and an unreadable front page is not a verdict.
    let page = await fetchPage(`https://${host}/`);
    if (!page.text && !page.rendered) page = await fetchPage(`https://www.${host}/`);
    if ((!page.text && !page.rendered) || (page.status !== null && page.status >= 400)) call = { host, verdict: "unknown", why: `front page unreadable (${page.status ?? page.error ?? "no answer"})` };
    else {
      const cta = SELLS.test(page.text + page.rendered + page.alt);
      const hits = meta.market_keywords.filter((k) => (page.text + page.rendered + page.alt).toLowerCase().includes(k.toLowerCase()));
      if (cta && hits.length) call = { host, verdict: "sells", why: `front page has a sales call to action and this market's words (${hits.slice(0, 3).join(", ")})` };
      else if (!cta && !hits.length) call = { host, verdict: "independent", why: "front page sells nothing into this market" };
      else call = { host, verdict: "unknown", why: cta ? "sells something, but not obviously into this market" : `talks about this market (${hits.slice(0, 3).join(", ")}) with no sales call to action` };
    }
  }
  cache.set(host, call);
  return call;
}

/** Every `cites` list under a node, flattened to source ids. */
function citedIds(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) { for (const n of node) citedIds(n, out); return out; }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if ((k === "cites" || k.endsWith("_cites")) && Array.isArray(v)) out.push(...v.filter((x): x is string => typeof x === "string"));
      else citedIds(v, out);
    }
  }
  return out;
}

interface Scored {
  arm: string; file: string; accepted: boolean; costUsd: number; rounds: number;
  pains: number; sources: number; domains: number; cited: number; unverifiable: number; faultySources: number;
  faults: Record<Fault, number>;
  /** Quotes are scored separately from sources: a quote is the claim a reader checks first. */
  quotes: { total: number; onPage: number; notOnPage: number; unverifiable: number; notInRecord: number };
  detail: { id: string; url: string; host: string; speaker: string; verdict: Verdict; faults: Fault[]; status: number | null }[];
  badQuotes: { quote: string; cites: string[]; url: string; why: string }[];
  gray: { id: string; url: string; host: string; speaker: string; reason: string }[];
}

async function scoreRun(file: string, meta: Meta, overrides: Overrides, cache: Map<string, DomainCall>): Promise<Scored> {
  const run = JSON.parse(readFileSync(file, "utf8")) as { arm: string; body: string; accepted: boolean; costUsd: number; rounds: unknown[] };
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(run.body) as Record<string, unknown>; } catch { /* an unparseable body scores zero sources, which is itself a result */ }
  const sources = Array.isArray(body.sources) ? (body.sources as Source[]) : [];
  const pains = Array.isArray(body.pains) ? (body.pains as Record<string, unknown>[]) : [];

  // Buyer voice, per the skill's own checks.json: the pain itself and the quotes under by_role.
  const buyerVoice = buyerVoiceIds(body);
  const byId = new Map(sources.map((s) => [s.id, s]));
  const faults: Record<Fault, number> = { dead: 0, record_verbatim_not_on_page: 0, sells_as_buyer: 0, speaker_mislabel: 0 };
  const detail: Scored["detail"] = [];
  const gray: Scored["gray"] = [];
  let unverifiable = 0;

  // Pages are fetched once and reused: a source cited by six quotes is one request.
  const pages = new Map<string, Page>();
  const pageOf = async (url: string): Promise<Page> => {
    const hit = pages.get(url);
    if (hit) return hit;
    const page = url.startsWith("http") ? await fetchPage(url) : { status: null, text: "", error: "not an http url" };
    pages.set(url, page);
    return page;
  };
  /**
   * Readable means we actually have the page's words. A publisher that refuses a plain fetch but
   * renders fine in a browser is readable; a bot wall that renders an "are you human" notice is not,
   * and its pages stay unverifiable rather than being counted either way.
   */
  const readable = (p: Page) => {
    if (p.status === 404 || p.status === 410) return false;
    // Either view can be the bot wall, and a wall in one view must not be rescued by boilerplate in the other.
    const views = [p.text, p.rendered, p.alt].filter((t) => t.length > 400);
    const real = views.filter((t) => !BOT_WALL.test(t.slice(0, 600)));
    return real.length > 0 && real.some((t) => t.length > 400);
  };
  /** Either view of the page counts: a sentence that only appears after the JavaScript runs is still on the page. */
  const holds = (p: Page, phrase: string, exact = false) => {
    const norm = exact ? squash : words;
    return [p.text, p.rendered, p.alt].some((t) => t.length > 200 && !BOT_WALL.test(t.slice(0, 600)) && norm(t).includes(norm(phrase)));
  };
  /** A quotation of several sentences is on the page when each of its sentences is: speakers pause, pages paginate. */
  const sentencesOf = (text: string) => text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.split(/\s+/).length >= 3);
  const holdsAll = (p: Page, phrase: string, exact = false) => {
    if (holds(p, phrase, exact)) return true;
    // Publications break a quotation around the attribution ("...," she said, "..."), so each sentence is
    // checked on its own. Fragments under three words are dropped: they match anything.
    const parts = sentencesOf(phrase);
    return parts.length > 1 && parts.every((part) => holds(p, part, exact));
  };

  /**
   * Every quote the body puts in a person's mouth, checked twice: against the words stored for that
   * source, and against the page itself. Only the second is a citation fault; the first says the
   * record cannot be audited without going back to the web.
   */
  const quotes = { total: 0, onPage: 0, wordForWord: 0, notOnPage: 0, unverifiable: 0, notInRecord: 0, elided: 0, partial: 0 };
  const badQuotes: Scored["badQuotes"] = [];
  const stitched = new Set<string>();
  for (const p of pains) {
    const roles = (p.by_role ?? {}) as Record<string, { says?: { verbatim?: string; cites?: string[] }[] }>;
    for (const role of Object.values(roles)) {
      for (const q of role?.says ?? []) {
        const ids = (q.cites ?? []).filter((id) => byId.has(id));
        if (!q.verbatim?.trim() || !ids.length) continue;
        quotes.total++;
        if (!ids.some((id) => words(byId.get(id)!.verbatim ?? "").includes(words(q.verbatim)))) {
          quotes.notInRecord++;
          ids.forEach((id) => stitched.add(id));
        }
        const fetched = await Promise.all(ids.map((id) => pageOf(byId.get(id)!.url)));
        const views = fetched.flatMap((pg) => [pg.text, pg.rendered, pg.alt]);
        let verdict = classifyQuote(q.verbatim, views);
        // Never accuse on one reading: a page that was rate-limited or half-loaded gets fetched again.
        if (verdict === "not_found" || verdict === "partial") {
          await Bun.sleep(1500);
          const second = await Promise.all(ids.map((id) => fetchPage(byId.get(id)!.url)));
          const again = classifyQuote(q.verbatim, second.flatMap((pg) => [pg.text, pg.rendered, pg.alt]));
          // The kinder reading wins: the point is to be sure before calling a quote invented.
          const rank: Record<QuoteVerdict, number> = { verbatim: 0, elided: 1, partial: 2, unverifiable: 3, not_found: 4 };
          if (rank[again] < rank[verdict]) verdict = again;
        }
        // A listing that reshuffles cannot convict: downgrade the accusation to "cannot be checked".
        if ((verdict === "not_found" || verdict === "partial") && allReviewListings(ids.map((id) => byId.get(id)!.url))) verdict = "unverifiable";
        if (verdict === "verbatim") { quotes.onPage++; quotes.wordForWord++; }
        else if (verdict === "elided") { quotes.onPage++; quotes.elided++; }
        else if (verdict === "partial") { quotes.partial++; badQuotes.push({ quote: q.verbatim.slice(0, 160), cites: ids, url: byId.get(ids[0])!.url, why: "part of the quote is on the page, part is not" }); }
        else if (verdict === "unverifiable") { quotes.unverifiable++; badQuotes.push({ quote: q.verbatim.slice(0, 160), cites: ids, url: byId.get(ids[0])!.url, why: "the page could not be read" }); }
        else { quotes.notOnPage++; badQuotes.push({ quote: q.verbatim.slice(0, 160), cites: ids, url: byId.get(ids[0])!.url, why: "words are not on the cited page" }); }
      }
    }
  }

  for (const s of sources) {
    const host = hostOf(s.url);
    const f: Fault[] = [];
    const call = host ? await classify(host, meta, overrides, cache) : { host, verdict: "unknown" as Verdict, why: "no host" };
    const page = await pageOf(s.url);
    const reachable = readable(page);
    const dead = page.status === 404 || page.status === 410 || /ENOTFOUND|getaddrinfo|ERR_NAME/.test(page.error ?? "");
    if (dead) f.push("dead"); else if (!reachable) unverifiable++;

    // A stored excerpt is checked sentence by sentence: a long verbatim legitimately skips paragraphs, so
    // only a sentence that is nowhere on the page is a fault.
    // A stored record can be several excerpts joined with "|", each prefixed with who said it
    // ("Name, Title at Company: ..."). The page only ever holds the excerpts, so the annotation is
    // stripped before asking whether the words are there.
    const excerpts = (s.verbatim ?? "").split(/\s*\|\s*/).map((part) => part.replace(/^[^.!?:]{0,120}(?:,| at )[^.!?:]{0,120}:\s*/, "").trim()).filter(Boolean);
    const sentences = excerpts.flatMap(sentencesOf);
    const reviewSite = REVIEW_HOSTS.some((h) => under(host, h));
    if (reachable && !reviewSite && sentences.length && sentences.some((sent) => !holds(page, sent))) f.push("record_verbatim_not_on_page");
    if (call.verdict === "sells" && BUYER_CLASS.has(s.speaker)) f.push("speaker_mislabel");
    if (call.verdict === "sells" && buyerVoice.has(s.id)) f.push("sells_as_buyer");
    if (call.verdict === "unknown" && (BUYER_CLASS.has(s.speaker) || buyerVoice.has(s.id))) gray.push({ id: s.id, url: s.url, host, speaker: s.speaker, reason: call.why });
    else if (reachable && SPONSORED.test(page.text) && !["seller", "vendor", "astroturf"].includes(s.speaker)) gray.push({ id: s.id, url: s.url, host, speaker: s.speaker, reason: "page carries a sponsorship marker somewhere; check whether this article is the sponsored one" });

    for (const x of f) faults[x]++;
    detail.push({ id: s.id, url: s.url, host, speaker: s.speaker, verdict: call.verdict, faults: f, status: page.status });
  }

  return {
    arm: run.arm, file: file.split("/").at(-1)!, accepted: run.accepted, costUsd: run.costUsd, rounds: run.rounds.length,
    pains: pains.length, sources: sources.length, domains: new Set(sources.map((s) => hostOf(s.url)).filter(Boolean)).size, cited: new Set(citedIds(body)).size, unverifiable,
    faultySources: detail.filter((d) => d.faults.length).length, faults, quotes, detail, badQuotes, gray,
  };
}

const latest = (dir: string, arm: string): string | null => {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith(`${arm}-`) && f.endsWith(".json")).sort();
  return files.length ? join(dir, files.at(-1)!) : null;
};
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "-");

async function main() {
  const args = new Map<string, string>();
  for (let i = 2; i < Bun.argv.length; i += 2) args.set(Bun.argv[i].replace(/^--/, ""), Bun.argv[i + 1]);
  const slug = args.get("market");
  if (!slug) { console.error("usage: bun score.ts --market <slug>"); process.exit(2); }
  const meta = JSON.parse(readFileSync(join(MARKETS, slug, "meta.json"), "utf8")) as Meta;
  const overridesPath = join(MARKETS, slug, "overrides.json");
  const overrides = existsSync(overridesPath) ? (JSON.parse(readFileSync(overridesPath, "utf8")) as Overrides) : {};
  const dir = join(EVAL, "runs", slug);
  const cache = new Map<string, DomainCall>();
  await browser.start();

  const scored: Scored[] = [];
  for (const arm of ["base", "otto"]) {
    const file = latest(dir, arm);
    if (!file) { console.error(`no run yet for ${arm}`); continue; }
    scored.push(await scoreRun(file, meta, overrides, cache));
  }

  const out = join(EVAL, "results");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${slug}.json`), JSON.stringify({ market: slug, scoredAt: new Date().toISOString(), arms: scored, domains: [...cache.values()] }, null, 1));

  const quoteRows = scored.map((s) => `| ${s.arm} | ${s.quotes.total} | ${s.quotes.wordForWord} | ${s.quotes.elided} | ${s.quotes.partial} | ${s.quotes.notOnPage} | ${s.quotes.unverifiable} | ${s.quotes.notInRecord} (${pct(s.quotes.notInRecord, s.quotes.total)}) |`);
  const sourceRows = scored.map((s) => `| ${s.arm} | ${s.pains} | ${s.sources} | ${s.domains} | ${s.faultySources} (${pct(s.faultySources, s.sources)}) | ${s.faults.record_verbatim_not_on_page} | ${s.faults.sells_as_buyer} | ${s.faults.speaker_mislabel} | ${s.faults.dead} | ${s.unverifiable} | $${s.costUsd.toFixed(2)} | ${s.rounds} |`);
  const md = `# ${slug}

Scored ${new Date().toISOString().slice(0, 10)}. Domain verdicts are in \`${slug}.json\`, each with the reason it was made.

Quotes: every quoted sentence, checked against the page it cites.

| arm | quotes | word for word | elided or bracketed | part on the page | not on the page | page unreadable | not in the stored record |
| --- | --- | --- | --- | --- | --- | --- | --- |
${quoteRows.join("\n")}

Sources: who the evidence came from.

| arm | pains | sources | distinct domains | sources with a fault | stored quote not on its page | seller cited as buyer voice | speaker mislabel | dead | unverifiable | cost | rounds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${sourceRows.join("\n")}
`;
  writeFileSync(join(out, `${slug}.md`), md);
  const gray = scored.flatMap((s) => s.gray.map((g) => `${s.arm},${g.id},${g.host},${g.speaker},"${g.reason.replace(/"/g, "'")}",${g.url}`));
  writeFileSync(join(out, `${slug}-gray.csv`), `arm,source,host,speaker,why_unclear,url\n${gray.join("\n")}\n`);
  console.log(md);
  await browser.stop();
  console.log(`domains judged: ${cache.size}. Gray cases for a human call: ${gray.length} -> results/${slug}-gray.csv`);
}

await main();
