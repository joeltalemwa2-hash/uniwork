# UniWork

UniWork is a responsive student-opportunity site with a Node.js/SQLite backend, student and employer accounts, listing moderation, application tracking, and offline PWA support.

## Run locally

Requirements: Node.js 24 or newer and npm.

```powershell
npm.cmd install
npm.cmd start
```

Open <http://localhost:3000>. Do not open the HTML files directly; account, job, and PWA features require the server.

On a fresh local database, open **Log in** and create the one-time owner account. This owner setup is available only when the server binds to loopback (`127.0.0.1`, the default) and no owner exists. Use a unique password of at least 12 characters. The owner reviews pending employer listings from the account dashboard.

You can instead create the first admin before startup by copying `.env.example` to `.env` and setting `ADMIN_EMAIL` and `ADMIN_PASSWORD`. The app creates the owner once and prints a reminder to remove `ADMIN_PASSWORD` from `.env`; never commit `.env`.

## Accounts and listings

- Students create accounts, browse approved listings, apply, and see application status.
- Employers create accounts, submit listings for review, and manage their own listings and applications.
- The owner account approves or rejects listings and views registered accounts.
- Passwords are stored as bcrypt hashes. Session cookies are HttpOnly, SameSite Strict, and expire after seven days.
- SQLite data is stored in `data/uniwork.sqlite` by default. Back up this file regularly while the server is stopped.
- The four seeded opportunities are sample roles and cannot accept applications.
- The printable forms are browser-only templates; their fields are not submitted or stored.

## PWA and offline behavior

Serve the site over localhost for local install testing, or over HTTPS in a deployed environment. The service worker caches the public page shell for offline viewing and deliberately does not cache API requests or account/application responses. Listings and account actions still require a connection.

## Public deployment checklist

The default server binds only to `127.0.0.1`. For deployment, bind to the host required by your platform, terminate TLS with HTTPS, set `NODE_ENV=production`, and set `APP_ORIGIN` to the exact public origin. Only enable `TRUST_PROXY=1` behind a trusted reverse proxy. Configure the first admin using server-side environment variables before allowing public sign-up. Protect and back up the SQLite database.

Before accepting real users, arrange email verification, password recovery, account deletion/data requests, operational monitoring, and an appropriate backup/restore process. Review and complete the Privacy, Terms, and Cookie drafts in `documents.html` with your actual operator, retention, service-provider, and legal details. The app currently has no email-verification or password-reset service and has not been deployed publicly; a qualified adviser should review the policies for your operation and applicable Ugandan requirements.
