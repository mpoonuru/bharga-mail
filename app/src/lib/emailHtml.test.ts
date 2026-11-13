import { describe, expect, it } from "vitest";
import { processEmail } from "./emailHtml";

describe("processEmail dark-mode colour adaptation", () => {
  it("lightens hardcoded dark text in dark mode", () => {
    const { html } = processEmail(`<div style="color:#333333">Dear Prasanga,</div>`, {
      showImages: true,
      highlight: false,
      dark: true,
    });
    expect(html).toContain("#e7e8ec");
    expect(html.toLowerCase()).not.toContain("#333333");
  });

  it("neutralises near-white backgrounds in dark mode", () => {
    const { html } = processEmail(`<div style="background-color:#ffffff;color:#000">Hi</div>`, {
      showImages: true,
      highlight: false,
      dark: true,
    });
    expect(html).toContain("background-color: transparent");
    expect(html).toContain("#e7e8ec"); // black text lightened too
  });

  it("handles legacy bgcolor / font color attributes", () => {
    const { html } = processEmail(
      `<table bgcolor="#FFFFFF"><tr><td><font color="#222">x</font></td></tr></table>`,
      { showImages: true, highlight: false, dark: true },
    );
    expect(html).not.toContain("FFFFFF");
    expect(html).toContain("#e7e8ec");
  });

  it("leaves already-light text untouched", () => {
    const { html } = processEmail(`<div style="color:#eeeeee">bright</div>`, {
      showImages: true,
      highlight: false,
      dark: true,
    });
    expect(html.toLowerCase()).toContain("#eeeeee");
  });

  it("does NOT recolour anything in light mode", () => {
    const { html } = processEmail(`<div style="color:#333333">x</div>`, {
      showImages: true,
      highlight: false,
      dark: false,
    });
    expect(html.toLowerCase()).toContain("#333333");
    expect(html).not.toContain("#e7e8ec");
  });

  it("leaves dark (brand) backgrounds alone", () => {
    const { html } = processEmail(`<div style="background-color:#0a2540;color:#fff">brand</div>`, {
      showImages: true,
      highlight: false,
      dark: true,
    });
    expect(html.toLowerCase()).toContain("#0a2540");
  });
});

describe("processEmail navigation isolation", () => {
  it("removes image-map and SVG xlink navigation bypasses", () => {
    const { html } = processEmail(
      '<map name="actions"><area href="https://evil.test/map" shape="rect"></map><img usemap="#actions"><svg><a xlink:href="https://evil.test/svg"><text>Open</text></a></svg>',
      { showImages: true, highlight: false },
    );
    const doc = new DOMParser().parseFromString(html, "text/html");

    expect(doc.querySelector("map, area")).toBeNull();
    expect(html.toLowerCase()).not.toContain("xlink:href");
    expect(doc.querySelector('a[href="https://evil.test/svg"]')).toBeNull();
  });
});

describe("processEmail whole-document styling", () => {
  const newsletter =
    "<!doctype html><html><head><style>body{color:#ffffff;font-family:Menlo,monospace}.card{background-color:#131313}</style></head>" +
    '<body class="body" bgcolor="#050305" onload="alert(1)" background="https://track.test/bg.png"><table class="card" bgcolor="#131313"><tr><td>Connect your app</td></tr></table></body></html>';

  it("keeps the message's <head> stylesheet", () => {
    const { headStyles, html } = processEmail(newsletter, { showImages: true, highlight: false });
    expect(headStyles).toContain("color:#ffffff");
    expect(headStyles).toContain(".card{background-color:#131313}");
    expect(html).toContain("Connect your app");
  });

  it("carries only safe <body> attributes", () => {
    const { bodyAttrs } = processEmail(newsletter, { showImages: true, highlight: false });
    expect(bodyAttrs).toBe(' class="body" bgcolor="#050305"');
  });

  it("escapes body attribute values", () => {
    const { bodyAttrs } = processEmail(
      `<html><body class='a" onload="x' style="color:red"><p>x</p></body></html>`,
      { showImages: true, highlight: false },
    );
    expect(bodyAttrs).toBe(' class="a&quot; onload=&quot;x" style="color:red"');
  });

  it("blocks remote images referenced from a stylesheet", () => {
    const { headStyles, blocked } = processEmail(
      "<html><head><style>.hero{background-image:url('https://track.test/p.gif')}</style></head><body><div class='hero'>x</div></body></html>",
      { showImages: false, highlight: false },
    );
    expect(headStyles).not.toContain("track.test");
    expect(blocked).toBe(1);
  });

  it("adapts head stylesheet colours in dark mode", () => {
    const { headStyles } = processEmail(
      "<html><head><style>p{color:#222222}</style></head><body><p>x</p></body></html>",
      { showImages: true, highlight: false, dark: true },
    );
    expect(headStyles).toContain("color: #e7e8ec");
  });
});

describe("processEmail dark-designed messages", () => {
  it("leaves brand colours alone when the message paints its own dark canvas", () => {
    const sent =
      "<html><head><style>body{background-color:#050305;color:#fff}.eyebrow{color:#ea2845}</style></head><body><p class='eyebrow'>x</p><p style='color:#333333'>y</p></body></html>";
    const { headStyles, html } = processEmail(sent, {
      showImages: true,
      highlight: false,
      dark: true,
    });
    expect(headStyles).toContain(".eyebrow{color:#ea2845}");
    expect(html).toContain("color:#333333");
  });

  it("detects a dark canvas from the body bgcolor attribute", () => {
    const { html } = processEmail(
      '<html><body bgcolor="#000000"><p style="color:#ea2845">x</p></body></html>',
      { showImages: true, highlight: false, dark: true },
    );
    expect(html).toContain("color:#ea2845");
  });
});

