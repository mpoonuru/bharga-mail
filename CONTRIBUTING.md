# Contributing to Bharga Mail

Thanks for your interest! A few things to know before you open a PR.

## Contributor License Agreement (required)

Because Bharga Mail is offered both as **open source (AGPL‑3.0)** and under **commercial licenses** to fund development, every contributor must agree to the **[Contributor License Agreement](CLA.md)** before their first contribution is merged.

It's a one‑time signature, handled automatically: when you open your first pull request, the **CLA Assistant** bot will post a link to sign. This grants the project the rights to include your work under both licenses — you keep the copyright to your contribution.

## Development

```bash
cd app
bun install
bun run tauri:dev        # run the app
bun run build            # type-check + build the frontend
bun test                 # JS tests
cd src-tauri && cargo check   # Rust core
```

- **Stack:** Tauri 2 (Rust) · React 19 + TypeScript (Vite) · Tailwind v4 · local SQLite.
- Keep the **local‑first, privacy‑first** principle: features must not route mail or credentials through a server. AI that touches message content must support an on‑device / bring‑your‑own‑key path.
- Run the build, tests, and `cargo check` before pushing.

## Reporting bugs & security

- **Bugs / features:** open a GitHub issue with steps to reproduce.
- **Security vulnerabilities:** please **do not** open a public issue — email **intrusiondetective@gmail.com**.

## Conduct

Be kind and constructive. Harassment or disrespect isn't welcome here.
