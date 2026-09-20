import { expect, test, describe } from "bun:test";
import { classifyQuote, fragments, normalizeQuote, htmlToText, pageUsable, buyerVoiceIds, BOT_WALL } from "./verify";

/**
 * Every case here is a quote this eval once called fake and a human found on the page. They are kept
 * as the record of what "not on the page" is allowed to mean, so the next person to run the eval
 * inherits the corrections instead of rediscovering them.
 */

const page = (body: string) => [`${body} ${"filler text to clear the minimum page length. ".repeat(12)}`];

describe("a real quote is not an accusation", () => {
  test("the page writes its apostrophe as a numeric entity", () => {
    const text = htmlToText("<p>But AI&#8217;s answer should begin the inquiry, not end it.</p>");
    expect(classifyQuote("But AI’s answer should begin the inquiry, not end it.", page(text))).toBe("verbatim");
  });

  test("the page closes the quotation with a comma where the record kept the full stop", () => {
    const text = "“Do not tool a problem you don’t understand,” Woodward said.";
    expect(classifyQuote("Do not tool a problem you don't understand.", page(text))).toBe("verbatim");
  });

  test("an academic quote carries an editorial bracket", () => {
    const text = "It takes you 5 minutes to read through what happened in the last consultation, when it normally takes me 20 seconds";
    expect(classifyQuote("It takes you 5 minutes to read through what happened in the last consultation, when it normally take[s] me 20 seconds", page(text))).not.toBe("not_found");
  });

  test("a bracket names who the speaker meant", () => {
    const text = "It's not my voice, right? The ambient scribe is a very different voice from my voice.";
    expect(classifyQuote("It's not my voice, right? [The ambient scribe] is a very different voice from my voice.", page(text))).not.toBe("not_found");
  });

  test("the quote elides the middle with an ellipsis", () => {
    const text = "The AI-generated text is also superfluous, leading to bulky notes. Clinicians reviewed each note. Errors tend to be minor but are frequent.";
    expect(classifyQuote("The AI-generated text is also superfluous, leading to bulky notes...Errors tend to be minor but are frequent.", page(text))).toBe("elided");
  });

  test("the publication breaks the quotation around its attribution", () => {
    const text = "“our laptops barely work,” an associate complained, “the firm should devote more resources to hardware before worrying about AI”";
    expect(classifyQuote("Our laptops barely work. The firm should devote more resources to hardware before worrying about AI", page(text))).toBe("elided");
  });

  test("the stored record is annotated with who spoke", () => {
    const text = "If everything is urgent, nothing is urgent, she told the room.";
    expect(normalizeQuote("Christina Chelliah, Corporate Counsel at TransPerfect: If everything is urgent, nothing is urgent.")).toBe("If everything is urgent, nothing is urgent.");
    expect(classifyQuote("Christina Chelliah, Corporate Counsel at TransPerfect: If everything is urgent, nothing is urgent.", page(text))).toBe("verbatim");
  });
});

describe("an unreadable page is never evidence", () => {
  test("a Cloudflare wall is unverifiable, not a missing quote", () => {
    const wall = ["Just a moment... www.capterra.com Performing security verification. This website uses a security service to protect against malicious bots. " + "x".repeat(600)];
    expect(pageUsable(wall)).toBe(false);
    expect(classifyQuote("We waste hours uploading certificates", wall)).toBe("unverifiable");
  });

  test("a short shell page is unverifiable", () => {
    expect(classifyQuote("anything at all here", ["too short"])).toBe("unverifiable");
  });

  test("the wall in one view is not rescued by boilerplate in another", () => {
    const views = ["Attention Required! | Cloudflare Sorry, you have been blocked " + "y".repeat(500), "z".repeat(100)];
    expect(pageUsable(views)).toBe(false);
  });

  test("bot wall wording is recognised", () => {
    expect(BOT_WALL.test("Please enable JavaScript and cookies to continue")).toBe(true);
    expect(BOT_WALL.test("An ordinary article about payroll")).toBe(false);
  });
});

describe("a quote the page does not have", () => {
  test("invented wording is not found", () => {
    const text = "Maybe the controls could be improved since it is a bit confusing. The tests list view can show a stale status.";
    expect(classifyQuote("We waste hours manually uploading their physical food safety certificates into the system", page(text))).toBe("not_found");
  });

  test("half a quote on the page is partial, not verbatim", () => {
    const text = "The tests list view can show a stale status and that confuses people every week.";
    expect(classifyQuote("The tests list view can show a stale status. Support never answers within a week.", page(text))).toBe("partial");
  });
});

describe("fragments", () => {
  test("pieces under four words are dropped, since they match anything", () => {
    expect(fragments("Yes. It was fine. The dashboard lies about which controls are failing.")).toEqual(["The dashboard lies about which controls are failing."]);
  });
});

describe("buyer voice is what the skill says it is", () => {
  const body = {
    pains: [{
      cites: ["src:1"],
      triggers: [{ cites: ["src:vendor-report"] }],
      by_role: { end_user: { says: [{ verbatim: "it broke", cites: ["src:2"] }] } },
    }],
    stats: [{ cites: ["src:vendor-report"] }],
  };

  test("the pain's own sources and its quotes count", () => {
    expect(buyerVoiceIds(body)).toEqual(new Set(["src:1", "src:2"]));
  });

  test("a market trigger or a statistic is not a claim about what a buyer said", () => {
    expect(buyerVoiceIds(body).has("src:vendor-report")).toBe(false);
  });
});
