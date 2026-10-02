require("dotenv").config();

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const { rateLimit } = require("express-rate-limit");
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), 12);

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const LOCAL_OWNER_SETUP = process.env.NODE_ENV !== "production" && ["127.0.0.1", "localhost", "::1"].includes(HOST);
const SESSION_COOKIE = "uniwork_session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const scrypt = promisify(crypto.scrypt);
const databasePath = process.env.SQLITE_PATH || path.join(ROOT, "data", "uniwork.sqlite");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('student', 'employer', 'admin')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    location TEXT NOT NULL,
    type TEXT NOT NULL,
    pay TEXT NOT NULL DEFAULT '',
    schedule TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    requirements TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'closed', 'rejected')),
    is_sample INTEGER NOT NULL DEFAULT 0 CHECK (is_sample IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'reviewing', 'accepted', 'declined')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(job_id, student_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS site_content (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS jobs_public_idx ON jobs(status, is_sample, created_at DESC);
  CREATE INDEX IF NOT EXISTS jobs_owner_idx ON jobs(owner_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS applications_student_idx ON applications(student_id, created_at DESC);
`);
db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https://images.unsplash.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      connectSrc: ["'self'"],
      workerSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: "64kb", strict: true }));
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a little before trying again." }
});

const pages = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/documents.html", "documents.html"],
  ["/forms.html", "forms.html"],
  ["/account.html", "account.html"],
  ["/account.js", "account.js"],
  ["/home.js", "home.js"],
  ["/app.js", "app.js"],
  ["/manifest.webmanifest", "manifest.webmanifest"],
  ["/sw.js", "sw.js"],
  ["/icon.svg", "icon.svg"]
]);
for (const [route, file] of pages) {
  app.get(route, (req, res) => {
    if (route === "/sw.js") res.setHeader("Service-Worker-Allowed", "/");
    if (route.endsWith(".html") || route === "/") res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(ROOT, file));
  });
}

function readCookie(req, name) {
  const entry = (req.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  if (!entry) return "";
  try { return decodeURIComponent(entry.slice(name.length + 1)); } catch { return ""; }
}
function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
function safeUser(row) {
  return row ? { id: row.id, name: row.name, email: row.email, role: row.role } : null;
}
function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_MAX_AGE
  });
}
function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_MAX_AGE;
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(tokenHash(token), userId, expiresAt);
  setSessionCookie(res, token);
}
app.use("/api", (req, res, next) => {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    const row = db.prepare(`SELECT u.id, u.name, u.email, u.role
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`).get(tokenHash(token), Date.now());
    req.user = safeUser(row);
  }
  next();
});
app.use("/api", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  const expectedOrigin = process.env.APP_ORIGIN
    ? new URL(process.env.APP_ORIGIN).origin
    : `${req.protocol}://${req.get("host")}`;
  if (!origin || origin !== expectedOrigin) return res.status(403).json({ error: "Request origin could not be verified." });
  next();
});
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Sign in to continue." });
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Sign in to continue." });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "This action is not available for your account." });
    next();
  };
}
function validText(value, maxLength) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength;
}
function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function serializeJob(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    company: row.company,
    location: row.location,
    type: row.type,
    pay: row.pay,
    schedule: row.schedule,
    description: row.description,
    requirements: row.requirements,
    status: row.status,
    isSample: Boolean(row.is_sample),
    createdAt: row.created_at
  };
}
function getJobInput(body) {
  const fields = ["title", "company", "location", "type"];
  for (const field of fields) {
    if (!validText(body[field], field === "title" ? 120 : 100)) return `${field} is required and must be within its length limit.`;
  }
  for (const field of ["pay", "schedule", "description", "requirements"]) {
    if (body[field] !== undefined && (typeof body[field] !== "string" || body[field].length > 4000)) return `${field} must be no longer than 4,000 characters.`;
  }
  return null;
}

