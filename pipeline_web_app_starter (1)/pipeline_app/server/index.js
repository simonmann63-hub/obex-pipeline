
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import dayjs from 'dayjs';
import fs from 'fs';
import PDFDocument from 'pdfkit';
import cron from 'node-cron';
import nodemailer from 'nodemailer';

const app = express();
app.use(cors());
app.use(express.json());

const DB_PATH = './data.db';
const db = new Database(DB_PATH);

// --- DB INIT ---
db.exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS stages (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  probability REAL NOT NULL DEFAULT 0, -- 0..1
  order_index INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  company TEXT,
  amount REAL NOT NULL DEFAULT 0,
  region TEXT,
  stage_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expected_close_date TEXT,
  stage_entered_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open|won|lost
  FOREIGN KEY(stage_id) REFERENCES stages(id)
);
CREATE TABLE IF NOT EXISTS deal_history (
  id INTEGER PRIMARY KEY,
  deal_id INTEGER NOT NULL,
  from_stage_id INTEGER,
  to_stage_id INTEGER,
  changed_at TEXT NOT NULL,
  note TEXT,
  FOREIGN KEY(deal_id) REFERENCES deals(id)
);
`);

// seed stages if empty
const stageCount = db.prepare('SELECT COUNT(*) as c FROM stages').get().c;
if (stageCount === 0) {
  const stages = [
    {name: 'Lead Bank', p: 0.0},
    {name: 'Enquiry (w/ Quote?)', p: 0.1},
    {name: 'Negotiation', p: 0.25},
    {name: 'Appointment Set', p: 0.4},
    {name: 'Post Appointment Negotiation', p: 0.6},
    {name: 'Closed Won', p: 1.0},
    {name: 'Closed Lost', p: 0.0}
  ];
  const ins = db.prepare('INSERT INTO stages (name, probability, order_index) VALUES (?, ?, ?)');
  stages.forEach((s, i) => ins.run(s.name, s.p, i));
}

// seed sample deals if empty
const dealCount = db.prepare('SELECT COUNT(*) as c FROM deals').get().c;
if (dealCount === 0) {
  const now = dayjs();
  const ins = db.prepare(`INSERT INTO deals (title, company, amount, region, stage_id, created_at, expected_close_date, stage_entered_at, status) VALUES (?,?,?,?,?,?,?,?,?)`);
  const stg = db.prepare('SELECT id FROM stages WHERE name = ?');
  ins.run('Starline Windows', 'Starline', 32000, 'South', stg.get('Enquiry (w/ Quote?)').id, now.subtract(30,'day').toISOString(), now.add(30,'day').toISOString(), now.subtract(7,'day').toISOString(), 'open');
  ins.run('General Fabrication', 'General Fab', 8000, 'North', stg.get('Appointment Set').id, now.subtract(90,'day').toISOString(), now.add(10,'day').toISOString(), now.subtract(2,'day').toISOString(), 'open');
  ins.run('Toro Aluminium', 'Toro', 100000, 'Midlands', stg.get('Closed Won').id, now.subtract(120,'day').toISOString(), now.subtract(15,'day').toISOString(), now.subtract(1,'day').toISOString(), 'won');
}

// Helpers
const getStages = () => db.prepare('SELECT * FROM stages ORDER BY order_index').all();
const getDeals = () => db.prepare('SELECT * FROM deals').all();

function dealMetricsForStage(stageId){
  const deals = db.prepare('SELECT * FROM deals WHERE stage_id = ?').all(stageId);
  const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(stageId);
  const today = dayjs();
  let total = 0, weighted = 0, daysSum = 0;
  deals.forEach(d => {
    total += d.amount;
    weighted += d.amount * stage.probability;
    const daysInStage = today.diff(dayjs(d.stage_entered_at), 'day');
    daysSum += daysInStage;
  });
  const avgDays = deals.length ? (daysSum / deals.length) : 0;
  return {count: deals.length, totalAmount: total, weightedAmount: weighted, avgDaysInStage: avgDays};
}

// Routes
app.get('/stages', (req,res)=>{
  res.json(getStages());
});

app.get('/deals', (req,res)=>{
  const {stage_id, region} = req.query;
  let sql = 'SELECT * FROM deals WHERE 1=1';
  const params = [];
  if (stage_id){ sql += ' AND stage_id = ?'; params.push(stage_id); }
  if (region){ sql += ' AND region = ?'; params.push(region); }
  sql += ' ORDER BY id DESC';
  res.json(db.prepare(sql).all(...params));
});

app.post('/deals', (req,res)=>{
  const {title, company, amount, region, stage_id, expected_close_date} = req.body;
  const now = dayjs().toISOString();
  const stmt = db.prepare(`INSERT INTO deals (title, company, amount, region, stage_id, created_at, expected_close_date, stage_entered_at, status) VALUES (?,?,?,?,?,?,?,?,?)`);
  const info = stmt.run(title, company || null, amount || 0, region || null, stage_id, now, expected_close_date || null, now, 'open');
  res.json(db.prepare('SELECT * FROM deals WHERE id = ?').get(info.lastInsertRowid));
});

app.patch('/deals/:id', (req,res)=>{
  const id = req.params.id;
  const body = req.body;
  const allowed = ['title','company','amount','region','expected_close_date','status'];
  const fields = [];
  const params = [];
  for (const k of allowed){
    if (k in body){ fields.push(`${k} = ?`); params.push(body[k]); }
  }
  if (!fields.length) return res.status(400).json({error:'No updatable fields'});
  params.push(id);
  db.prepare(`UPDATE deals SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM deals WHERE id = ?').get(id));
});

