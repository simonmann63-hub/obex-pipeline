
# Pipeline Web App (Starter)

This is a minimal full‑stack starter for a Kanban-style sales pipeline with drag-and-drop columns and automatic per‑stage metrics.

## Features
- Stages seeded as: Lead Bank, Enquiry (w/ Quote?), Negotiation, Appointment Set, Post Appointment Negotiation, Closed Won, Closed Lost
- Drag cards to move deals between stages
- + Add button in each stage
- Region tagging and simple filter
- Auto-calculated totals: count, total value, weighted value, average days in stage
- Weekly summary PDF (manual button or scheduled email with SMTP)

## Quick start

### 1) Server
```bash
cd server
cp .env.example .env  # optional: add SMTP to enable weekly emails
npm install
npm start
# server runs on http://localhost:4000
```

### 2) Client
```bash
cd ../client
npm install
# optional: create .env file with: VITE_API_URL=http://localhost:4000
npm run dev
# open http://localhost:5173
```

## Notes
- The server uses SQLite (file `server/data.db`) and will seed stages and a few sample deals on first start.
- Weighted values are `amount × stage.probability` (probabilities can be changed in the `stages` table).
- When a deal is moved, `stage_entered_at` is reset and the movement is logged in `deal_history`.
- The PDF is generated under `server/reports/`.

## Weekly email (optional)
Provide SMTP settings in `server/.env` and the server will send the weekly report every **Monday 08:00** local time.