app.get("/api/session", (req, res) => res.json({ user: req.user || null }));
app.get("/api/content", (req, res) => {
  const rows = db.prepare("SELECT key,value FROM site_content").all();
  res.json({ content: Object.fromEntries(rows.map(row => [row.key, row.value])) });
});
app.get("/api/admin/setup-needed", (req, res) => {
  const exists = Boolean(db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get());
  res.json({ needsSetup: LOCAL_OWNER_SETUP && !exists });
});
app.post("/api/admin/setup", authRateLimit, async (req, res) => {
  if (!LOCAL_OWNER_SETUP) return res.status(404).json({ error: "Owner setup is disabled on this server." });
  const { name, password } = req.body || {};
  const email = normalizeEmail(req.body && req.body.email);
  if (!validText(name, 80)) return res.status(400).json({ error: "Enter your name (up to 80 characters)." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: "Enter a valid email address." });
  if (typeof password !== "string" || password.length < 12 || Buffer.byteLength(password, "utf8") > 72) return res.status(400).json({ error: "Use a password with at least 12 characters." });
  const passwordHash = await bcrypt.hash(password, 12);
  db.exec("BEGIN IMMEDIATE");
  try {
    const exists = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
    if (exists) {
      db.exec("ROLLBACK");
      return res.status(409).json({ error: "The site owner has already been set up." });
    }
    const result = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'admin')").run(name.trim(), email, passwordHash);
    db.exec("COMMIT");
    const user = safeUser(db.prepare("SELECT id,name,email,role FROM users WHERE id=?").get(Number(result.lastInsertRowid)));
    createSession(user.id, res);
    return res.status(201).json({ user });
  } catch (error) {
    db.exec("ROLLBACK");
    if (String(error.message).includes("UNIQUE constraint failed")) return res.status(409).json({ error: "An account with this email already exists." });
    throw error;
  }
});
app.post("/api/auth/register", authRateLimit, async (req, res) => {
  const { name, password, role } = req.body || {};
  const email = normalizeEmail(req.body && req.body.email);
  if (!validText(name, 80)) return res.status(400).json({ error: "Enter your name (up to 80 characters)." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: "Enter a valid email address." });
  if (typeof password !== "string" || password.length < 12 || Buffer.byteLength(password, "utf8") > 72) return res.status(400).json({ error: "Use a password with at least 12 characters." });
  if (!["student", "employer"].includes(role)) return res.status(400).json({ error: "Choose a student or employer account." });
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const result = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)").run(name.trim(), email, passwordHash, role);
    const user = safeUser(db.prepare("SELECT id, name, email, role FROM users WHERE id = ?").get(Number(result.lastInsertRowid)));
    createSession(user.id, res);
    return res.status(201).json({ user });
  } catch (error) {
    if (String(error.message).includes("UNIQUE constraint failed")) return res.status(409).json({ error: "An account with this email already exists." });
    throw error;
  }
});
app.post("/api/auth/login", authRateLimit, async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  const password = req.body && req.body.password;
  if (!email || typeof password !== "string") return res.status(400).json({ error: "Enter your email and password." });
  const row = db.prepare("SELECT id, name, email, role, password_hash FROM users WHERE email = ?").get(email);
  const matches = await bcrypt.compare(password, row ? row.password_hash : DUMMY_PASSWORD_HASH);
  if (!row || !matches) return res.status(401).json({ error: "Email or password is incorrect." });
  createSession(row.id, res);
  return res.json({ user: safeUser(row) });
});
app.post("/api/auth/logout", (req, res) => {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/" });
  res.json({ ok: true });
});