describe("processEmail stylesheet capture", () => {
  it("captures a stylesheet the parser hoists into the body", () => {
    const { headStyles, html } = processEmail(
      "<html><body><style>body{color:#ffffff}</style><p>hi</p></body></html>",
      { showImages: true, highlight: false, dark: true },
    );
    expect(headStyles).toContain("body{color:#ffffff}");
    expect(html).not.toContain("<style");
  });

  it("keeps the newsletter body colour in light mode", () => {
    const sent =
      '<html><head><style>body{background-color:#050305;color:#ffffff}</style></head><body class="body" bgcolor="#050305"><p>hi</p></body></html>';
    const { headStyles, bodyAttrs } = processEmail(sent, {
      showImages: true,
      highlight: false,
      dark: false,
    });
    expect(headStyles).toContain("color:#ffffff");
    expect(bodyAttrs).toBe(' class="body" bgcolor="#050305"');
  });
});

describe("processEmail stylesheets with markup-like text", () => {
  it("keeps a stylesheet whose CSS comment mentions a tag", () => {
    const { headStyles } = processEmail(
      "<html><head><style>h1{color:#ffffff}/* Gmail turns the doctype into the <u> wrapper */.card{background:#131313}</style></head><body><h1>x</h1></body></html>",
      { showImages: true, highlight: false },
    );
    expect(headStyles).toContain("h1{color:#ffffff}");
    expect(headStyles).toContain(".card{background:#131313}");
    expect(headStyles).not.toContain("<u>");
  });

  it("keeps a stylesheet wrapped in legacy <!-- --> markers", () => {
    const { headStyles } = processEmail(
      "<html><head><style><!-- p{color:#ea2845} --></style></head><body><p>x</p></body></html>",
      { showImages: true, highlight: false },
    );
    expect(headStyles).toContain("p{color:#ea2845}");
  });

  it("still drops a stylesheet that tries to break out of <style>", () => {
    const { headStyles, html } = processEmail(
      "<html><head><style>p{color:red}</style><style>x{}</sty<img src=x onerror=alert(1)>le></style></head><body><p>y</p></body></html>",
      { showImages: true, highlight: false },
    );
    expect(headStyles + html).not.toContain("onerror");
  });
});

describe("processEmail smart highlights", () => {
  const marks = (html: string, kind: string) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return Array.from(doc.querySelectorAll(`mark[data-kind="${kind}"]`)).map((m) => m.textContent);
  };
  const run = (source: string) => processEmail(source, { showImages: true, highlight: true }).html;

  it("marks email addresses, phone numbers, IP addresses and reference numbers", () => {
    const html = run(
      "<p>Write to abuse@example.org or call +49 30 1234567 about 192.168.1.10, Invoice no. 2026-0042.</p>",
    );
    expect(marks(html, "email")).toEqual(["abuse@example.org"]);
    expect(marks(html, "phone")).toEqual(["+49 30 1234567"]);
    expect(marks(html, "ref")).toEqual(["192.168.1.10", "Invoice no. 2026-0042"]);
    expect(marks(html, "date")).toEqual([]);
  });

  it("marks privacy and security terms ahead of plain sentiment", () => {
    const html = run(
      "<p>Never share your password. We saw phishing and unauthorized access, sorry.</p><p>See our Privacy Policy.</p>",
    );
    expect(marks(html, "sensitive")).toEqual(["password"]);
    expect(marks(html, "security")).toEqual(["phishing", "unauthorized"]);
    expect(marks(html, "negative")).toEqual(["sorry"]);
  });

  it("flags a mailto link as an address", () => {
    const html = run('<p>Contact <a href="mailto:privacy@example.org">privacy@example.org</a></p>');
    expect(html).toContain('data-hl="email"');
  });

  it("leaves quoted history alone", () => {
    const html = run(
      '<p>Please reply to new@example.org</p><div class="gmail_quote">On Mon, old@example.org wrote:<blockquote>urgent: <a href="mailto:old@example.org">old</a></blockquote></div>',
    );
    expect(marks(html, "email")).toEqual(["new@example.org"]);
    expect(marks(html, "urgent")).toEqual([]);
    expect(html).not.toContain("data-hl");
  });

  it("leaves a plain-text reply header and what follows it alone", () => {
    const html = run(
      "<div>Done, see ticket 48213.</div><div>On 3 Nov 2026 Max &lt;max@example.org&gt; wrote:</div><div>urgent problem</div>",
    );
    expect(marks(html, "ref")).toEqual(["ticket 48213"]);
    expect(marks(html, "email")).toEqual([]);
    expect(marks(html, "urgent")).toEqual([]);
  });

  it("still highlights a bare forward, which has no text of its own", () => {
    const html = run(
      "<div>From: a@example.org Sent: Monday Subject: Hi</div><div>Reach me at b@example.org</div>",
    );
    expect(marks(html, "email")).toEqual(["a@example.org", "b@example.org"]);
  });
});
