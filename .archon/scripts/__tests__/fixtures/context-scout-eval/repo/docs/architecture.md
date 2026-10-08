# Architecture

Three services share one repository.

- **api** serves the web and mobile clients. It owns customers, invoices, and
  the shipping forms.
- **gateway** is the public edge. It forwards traffic to the API and sheds load
  when a client sends too much of it.
- **worker** pulls background jobs: exports, thumbnails, and nightly reports.

Shared Java utilities live under `lib/`. Development data comes from
`scripts/seed_users.py`.
