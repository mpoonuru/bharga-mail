//! First-run seed data, so the app is alive before any account is connected.
//! Mirrors the front-end mock. Once a real account syncs, real mail takes over.

use super::{CalEvent, Message, Party, Store, Task, Thread};

pub fn events() -> Vec<CalEvent> {
    vec![
        CalEvent {
            id: "e1".into(),
            title: "Standup".into(),
            day: 1,
            time: "09:30".into(),
        },
        CalEvent {
            id: "e2".into(),
            title: "Marco · pipeline".into(),
            day: 3,
            time: "14:00".into(),
        },
        CalEvent {
            id: "e3".into(),
            title: "1:1 Priya".into(),
            day: 3,
            time: "16:00".into(),
        },
        CalEvent {
            id: "e4".into(),
            title: "Renewal deadline".into(),
            day: 4,
            time: "EOD".into(),
        },
    ]
}

pub fn seed(store: &Store) {
    let _ = store.upsert_account("acc1", "alex.morgan@example.com", "imap", "Alex");

    let threads = vec![
        Thread {
            id: "t1".into(),
            account_id: "acc1".into(),
            subject: "Contract renewal — need decision by Friday".into(),
            preview: "Hi Alex, following up on the renewal terms we discussed. Legal needs the signed…".into(),
            participants: vec!["Lena Hoffmann".into()],
            last_time: "9:24".into(),
            unread: true,
            labels: vec!["urgent".into(), "ai-draft".into()],
            view: vec!["priority".into(), "inbox".into(), "awaiting".into()],
            folder: "INBOX".into(),
            ai_summary: Some("Lena needs a signed renewal by Friday. Terms match last year except a 7% price increase.".into()),
            ai_draft: Some("I'm happy to proceed with the 7% adjustment. I'll get the signed agreement back before Friday.".into()),
            messages: vec![Message {
                id: "m1".into(),
                from: Party { name: "Lena Hoffmann".into(), address: "lena@northwind.co".into() },
                to: vec![Party { name: "Alex".into(), address: "alex.morgan@example.com".into() }],
                when: "2026-05-29T09:24:00Z".into(),
                body_html: "<p>Hi Alex,</p><p>Following up on the renewal terms. Legal needs the signed agreement back by <b>Friday</b>. Terms identical to last year, with a 7% adjustment.</p><p>Best,<br>Lena</p>".into(),
                attachments: vec![],
                meta: None,
            }],
        },
        Thread {
            id: "t2".into(),
            account_id: "acc1".into(),
            subject: "Can we sync on the deployment pipeline?".into(),
            preview: "Are you free Thursday afternoon? Want to walk through the new release flow…".into(),
            participants: vec!["Marco · DevOps".into()],
            last_time: "8:51".into(),
            unread: true,
            labels: vec!["meeting".into()],
            view: vec!["priority".into(), "inbox".into()],
            folder: "INBOX".into(),
            ai_summary: Some("Marco wants to meet Thursday afternoon to walk through the release pipeline. You're free 14:00–16:00.".into()),
            ai_draft: Some("Thursday at 14:00 works for me — I'll send an invite with a Meet link.".into()),
            messages: vec![Message {
                id: "m2".into(),
                from: Party { name: "Marco Reyes".into(), address: "marco.reyes@example.org".into() },
                to: vec![Party { name: "Alex".into(), address: "alex.morgan@example.com".into() }],
                when: "2026-05-29T08:51:00Z".into(),
                body_html: "<p>Hey Alex,</p><p>Are you free Thursday afternoon? I'd like to walk through the new release flow before we ship Friday.</p><p>— Marco</p>".into(),
                attachments: vec![],
                meta: None,
            }],
        },
        Thread {
            id: "t3".into(),
            account_id: "acc1".into(),
            subject: "Your payout of €4,210.00 is on the way".into(),
            preview: "We initiated a transfer to your account ending 4421…".into(),
            participants: vec!["Stripe".into()],
            last_time: "7:30".into(),
            unread: false,
            labels: vec!["receipt".into()],
            view: vec!["inbox".into(), "receipts".into()],
            folder: "INBOX".into(),
            ai_summary: None,
            ai_draft: None,
            messages: vec![Message {
                id: "m3".into(),
                from: Party { name: "Stripe".into(), address: "no-reply@stripe.com".into() },
                to: vec![Party { name: "Alex".into(), address: "alex.morgan@example.com".into() }],
                when: "2026-05-29T07:30:00Z".into(),
                body_html: "<p>We initiated a transfer of <b>€4,210.00</b> to your account ending 4421.</p>".into(),
                attachments: vec![],
                meta: None,
            }],
        },
    ];
    for t in &threads {
        let _ = store.upsert_thread(t);
    }

    let tasks = vec![
        (
            "k1",
            "Review renewal terms from Lena",
            Some("Fri"),
            false,
            Some("t1"),
        ),
        (
            "k2",
            "Send invite to Marco for Thursday 14:00",
            Some("Today"),
            false,
            Some("t2"),
        ),
        (
            "k3",
            "Reply to Priya with onboarding feedback",
            Some("Wed"),
            false,
            None,
        ),
        ("k4", "Approve Q3 roadmap", None, true, None),
        ("k5", "Renew TLS certificate", Some("Jun 3"), false, None),
    ];
    for (id, title, due, done, src) in tasks {
        let _ = store.add_task(
            &Task {
                id: id.into(),
                title: title.into(),
                due: due.map(String::from),
                done,
            },
            src,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_seed_uses_reserved_domains() {
        let store = Store::in_memory().expect("in-memory store");
        seed(&store);

        let accounts = store.accounts();
        assert!(!accounts.is_empty());
        assert!(accounts.iter().all(|account| {
            account.email.ends_with("@example.com")
                || account.email.ends_with("@example.org")
                || account.email.ends_with("@example.net")
        }));
    }
}
