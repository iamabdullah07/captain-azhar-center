# Captain Azhar Center — QR Code Service

A free-tier, privacy-focused QR code generator built with **React + Vite + Tailwind CSS** (GitHub Pages) and **Cloudflare Workers + Hono + R2 + D1**.

## Architecture

- **Public Website (`/`):** Open to everyone without sign-up or login. Converts Links, Images (`PNG/JPG/WEBP/GIF` up to `10 MB`), Documents (`PDF/DOC/DOCX/XLS/XLSX/PPT/PPTX` up to `25 MB`), and Videos (`MP4/WEBM/MOV` up to `50 MB`) into short-link QR codes. Exports crisp **PNG** (`200–2100 px`), **SVG**, **JPG**, and **PDF**, verified automatically via `jsQR`.
- **Private Admin Panel (`#/admin`):** Hidden from public UI. One-time owner setup restricted strictly to `ADMIN_EMAIL` (configured in Cloudflare Worker secrets), PBKDF2-SHA256 (`100,000` iterations), HttpOnly session cookies, strict Origin + CSRF protection, Turnstile, email-only password reset, and automated FIFO storage cleanup (`80% -> 70%` of 10 GB R2 free limit).

---

## Local Development

1. Install all dependencies from the repository root:
   ```bash
   npm install
   ```
2. Copy environment templates (never commit `.env` or `.dev.vars`):
   - Copy `worker/.dev.vars.example` to `worker/.dev.vars`
   - Copy `frontend/.env.example` to `frontend/.env`
3. Initialize local D1 tables:
   ```bash
   npm --workspace=worker run db:migrate:local
   ```
4. Start both servers in separate terminals:
   ```bash
   npm run dev:worker
   npm run dev:frontend
   ```

---

## Free-Tier Deployment Guide

### 1. Cloudflare Backend (`worker/`)
1. Sign in to [dash.cloudflare.com](https://dash.cloudflare.com) and activate **R2 Object Storage** (free tier: 10 GB storage, 1M writes/month, 10M reads/month, 0 egress fees).
2. Authenticate Wrangler CLI:
   ```bash
   cd worker
   npx wrangler login
   ```
3. Create the private R2 bucket and D1 database:
   ```bash
   npx wrangler r2 bucket create captain-azhar-files
   npx wrangler d1 create captain-azhar-db
   ```
   Copy the `database_id` printed by Wrangler into `worker/wrangler.toml`.
4. Update `ALLOWED_ORIGINS` and `FRONTEND_URL` in `worker/wrangler.toml` with your GitHub username and public repository name (currently configured for `https://iamabdullah07.github.io` and `https://iamabdullah07.github.io/captain-azhar-center`).
5. Apply D1 migrations remotely:
   ```bash
   npx wrangler d1 migrations apply DB --remote
   ```
6. Set required Worker secrets (never stored in files or Git):
   ```bash
   npx wrangler secret put ADMIN_EMAIL
   # Enter your designated owner email address

   npx wrangler secret put SESSION_SECRET
   # Generate 64 random hex chars, e.g.: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

   npx wrangler secret put EMAIL_API_KEY
   # Resend (or Brevo) API key for password reset & 70% storage warnings

   npx wrangler secret put TURNSTILE_SECRET_KEY
   # Cloudflare Turnstile Secret Key
   ```
7. Deploy the Worker:
   ```bash
   npx wrangler deploy
   ```
   The Worker URL is `https://captain-azhar-center.kashaf-hub.workers.dev`.

### 2. GitHub Pages Frontend (`frontend/`)
1. Push this project to a **public** GitHub repository named `captain-azhar-center`.
2. In GitHub: **Settings &rarr; Pages &rarr; Source**, select **GitHub Actions**.
3. In GitHub: **Settings &rarr; Secrets and variables &rarr; Actions &rarr; Variables**, add:
   - `VITE_API_URL` = `https://captain-azhar-center.kashaf-hub.workers.dev`
   - `VITE_TURNSTILE_SITE_KEY` = your Cloudflare Turnstile Site Key (when ready to enable Turnstile)
4. Trigger or push to `main` — `.github/workflows/deploy-pages.yml` builds and publishes `frontend/dist` automatically.
5. Open `https://iamabdullah07.github.io/captain-azhar-center/#/admin` once to set your owner password (at least 14 characters). Sign-up permanently locks afterward.