app.post('/deals/:id/move', (req,res)=>{
  const id = req.params.id;
  const {to_stage_id} = req.body;
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(id);
  if (!deal) return res.status(404).json({error:'Deal not found'});
  const now = dayjs().toISOString();
  db.prepare('UPDATE deals SET stage_id = ?, stage_entered_at = ? WHERE id = ?').run(to_stage_id, now, id);
  db.prepare('INSERT INTO deal_history (deal_id, from_stage_id, to_stage_id, changed_at, note) VALUES (?,?,?,?,?)')
    .run(id, deal.stage_id, to_stage_id, now, 'stage-move');
  res.json(db.prepare('SELECT * FROM deals WHERE id = ?').get(id));
});

app.get('/metrics', (req,res)=>{
  const stages = getStages();
  const perStage = stages.map(s => ({stage: s, metrics: dealMetricsForStage(s.id)}));
  const today = dayjs();
  const allDeals = getDeals();
  const openDeals = allDeals.filter(d=>d.status==='open');
  const daysOpenAvg = openDeals.length ? openDeals.reduce((acc,d)=>acc+today.diff(dayjs(d.created_at),'day'),0)/openDeals.length : 0;
  res.json({perStage, daysOpenAvg});
});

// Summary since date
app.get('/summary', (req,res)=>{
  const since = req.query.since ? dayjs(req.query.since) : dayjs().subtract(7,'day');
  const sinceIso = since.toISOString();
  const newDeals = db.prepare('SELECT * FROM deals WHERE created_at >= ?').all(sinceIso);
  const moved = db.prepare('SELECT * FROM deal_history WHERE changed_at >= ? AND note = ?').all(sinceIso,'stage-move');
  const closedWon = db.prepare(`SELECT * FROM deals WHERE status='won' AND stage_id = (SELECT id FROM stages WHERE name='Closed Won') AND stage_entered_at >= ?`).all(sinceIso);
  const closedLost = db.prepare(`SELECT * FROM deals WHERE status='lost' OR (stage_id = (SELECT id FROM stages WHERE name='Closed Lost') AND stage_entered_at >= ? )`).all(sinceIso);
  const metrics = db.prepare('SELECT id FROM stages').all().map(r=>r.id).reduce((acc, sid)=>{acc[sid]=dealMetricsForStage(sid); return acc;}, {});
  res.json({since: sinceIso, counts: {newDeals: newDeals.length, moved: moved.length, closedWon: closedWon.length, closedLost: closedLost.length}, metrics});
});

