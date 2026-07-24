import type { Thread, Task, CalEvent, AiProfile, Account } from "@/types";

// Seed data so the UI is fully explorable without a backend.
// Replace with live data from the Rust core (see src/lib/bridge.ts).

export const account: Account = {
  id: "acc1",
  email: "alex.morgan@example.com",
  provider: "imap",
  displayName: "Alex",
};

export const threads: Thread[] = [
  {
    id: "t1",
    accountId: "acc1",
    subject: "Contract renewal — need decision by Friday",
    preview: "Hi Alex, following up on the renewal terms we discussed. Legal needs the signed…",
    participants: ["Lena Hoffmann"],
    lastTime: "9:24",
    unread: true,
    labels: ["urgent", "ai-draft"],
    view: ["priority", "inbox", "awaiting"],
    aiSummary:
      "Lena needs a signed renewal by Friday. Terms match last year except a 7% price increase. She's asking whether to proceed or renegotiate. Legal has already approved the standard clause.",
    aiDraft:
      "I'm happy to proceed with the 7% adjustment. I'll get the signed agreement back to you before Friday. If anything comes up, let's grab 15 minutes tomorrow.",
    messages: [
      {
        id: "m1",
        from: { name: "Lena Hoffmann", address: "lena@northwind.co" },
        to: [{ name: "Alex", address: "alex.morgan@example.com" }],
        when: "2026-05-29T09:24:00Z",
        meta: { auth: "spf=pass; dkim=pass; dmarc=pass", originIp: "203.0.113.24", messageId: "<renewal-7f3a@northwind.co>" },
        bodyHtml:
          "<p>Hi Alex,</p><p>Following up on the renewal terms we discussed last week. Legal needs the signed agreement back by <b>Friday</b> to keep the same start date. Terms are identical to last year, with a 7% adjustment on the platform tier.</p><p>Happy to hop on a quick call if it's easier. Let me know how you'd like to proceed.</p><p>Best,<br>Lena</p>",
        attachments: [
          { name: "Renewal-Agreement-2026.pdf", mime: "application/pdf", size: 248_320 },
          { name: "Pricing-Tier.xlsx", mime: "application/vnd.ms-excel", size: 18_944 },
        ],
      },
    ],
  },
  {
    id: "t2",
    accountId: "acc1",
    subject: "Can we sync on the deployment pipeline?",
    preview: "Are you free Thursday afternoon? Want to walk through the new release flow…",
    participants: ["Marco · DevOps"],
    lastTime: "8:51",
    unread: true,
    labels: ["meeting"],
    view: ["priority", "inbox"],
    aiSummary: "Marco wants to meet Thursday afternoon to walk through the new release pipeline. Your calendar is free 14:00–16:00.",
    aiDraft: "Thursday at 14:00 works for me — I'll send an invite with a Meet link.",
    messages: [
      {
        id: "m2a",
        from: { name: "Alex", address: "alex.morgan@example.com" },
        to: [{ name: "Marco Reyes", address: "marco.reyes@example.org" }],
        when: "2026-05-28T17:40:00Z",
        meta: { auth: "spf=pass; dkim=pass; dmarc=pass" },
        bodyHtml: "<p>Hi Marco,</p><p>The staging deploy is green. Can we do a quick walkthrough before the Friday release? I want to confirm the rollback steps and the migration order.</p><p>Thanks,<br>Alex</p>",
      },
      {
        id: "m2",
        from: { name: "Marco Reyes", address: "marco.reyes@example.org" },
        to: [{ name: "Alex", address: "alex.morgan@example.com" }],
        when: "2026-05-29T08:51:00Z",
        meta: { auth: "spf=pass; dkim=pass; dmarc=pass", originIp: "198.51.100.7" },
        bodyHtml: "<p>Hey Alex,</p><p>Are you free Thursday afternoon? I'd like to walk through the new release flow before we ship Friday.</p><p>— Marco</p>" +
          "<div>________________________________</div><div>From: Alex &lt;alex.morgan@example.com&gt;<br>Sent: Wednesday, May 28, 2026 5:40 PM<br>Subject: Deployment pipeline</div><p>Hi Marco, the staging deploy is green. Can we do a quick walkthrough…</p>",
      },
      {
        id: "m2c",
        from: { name: "Alex", address: "alex.morgan@example.com" },
        to: [{ name: "Marco Reyes", address: "marco.reyes@example.org" }],
        when: "2026-05-29T09:32:00Z",
        meta: { auth: "spf=pass; dkim=pass; dmarc=pass" },
        bodyHtml: "<p>Thursday at 14:00 works for me — I'll send an invite with a Meet link. Let's start with the rollback plan.</p><p>— Alex</p>" +
          "<div>On Thu, May 29, 2026, Marco Reyes wrote:</div><blockquote>Hey Alex, Are you free Thursday afternoon? I'd like to walk through the new release flow…</blockquote>",
      },
    ],
  },
  {
    id: "t3",
    accountId: "acc2-work",
    subject: "Your payout of €4,210.00 is on the way",
    preview: "We initiated a transfer to your account ending 4421…",
    participants: ["Stripe"],
    lastTime: "7:30",
    unread: false,
    labels: ["receipt"],
    view: ["inbox", "receipts"],
    messages: [
      {
        id: "m3",
        from: { name: "Stripe", address: "no-reply@stripe.com" },
        to: [{ name: "Alex", address: "alex.morgan@example.com" }],
        when: "2026-05-29T07:30:00Z",
        meta: { auth: "spf=pass; dkim=pass; dmarc=pass", originIp: "54.187.205.235", messageId: "<payout-9c11@stripe.com>" },
        bodyHtml: "<p>We initiated a transfer of <b>€4,210.00</b> to your account ending 4421. Funds typically arrive in 1–2 business days.</p>",
      },
    ],
  },
  {
    id: "t4",
    accountId: "acc2-work",
    subject: "Design review notes + Figma link",
    preview: "Thanks for the call! Here are the notes and the updated prototype…",
    participants: ["Priya Nair"],
    lastTime: "Yest",
    unread: false,
    labels: [],
    view: ["inbox"],
    aiSummary: "Priya shared design-review notes and an updated prototype. Three action items are assigned to you.",
    messages: [
      {
        id: "m4",
        from: { name: "Priya Nair", address: "priya@studio.design" },
        to: [{ name: "Alex", address: "alex.morgan@example.com" }],
        when: "2026-05-28T16:10:00Z",
        meta: { auth: "spf=pass; dkim=fail; dmarc=none", originIp: "192.0.2.55" },
        bodyHtml: "<p>Thanks for the call! Notes are attached and the prototype is updated. Let me know your thoughts on the onboarding flow.</p>",
      },
    ],
  },
  {
    id: "t5",
    accountId: "acc1",
    subject: "Weekly digest — product & engineering",
    preview: "This week: 3 releases shipped, 12 issues closed, roadmap updated…",
    participants: ["Bharga Digest"],
    lastTime: "Mon",
    unread: false,
    labels: ["newsletter"],
    view: ["newsletters"],
    messages: [
      {
        id: "m5",
        from: { name: "Bharga Digest", address: "digest@bharga.app" },
        to: [{ name: "Alex", address: "alex.morgan@example.com" }],
        when: "2026-05-25T06:00:00Z",
        meta: { auth: "spf=pass; dkim=pass; dmarc=pass" },
        bodyHtml: "<p>This week: 3 releases shipped, 12 issues closed, roadmap updated for Q3.</p>",
      },
    ],
  },
  {
    id: "t6",
    accountId: "acc1",
    subject: "Action required: your account will be suspended",
    preview: "We detected unusual activity. Verify within 24 hours to avoid suspension…",
    participants: ["PayPal Service"],
    lastTime: "7h",
    unread: true,
    labels: ["urgent"],
    view: ["inbox"],
    messages: [
      {
        id: "m6",
        from: { name: "PayPal Service", address: "service@paypa1-secure.com" },
        to: [{ name: "Alex", address: "alex.morgan@example.com" }],
        when: "2026-05-31T22:00:00Z",
        // Failed authentication — a real spoof would not pass DMARC.
        meta: { auth: "spf=softfail; dkim=fail; dmarc=fail", originIp: "45.137.21.9" },
        bodyHtml:
          "<p>Dear Customer,</p><p>We detected unusual activity on your account. To avoid <b>permanent suspension</b>, please verify your details within 24 hours.</p>" +
          "<p><a href=\"http://paypal.com.account-verify.ru/login\">Verify your PayPal account at paypal.com</a></p>" +
          "<p>Thank you,<br>PayPal Security Team</p>",
      },
    ],
  },
];

