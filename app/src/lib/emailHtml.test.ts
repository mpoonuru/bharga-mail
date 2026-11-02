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
