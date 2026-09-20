import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One headless Chrome, driven over the DevTools protocol, that reads a page the way a person would:
 * it loads it, scrolls to the bottom until nothing new appears, and hands back the text it can see.
 *
 * Rendering a page once and reading its HTML was not enough. Forums and review sites put twenty
 * items in the document and fetch the rest on scroll, so a real quote from further down the thread
 * read as a missing quote. Scrolling is also why this reuses one browser for the whole run instead
 * of spawning Chrome per URL, which was costing about forty seconds a page.
 */

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

interface Cmd { id: number; method: string; params?: unknown; sessionId?: string }

export class Browser {
  private proc: Bun.Subprocess | null = null;
  private ws: WebSocket | null = null;
  private dir = "";
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  async start(): Promise<void> {
    this.dir = mkdtempSync(join(tmpdir(), "sq-chrome-"));
    this.proc = Bun.spawn([CHROME, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--mute-audio", `--user-agent=${UA}`,
      "--remote-debugging-port=0", `--user-data-dir=${this.dir}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
    const portFile = join(this.dir, "DevToolsActivePort");
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await Bun.sleep(100);
    if (!existsSync(portFile)) throw new Error("Chrome never reported a debugging port");
    const port = readFileSync(portFile, "utf8").split("\n")[0].trim();
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl: string };
    this.ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise<void>((ok, fail) => {
      this.ws!.addEventListener("open", () => ok(), { once: true });
      this.ws!.addEventListener("error", () => fail(new Error("devtools socket failed")), { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id === undefined) return;
      const pending = this.waiting.get(msg.id);
      if (!pending) return;
      this.waiting.delete(msg.id);
      msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result);
    });
  }

  private send<T = any>(method: string, params?: unknown, sessionId?: string, timeoutMs = 20_000): Promise<T> {
    const id = this.nextId++;
    const cmd: Cmd = { id, method, params, sessionId };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.waiting.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws!.send(JSON.stringify(cmd));
    });
  }

  /**
   * The visible text of a page after it settles: navigate, wait for the load, then scroll to the
   * bottom until the page stops growing. Returns "" when the page never answers, which the caller
   * treats as unreadable rather than as an empty page.
   */
  async text(url: string, { scrolls = 12, settleMs = 900, budgetMs = 45_000 } = {}): Promise<string> {
    // One page can never hold up a run: a site that never settles gets abandoned with whatever it gave.
    const deadline = Date.now() + budgetMs;
    let target: string | undefined;
    let session: string | undefined;
    try {
      ({ targetId: target } = await this.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" }));
      ({ sessionId: session } = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target, flatten: true }));
      await this.send("Page.enable", {}, session);
      await this.send("Page.navigate", { url }, session, Math.min(30_000, budgetMs));
      await Bun.sleep(1500);
      let previous = 0;
      for (let i = 0; i < scrolls && Date.now() < deadline; i++) {
        const { result } = await this.send<{ result: { value: number } }>("Runtime.evaluate", {
          expression: "window.scrollTo(0, document.body.scrollHeight); document.body.innerText.length",
          returnByValue: true,
        }, session, 20_000);
        const size = Number(result?.value ?? 0);
        // Two passes with no new text means the page has nothing more to load.
        if (size > 0 && size === previous) break;
        previous = size;
        await Bun.sleep(settleMs);
      }
      const { result } = await this.send<{ result: { value: string } }>("Runtime.evaluate", {
        expression: "document.body ? document.body.innerText : ''",
        returnByValue: true,
      }, session, Math.max(5_000, deadline - Date.now()));
      return String(result?.value ?? "");
    } catch {
      return "";
    } finally {
      if (target) await this.send("Target.closeTarget", { targetId: target }).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    try { this.ws?.close(); } catch { /* already gone */ }
    this.proc?.kill();
    await this.proc?.exited;
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }
}
