/**
 * Deciding whether a quoted sentence is really on a page, with the ways that question goes wrong
 * written down once and tested. Every rule here exists because a real quote was called fake:
 *
 * - a page writing its apostrophe as `&#8217;`
 * - a publication closing a quotation with a comma where the record kept the full stop
 * - an academic quote carrying an editorial bracket: `it normally take[s] me 20 seconds`
 * - a quote eliding the boring middle with `...` or `…`
 * - a publication breaking a quotation around its attribution: "…," she said, "…"
 * - a record annotated with who spoke: `Name, Title at Company: the words`
 * - a bot wall or an empty render standing in for the article
 *
 * The verdicts are deliberately separate: `verbatim` and `elided` are both honest quoting, while
 * `not_found` is the only one that accuses anybody of anything.
 */

export type Verdict = "verbatim" | "elided" | "partial" | "not_found" | "unverifiable";

/** What a bot wall says instead of the article. A page showing this was never read. */
export const BOT_WALL = /just a moment|performing security verification|enable javascript and cookies|verify you are (a )?human|access denied|attention required|are you a robot|unusual traffic/i;

/** Below this, a "page" is a wall, an error or a shell, and nothing can be concluded from it. */
export const MIN_PAGE_CHARS = 400;

const NAMED: Record<string, string> = {
  nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”", mdash: "—", ndash: "–", hellip: "…", eacute: "é", nbsp2: " ",
};

/** Page text for comparison: tags out, every entity decoded, whitespace flattened. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED[name.toLowerCase()] ?? m)
    .replace(/\s+/g, " ");
}

/** Letters and digits only. Punctuation is where honest quoting and page typography disagree. */
export const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * A quote as the page would have it: editorial brackets removed, speaker annotation dropped,
 * surrounding quotation marks stripped. `[sic]` and `[...]` are elisions, not insertions, so they
 * become breaks rather than disappearing into the sentence around them.
 */
export function normalizeQuote(quote: string): string {
  return quote
    .replace(/\[(?:\.\.\.|…|sic)\]/gi, " … ")
    .replace(/\[([^\]]{0,60})\]/g, (_, inner: string) => ` ${inner} `)
    .replace(/^\s*[^:]{0,120}(?:,| at )[^:]{0,120}:\s*/, "")
    .replace(/^["“”'']+|["“”'']+$/g, "")
    .trim();
}

/**
 * The pieces of a quote that must each appear on the page. A quote elides with `...`, and a
 * publication splits one around its attribution, so each piece is checked where the whole cannot be.
 * Pieces under four words match anything, so they are dropped rather than trusted.
 */
export function fragments(quote: string): string[] {
  const normalized = normalizeQuote(quote);
  const pieces = normalized
    .split(/\s*(?:\.\.\.|…)\s*|(?<=[.!?])\s+/)
    .map((p) => p.trim())
    .filter((p) => p.split(/\s+/).length >= 4);
  // A bracketed insertion can be a word the page does not have; both readings get a chance.
  const withoutInsertions = normalized.replace(/\[[^\]]*\]/g, " ");
  return pieces.length ? pieces : [withoutInsertions.trim()].filter((p) => p.split(/\s+/).length >= 4);
}

/** A page is worth judging only when we actually hold its words. */
export function pageUsable(views: string[]): boolean {
  return views.some((t) => t.length >= MIN_PAGE_CHARS && !BOT_WALL.test(t.slice(0, 800)));
}

/**
 * How much of a quote's wording the page actually carries, measured in overlapping three-word runs.
 * A quote can differ from its page by an editorial bracket or a fixed typo and still be the same
 * sentence; an invented sentence shares only stray words. Runs, not single words, because any two
 * sentences about the same subject share "the", "and" and the product's name.
 */
export function overlap(quote: string, haystacks: string[]): number {
  const tokens = words(normalizeQuote(quote)).split(" ").filter(Boolean);
  if (tokens.length < 3) return 0;
  const runs: string[] = [];
  for (let i = 0; i + 2 < tokens.length; i++) runs.push(tokens.slice(i, i + 3).join(" "));
  const found = runs.filter((run) => haystacks.some((h) => h.includes(run))).length;
  return found / runs.length;
}

/**
 * The verdict for one quote against every view of its page (raw HTML, rendered text, thread JSON).
 * `unverifiable` wins whenever the page cannot be read, so a site that blocks us never becomes
 * evidence against the system that cited it.
 */
export function classifyQuote(quote: string, views: string[]): Verdict {
  const usable = views.filter((t) => t.length >= MIN_PAGE_CHARS && !BOT_WALL.test(t.slice(0, 800)));
  if (!usable.length) return "unverifiable";
  const haystacks = usable.map(words);
  const holds = (needle: string) => haystacks.some((h) => h.includes(words(needle)));
  if (holds(normalizeQuote(quote))) return "verbatim";
  const parts = fragments(quote);
  if (!parts.length) return "unverifiable";
  const hits = parts.filter(holds).length;
  if (hits === parts.length) return "elided";
  if (hits > 0) return "partial";
  // Nothing matched whole, but a single sentence cannot be split, and small edits (a bracket, a
  // fixed typo) break an exact match without changing whose words they are.
  const share = overlap(quote, haystacks);
  if (share >= 0.85) return "elided";
  if (share >= 0.5) return "partial";
  return "not_found";
}

/**
 * Review listings paginate and reorder: the page that carried a review last week carries different
 * ones today, so a quote missing from one is a quote nobody can check rather than one somebody
 * invented. The rule applies to both arms alike.
 */
export const REVIEW_HOSTS = ["capterra.com", "trustpilot.com", "g2.com", "getapp.com", "softwareadvice.com", "sitejabber.com", "producthunt.com", "apps.apple.com", "play.google.com", "glassdoor.com", "indeed.com", "bbb.org", "aws.amazon.com/marketplace"];

/** Is every page behind this quote a listing that reshuffles? Then absence proves nothing. */
export function allReviewListings(urls: string[]): boolean {
  return urls.length > 0 && urls.every((u) => REVIEW_HOSTS.some((h) => u.replace(/^https?:\/\/(www\.)?/, "").startsWith(h) || u.includes(`//${h}`) || u.includes(`.${h}`) || u.includes(h)));
}

/**
 * Buyer voice exactly as the skill's checks.json defines it: the pain's own sources and the quotes
 * under by_role. A citation anywhere else under a pain, such as a market trigger or a statistic, is
 * not a claim about what a buyer said, and counting it as one accused a correctly labelled source.
 */
export function buyerVoiceIds(body: unknown): Set<string> {
  const ids = new Set<string>();
  const pains = (body as { pains?: unknown }).pains;
  if (!Array.isArray(pains)) return ids;
  for (const pain of pains as Record<string, unknown>[]) {
    for (const id of (pain.cites as string[]) ?? []) if (typeof id === "string") ids.add(id);
    const roles = (pain.by_role ?? {}) as Record<string, { says?: { cites?: string[] }[] }>;
    for (const role of Object.values(roles)) {
      for (const say of role?.says ?? []) for (const id of say.cites ?? []) if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}