app.get("/api/jobs", (req, res) => {
  const filters = ["(status = 'active' OR is_sample = 1)"];
  const values = [];
  if (typeof req.query.q === "string" && req.query.q.trim()) {
    const term = `%${req.query.q.trim().slice(0, 100)}%`;
    filters.push("(title LIKE ? OR company LIKE ? OR location LIKE ? OR type LIKE ? OR description LIKE ?)");
    values.push(term, term, term, term, term);
  }
  if (typeof req.query.location === "string" && req.query.location.trim()) {
    filters.push("location = ?");
    values.push(req.query.location.trim().slice(0, 100));
  }
  if (typeof req.query.type === "string" && req.query.type.trim() && req.query.type !== "all") {
    if (req.query.type === "Remote") filters.push("(type = ? OR location = 'Remote')"), values.push("Remote");
    else filters.push("type = ?"), values.push(req.query.type.trim().slice(0, 40));
  }
  const rows = db.prepare(`SELECT * FROM jobs WHERE ${filters.join(" AND ")} ORDER BY is_sample ASC, created_at DESC LIMIT 100`).all(...values);
  res.json({ jobs: rows.map(serializeJob) });
});
app.get("/api/jobs/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ? AND (status = 'active' OR is_sample = 1)").get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "This role is no longer available." });
  res.json({ job: serializeJob(row) });
});
app.post("/api/jobs/:id/apply", requireRole("student"), (req, res) => {
  const jobId = Number(req.params.id);
  const job = db.prepare("SELECT id, is_sample FROM jobs WHERE id = ? AND status = 'active'").get(jobId);
  if (!job || job.is_sample) return res.status(404).json({ error: "This sample or unavailable role cannot accept applications." });
  const message = typeof (req.body && req.body.message) === "string" ? req.body.message.trim() : "";
  if (message.length > 2000) return res.status(400).json({ error: "Keep your message under 2,000 characters." });
  try {
    db.prepare("INSERT INTO applications (job_id, student_id, message) VALUES (?, ?, ?)").run(jobId, req.user.id, message);
  } catch (error) {
    if (String(error.message).includes("UNIQUE constraint failed")) return res.status(409).json({ error: "You have already applied to this role." });
    throw error;
  }
  res.status(201).json({ ok: true });
});
app.get("/api/student/applications", requireRole("student"), (req, res) => {
  const rows = db.prepare(`SELECT a.id, a.message, a.status, a.created_at, j.id AS job_id, j.title, j.company, j.location
    FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.student_id = ? ORDER BY a.created_at DESC`).all(req.user.id);
  res.json({ applications: rows });
});
app.get("/api/employer/jobs", requireRole("employer"), (req, res) => {
  const rows = db.prepare("SELECT * FROM jobs WHERE owner_id = ? ORDER BY created_at DESC").all(req.user.id);
  res.json({ jobs: rows.map(serializeJob) });
});
app.get("/api/employer/applications", requireRole("employer"), (req, res) => {
  const rows = db.prepare(`SELECT a.id, a.job_id, a.message, a.status, a.created_at, j.title, u.name AS student_name, u.email AS student_email
    FROM applications a JOIN jobs j ON j.id = a.job_id JOIN users u ON u.id = a.student_id
    WHERE j.owner_id = ? ORDER BY a.created_at DESC`).all(req.user.id);
  res.json({ applications: rows });
});
app.patch("/api/employer/applications/:id", requireRole("employer"), (req, res) => {
  const { status } = req.body || {};
  if (!["reviewing", "accepted", "declined"].includes(status)) return res.status(400).json({ error: "Choose reviewing, accepted, or declined." });
  const result = db.prepare(`UPDATE applications SET status=? WHERE id=? AND job_id IN (SELECT id FROM jobs WHERE owner_id=?)`)
    .run(status, Number(req.params.id), req.user.id);
  if (!result.changes) return res.status(404).json({ error: "Application not found." });
  res.json({ ok: true });
});
app.post("/api/employer/jobs", requireRole("employer"), (req, res) => {
  const error = getJobInput(req.body || {});
  if (error) return res.status(400).json({ error });
  const body = req.body;
  const result = db.prepare(`INSERT INTO jobs (owner_id,title,company,location,type,pay,schedule,description,requirements,status)
    VALUES (?,?,?,?,?,?,?,?,?,'pending')`).run(req.user.id, body.title.trim(), body.company.trim(), body.location.trim(), body.type.trim(), (body.pay || "").trim(), (body.schedule || "").trim(), (body.description || "").trim(), (body.requirements || "").trim());
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(Number(result.lastInsertRowid));
  res.status(201).json({ job: serializeJob(row) });
});
app.patch("/api/employer/jobs/:id", requireRole("employer"), (req, res) => {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ? AND owner_id = ? AND status IN ('pending','active')").get(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: "Listing not found or cannot be edited." });
  const body = { ...row, ...req.body };
  const error = getJobInput(body);
  if (error) return res.status(400).json({ error });
  db.prepare(`UPDATE jobs SET title=?,company=?,location=?,type=?,pay=?,schedule=?,description=?,requirements=?,status='pending',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND owner_id=?`)
    .run(body.title.trim(), body.company.trim(), body.location.trim(), body.type.trim(), (body.pay || "").trim(), (body.schedule || "").trim(), (body.description || "").trim(), (body.requirements || "").trim(), row.id, req.user.id);
  res.json({ job: serializeJob(db.prepare("SELECT * FROM jobs WHERE id=?").get(row.id)) });
});
app.delete("/api/employer/jobs/:id", requireRole("employer"), (req, res) => {
  const result = db.prepare("DELETE FROM jobs WHERE id=? AND owner_id=? AND status='pending'").run(Number(req.params.id), req.user.id);
  if (!result.changes) return res.status(409).json({ error: "Only pending listings can be removed. Ask an administrator to close a published listing." });
  res.json({ ok: true });
});
app.get("/api/admin/jobs", requireRole("admin"), (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : "pending";
  if (!["pending", "active", "closed", "rejected", "all"].includes(status)) return res.status(400).json({ error: "Unknown listing status." });
  const rows = status === "all" ? db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all() : db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC").all(status);
  res.json({ jobs: rows.map(serializeJob) });
});
app.patch("/api/admin/content", requireRole("admin"), (req, res) => {
  const { title, description } = req.body || {};
  if (!validText(title, 90) || !validText(description, 240)) return res.status(400).json({ error: "Add a headline (up to 90 characters) and introduction (up to 240 characters)." });
  const save = db.prepare("INSERT INTO site_content (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  save.run("home_title", title.trim());
  save.run("home_description", description.trim());
  res.json({ content: { home_title: title.trim(), home_description: description.trim() } });
});
app.patch("/api/admin/jobs/:id/status", requireRole("admin"), (req, res) => {
  const { status } = req.body || {};
  if (!["active", "closed", "rejected"].includes(status)) return res.status(400).json({ error: "Choose active, closed, or rejected." });
  const result = db.prepare("UPDATE jobs SET status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(status, Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: "Listing not found." });
  res.json({ ok: true });
});
app.get("/api/admin/users", requireRole("admin"), (req, res) => {
  const users = db.prepare("SELECT id,name,email,role,created_at FROM users ORDER BY created_at DESC LIMIT 500").all();
  res.json({ users });
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found." });
  res.status(404).type("text").send("Page not found.");
});
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof SyntaxError && "body" in error) return res.status(400).json({ error: "Request body must be valid JSON." });
  console.error(error);
  res.status(500).json({ error: "The server could not complete that request." });
});

