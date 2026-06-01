import { describe, it, expect } from "vitest";
import { processEmail } from "./emailHtml";

describe("processEmail dark-mode colour adaptation", () => {
  it("lightens hardcoded dark text in dark mode", () => {
    const { html } = processEmail(`<div style="color:#333333">Dear Prasanga,</div>`, { showImages: true, highlight: false, dark: true });
    expect(html).toContain("#e7e8ec");
    expect(html.toLowerCase()).not.toContain("#333333");
  });

  it("neutralises near-white backgrounds in dark mode", () => {
    const { html } = processEmail(`<div style="background-color:#ffffff;color:#000">Hi</div>`, { showImages: true, highlight: false, dark: true });
    expect(html).toContain("background-color: transparent");
    expect(html).toContain("#e7e8ec"); // black text lightened too
  });

  it("handles legacy bgcolor / font color attributes", () => {
    const { html } = processEmail(`<table bgcolor="#FFFFFF"><tr><td><font color="#222">x</font></td></tr></table>`, { showImages: true, highlight: false, dark: true });
    expect(html).not.toContain("FFFFFF");
    expect(html).toContain("#e7e8ec");
  });

  it("leaves already-light text untouched", () => {
    const { html } = processEmail(`<div style="color:#eeeeee">bright</div>`, { showImages: true, highlight: false, dark: true });
    expect(html.toLowerCase()).toContain("#eeeeee");
  });

  it("does NOT recolour anything in light mode", () => {
    const { html } = processEmail(`<div style="color:#333333">x</div>`, { showImages: true, highlight: false, dark: false });
    expect(html.toLowerCase()).toContain("#333333");
    expect(html).not.toContain("#e7e8ec");
  });

  it("leaves dark (brand) backgrounds alone", () => {
    const { html } = processEmail(`<div style="background-color:#0a2540;color:#fff">brand</div>`, { showImages: true, highlight: false, dark: true });
    expect(html.toLowerCase()).toContain("#0a2540");
  });
});

describe("processEmail quoted-history collapsing", () => {
  const opts = { showImages: true, highlight: false };

  it("collapses an Outlook From/Sent/Subject quote, keeping the reply visible", () => {
    const src =
      `<div>Hi Kranthi, thanks for the list.</div>` +
      `<div>________________________________</div>` +
      `<div>From: Bob &lt;bob@x.com&gt;<br>Sent: Monday<br>To: me<br>Subject: Product List</div>` +
      `<div>Original message body here.</div>`;
    const { html } = processEmail(src, opts);
    const i = html.indexOf("<details");
    expect(i).toBeGreaterThan(-1);
    expect(html).toContain('class="bh-quoted"');
    expect(html.slice(0, i)).toContain("Hi Kranthi"); // reply stays out of the fold
    expect(html.slice(i)).toContain("Product List"); // quote goes in the fold
  });

  it("collapses a Gmail 'On … wrote:' quote", () => {
    const src = `<div dir="ltr">My reply.</div><div class="gmail_quote">On Mon, Bob wrote:<blockquote>old text</blockquote></div>`;
    const { html } = processEmail(src, opts);
    const i = html.indexOf("<details");
    expect(i).toBeGreaterThan(-1);
    expect(html.slice(0, i)).toContain("My reply");
    expect(html.slice(i)).toContain("old text");
  });

  it("does NOT collapse a pure forward (no new content above the quote)", () => {
    const src = `<div class="gmail_quote">On Mon, Bob wrote:<blockquote>forwarded body</blockquote></div>`;
    expect(processEmail(src, opts).html).not.toContain("bh-quoted");
  });

  it("leaves a normal email (no quote) untouched", () => {
    const src = `<p>Just a normal message with no quoted history at all.</p>`;
    expect(processEmail(src, opts).html).not.toContain("bh-quoted");
  });
});
