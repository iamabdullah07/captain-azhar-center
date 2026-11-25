# Captain Azhar Center — Free Word-to-PDF Converter

Headless LibreOffice microservice used by the Cloudflare Worker `POST /api/convert-word` endpoint.

## Features
- Accepts only validated `.doc` and `.docx` uploads (up to 25 MB).
- Runs isolated headless LibreOffice conversion (`--headless --norestore`) with a per-request user profile and 35s timeout.
- Deletes temporary files immediately after each request.
- Protected via `WORD_CONVERTER_SECRET` (`Authorization: Bearer <token>`).

## Run Locally (with LibreOffice installed)
```bash
WORD_CONVERTER_SECRET=dev-local-secret node converter/server.mjs
```
Then add to `worker/.dev.vars`:
```env
WORD_CONVERTER_URL=http://127.0.0.1:8788
WORD_CONVERTER_SECRET=dev-local-secret
```

## Deploy with Docker (Render, Koyeb, Fly.io, Cloud Run free tier)
Build from `converter/Dockerfile`, set `WORD_CONVERTER_SECRET`, and configure the Worker:
```bash
npx wrangler secret put WORD_CONVERTER_SECRET
```
and set `WORD_CONVERTER_URL` in `worker/wrangler.toml` (or Worker vars).