async function initialize() {
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD;
  if (email && password) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || Buffer.byteLength(password, "utf8") > 72) {
      throw new Error("ADMIN_EMAIL must be valid and ADMIN_PASSWORD must be at least 12 characters (maximum 72 bytes).");
    }
    const existing = db.prepare("SELECT id, role FROM users WHERE email=?").get(email);
    if (!existing) {
      const hash = await bcrypt.hash(password, 12);
      db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'admin')").run("UniWork administrator", email, hash);
      console.log(`Created the UniWork administrator account for ${email}. Remove ADMIN_PASSWORD from .env now.`);
    } else if (existing.role !== "admin") {
      throw new Error("ADMIN_EMAIL already belongs to a non-administrator account.");
    }
  }
  const saveDefaultContent = db.prepare("INSERT OR IGNORE INTO site_content (key,value) VALUES (?,?)");
  saveDefaultContent.run("home_title", "Make your next move matter.");
  saveDefaultContent.run("home_description", "Good work should fit around your studies. Find thoughtful internships and part-time roles from employers who want to see students thrive.");
  const count = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE is_sample=1").get().count;
  if (!count) {
    const seed = db.prepare(`INSERT INTO jobs (title,company,location,type,pay,schedule,description,requirements,status,is_sample)
      VALUES (?,?,?,?,?,?,?,?,'active',1)`);
    const examples = [
      ["Junior Content & Social Assistant","Common Ground Studio","Kampala","Part-time","UGX 450k–650k / month","Flexible weekly schedule","Sample listing for layout preview.","Replace this sample with a real employer listing."],
      ["Product Design Intern","Open Field Digital","Remote","Internship","UGX 600k / month","Remote","Sample listing for layout preview.","Replace this sample with a real employer listing."],
      ["Research & Insights Intern","Lakeview Collective","Entebbe","Internship","Flexible hours","Part-time schedule","Sample listing for layout preview.","Replace this sample with a real employer listing."],
      ["Weekend Community Associate","Good Day Market","Jinja","Part-time","UGX 18k / hour","Weekends","Sample listing for layout preview.","Replace this sample with a real employer listing."]
    ];
    for (const example of examples) seed.run(...example);
  }
}

initialize().then(() => {
  app.listen(PORT, HOST, () => {
    console.log(`UniWork is running at http://${HOST}:${PORT}`);
    console.log("Student and employer registration is open. Configure ADMIN_EMAIL and ADMIN_PASSWORD for owner access.");
  });
}).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