export const tasks: Task[] = [
  { id: "k1", title: "Review renewal terms from Lena", due: "Fri", done: false, sourceThreadId: "t1" },
  { id: "k2", title: "Send invite to Marco for Thursday 14:00", due: "Today", done: false, sourceThreadId: "t2" },
  { id: "k3", title: "Reply to Priya with onboarding feedback", due: "Wed", done: false, sourceThreadId: "t4" },
  { id: "k4", title: "Approve Q3 roadmap", done: true },
  { id: "k5", title: "Renew TLS certificate", due: "Jun 3", done: false },
];

export const events: CalEvent[] = [
  { id: "e1", title: "Standup", day: 1, time: "09:30" },
  { id: "e2", title: "Marco · pipeline", day: 3, time: "14:00" },
  { id: "e3", title: "1:1 Priya", day: 3, time: "16:00" },
  { id: "e4", title: "Renewal deadline", day: 4, time: "EOD" },
];

export const aiProfile: AiProfile = {
  name: "Hybrid (private)",
  privacy: "hybrid",
  models: [
    { id: "claude", label: "Claude (Anthropic)", kind: "anthropic", roles: ["draft", "agent", "summarize"], ready: true },
    { id: "gpt", label: "GPT-4o (OpenAI)", kind: "openai-compatible", roles: [], ready: false, endpoint: "https://api.openai.com/v1" },
    { id: "llama", label: "Llama 3 8B · local", kind: "local", roles: ["triage", "embeddings"], ready: true, endpoint: "http://localhost:11434" },
    { id: "custom", label: "Custom endpoint…", kind: "custom", roles: [], ready: false },
  ],
};