// Generate PDF summary
app.post('/reports/weekly', (req,res)=>{
  const since = dayjs().subtract(7,'day');
  const stages = getStages();
  const summary = stages.map(s=>({name:s.name, ...dealMetricsForStage(s.id)}));

  const fileDir = './reports';
  if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir);
  const filename = `${fileDir}/pipeline-summary-${dayjs().format('YYYY-MM-DD')}.pdf`;
  const doc = new PDFDocument({margin: 36});
  const stream = fs.createWriteStream(filename);
  doc.pipe(stream);
  doc.fontSize(18).text('Weekly Pipeline Summary', {align:'left'});
  doc.moveDown(0.5);
  doc.fontSize(10).text(`Period: ${since.format('YYYY-MM-DD')} to ${dayjs().format('YYYY-MM-DD')}`);
  doc.moveDown();

  // Table header
  doc.fontSize(12).text('Stage', {continued:true,width:200});
  doc.text('Deals', {continued:true, width:60, align:'right'});
  doc.text('Total £', {continued:true, width:100, align:'right'});
  doc.text('Weighted £', {continued:true, width:100, align:'right'});
  doc.text('Avg days', {width:80, align:'right'});
  doc.moveDown(0.3);
  doc.moveTo(36, doc.y).lineTo(559, doc.y).stroke();

  summary.forEach(row=>{
    doc.fontSize(11).text(row.name, {continued:true,width:200});
    doc.text(String(row.count), {continued:true, width:60, align:'right'});
    doc.text(row.totalAmount.toFixed(2), {continued:true, width:100, align:'right'});
    doc.text(row.weightedAmount.toFixed(2), {continued:true, width:100, align:'right'});
    doc.text(row.avgDaysInStage.toFixed(1), {width:80, align:'right'});
  });

  doc.addPage();
  doc.fontSize(14).text('Changes (last 7 days)');
  const sinceIso = since.toISOString();
  const newDeals = db.prepare('SELECT * FROM deals WHERE created_at >= ?').all(sinceIso);
  const moved = db.prepare('SELECT * FROM deal_history WHERE changed_at >= ? AND note = ?').all(sinceIso,'stage-move');
  doc.fontSize(11).text(`New deals: ${newDeals.length}`);
  doc.text(`Stage movements: ${moved.length}`);
  doc.text(`Closed Won: ${db.prepare("SELECT COUNT(*) as c FROM deals WHERE status='won' AND stage_entered_at >= ?").get(sinceIso).c}`);
  doc.text(`Closed Lost: ${db.prepare("SELECT COUNT(*) as c FROM deals WHERE (status='lost' OR stage_id=(SELECT id FROM stages WHERE name='Closed Lost')) AND stage_entered_at >= ?").get(sinceIso).c}`);

  doc.end();
  stream.on('finish', ()=>{
    res.json({file: filename});
  });
});

// Email weekly (configure SMTP via env vars)
const {SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, REPORT_EMAIL_TO} = process.env;
if (SMTP_HOST && REPORT_EMAIL_TO){
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: false,
    auth: SMTP_USER ? {user: SMTP_USER, pass: SMTP_PASS} : undefined
  });
  cron.schedule('0 8 * * 1', async ()=>{ // Monday 08:00
    // generate file
    const resp = await fetch('http://localhost:4000/reports/weekly', {method:'POST'});
    const {file} = await resp.json();
    const info = await transporter.sendMail({
      from: SMTP_USER || 'pipeline@localhost',
      to: REPORT_EMAIL_TO,
      subject: `Weekly Pipeline Summary ${dayjs().format('YYYY-MM-DD')}`,
      text: 'See attached weekly pipeline summary PDF.',
      attachments: [{filename: file.split('/').pop(), path: file}]
    });
    console.log('Weekly report email sent:', info.messageId);
  });
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, ()=>console.log(`Pipeline server listening on http://localhost:${PORT}`));
