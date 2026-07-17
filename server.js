/**
 * ============================================================================
 *  GREAT MINDS ACADEMY — Student Result Computing System
 *  Single-file backend (Node.js + Express + PostgreSQL)
 * ============================================================================
 *
 *  This entire backend — server, database config, middleware, auth,
 *  routes, grading logic, and PDF generation — lives in this ONE file
 *  on purpose, so there is nothing that can go missing when you upload
 *  to GitHub or deploy on Render.
 *
 *  FILES YOU NEED (only 3):
 *    1. server.js        <- this file
 *    2. package.json      <- dependency list (provided separately)
 *    3. .env               <- your real environment variables (not committed)
 *
 *  RENDER DEPLOYMENT
 *  ------------------
 *  1. Push server.js + package.json to a GitHub repo.
 *  2. Render → New → Web Service → connect the repo.
 *       Build command: npm install
 *       Start command: npm start
 *  3. Render → New → PostgreSQL → create a free database, copy its
 *     "Internal Database URL".
 *  4. On the Web Service → Environment tab, add:
 *       DATABASE_URL     = <the Internal Database URL from step 3>
 *       DATABASE_SSL     = true
 *       JWT_SECRET       = <any long random string>
 *       CORS_ORIGIN      = https://your-frontend.vercel.app
 *       AUTO_MIGRATE     = true      (creates all tables on first boot)
 *       AUTO_SEED_ADMIN  = true      (creates your first Admin login)
 *       ADMIN_EMAIL      = admin@greatmindsacademy.edu.ng
 *       ADMIN_PASSWORD   = ChangeMe123!
 *  5. Deploy. Watch the logs — on first boot you should see:
 *       ✅ Database schema is ready.
 *       ✅ Default admin account ready: admin@greatmindsacademy.edu.ng
 *       🚀 Great Minds Academy API listening on port 10000
 *  6. After the first successful deploy, you can set AUTO_MIGRATE and
 *     AUTO_SEED_ADMIN back to "false" (they are safe to leave on too —
 *     both are idempotent and will not duplicate data).
 *
 *  Health check URL for Render: GET /api/health
 * ============================================================================
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const PDFDocument = require('pdfkit');

// ============================================================================
// 1. DATABASE
// ============================================================================

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set. Add it in your Render Environment tab (or .env locally).');
}

const useSSL =
  String(process.env.DATABASE_SSL).toLowerCase() === 'true' || process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL error:', err);
});

const db = (text, params) => pool.query(text, params);

const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name     VARCHAR(120) NOT NULL,
  email         VARCHAR(160) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'teacher', 'principal')),
  phone         VARCHAR(30),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS classes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(60) NOT NULL UNIQUE,
  teacher_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  capacity     INTEGER NOT NULL DEFAULT 40,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subjects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(80) NOT NULL UNIQUE,
  category    VARCHAR(30) NOT NULL DEFAULT 'Core',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS students (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name      VARCHAR(120) NOT NULL,
  admission_no   VARCHAR(40) NOT NULL UNIQUE,
  gender         VARCHAR(10) NOT NULL DEFAULT 'Unspecified',
  guardian_name  VARCHAR(120),
  guardian_phone VARCHAR(30),
  class_id       UUID NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id);

CREATE TABLE IF NOT EXISTS results (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_id     UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  class_id       UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  term           VARCHAR(20) NOT NULL CHECK (term IN ('First Term', 'Second Term', 'Third Term')),
  session        VARCHAR(20) NOT NULL,
  ca1            NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (ca1 >= 0),
  ca2            NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (ca2 >= 0),
  ca3            NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (ca3 >= 0),
  exam_score     NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (exam_score >= 0),
  ca_total       NUMERIC(6,2) GENERATED ALWAYS AS (ca1 + ca2 + ca3) STORED,
  overall_total  NUMERIC(6,2) GENERATED ALWAYS AS (ca1 + ca2 + ca3 + exam_score) STORED,
  grade VARCHAR(2) GENERATED ALWAYS AS (
    CASE
      WHEN (ca1 + ca2 + ca3 + exam_score) >= 70 THEN 'A'
      WHEN (ca1 + ca2 + ca3 + exam_score) >= 60 THEN 'B'
      WHEN (ca1 + ca2 + ca3 + exam_score) >= 50 THEN 'C'
      WHEN (ca1 + ca2 + ca3 + exam_score) >= 45 THEN 'D'
      WHEN (ca1 + ca2 + ca3 + exam_score) >= 40 THEN 'E'
      ELSE 'F'
    END
  ) STORED,
  remark VARCHAR(20) GENERATED ALWAYS AS (
    CASE
      WHEN (ca1 + ca2 + ca3 + exam_score) >= 70 THEN 'Excellent'
      WHEN (ca1 + ca2 + ca3 + exam_score) >= 60 THEN 'Very Good'
      WHEN (ca1 + ca2 + ca3 + exam_score) >= 50 THEN 'Good'
      WHEN (ca1 + ca2 + ca3 + exam_score) >= 45 THEN 'Credit'
      WHEN (ca1 + ca2 + ca3 + exam_score) >= 40 THEN 'Pass'
      ELSE 'Fail'
    END
  ) STORED,
  recorded_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, subject_id, term, session)
);

CREATE INDEX IF NOT EXISTS idx_results_lookup ON results(class_id, subject_id, term, session);
CREATE INDEX IF NOT EXISTS idx_results_student ON results(student_id, term, session);

CREATE TABLE IF NOT EXISTS term_reports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id        UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  term              VARCHAR(20) NOT NULL,
  session           VARCHAR(20) NOT NULL,
  teacher_remark    TEXT,
  principal_remark  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, term, session)
);
`;

async function runMigration() {
  console.log('▶ Applying database schema...');
  await db(SCHEMA_SQL);
  console.log('✅ Database schema is ready.');
}

async function seedAdmin() {
  const name = process.env.ADMIN_NAME || 'School Administrator';
  const email = (process.env.ADMIN_EMAIL || 'admin@greatmindsacademy.edu.ng').toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

  const existing = await db('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    console.log(`ℹ️  Admin account already exists (${email}).`);
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  await db(
    `INSERT INTO users (full_name, email, password_hash, role) VALUES ($1, $2, $3, 'admin')`,
    [name, email, passwordHash]
  );
  console.log(`✅ Default admin account ready: ${email} (change the password after first login)`);
}

// ============================================================================
// 2. GRADING HELPERS
// ============================================================================

const CA1_MAX = Number(process.env.CA1_MAX) || 10;
const CA2_MAX = Number(process.env.CA2_MAX) || 10;
const CA3_MAX = Number(process.env.CA3_MAX) || 10;
const EXAM_MAX = Number(process.env.EXAM_MAX) || 70;

function gradeFromScore(score) {
  const total = Number(score) || 0;
  if (total >= 70) return { grade: 'A', remark: 'Excellent' };
  if (total >= 60) return { grade: 'B', remark: 'Very Good' };
  if (total >= 50) return { grade: 'C', remark: 'Good' };
  if (total >= 45) return { grade: 'D', remark: 'Credit' };
  if (total >= 40) return { grade: 'E', remark: 'Pass' };
  return { grade: 'F', remark: 'Fail' };
}

function ordinal(n) {
  const num = Number(n);
  if (!num) return '—';
  const s = ['th', 'st', 'nd', 'rd'];
  const v = num % 100;
  return num + (s[(v - 20) % 10] || s[v] || s[0]);
}

function validateScores({ ca1, ca2, ca3, examScore }) {
  if (ca1 > CA1_MAX || ca2 > CA2_MAX || ca3 > CA3_MAX || examScore > EXAM_MAX) {
    return `Scores exceed configured maximums (CA1 ≤ ${CA1_MAX}, CA2 ≤ ${CA2_MAX}, CA3 ≤ ${CA3_MAX}, Exam ≤ ${EXAM_MAX}).`;
  }
  if ([ca1, ca2, ca3, examScore].some((v) => v < 0)) return 'Scores cannot be negative.';
  return null;
}

// ============================================================================
// 3. MIDDLEWARE
// ============================================================================

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function protect(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.split(' ')[1] : null;
    if (!token) return res.status(401).json({ success: false, message: 'Not authorized. No token provided.' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await db(
      'SELECT id, full_name, email, role, phone, is_active FROM users WHERE id = $1',
      [decoded.id]
    );
    if (rows.length === 0 || !rows[0].is_active) {
      return res.status(401).json({ success: false, message: 'Account no longer exists or is disabled.' });
    }
    req.user = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Not authorized. Invalid or expired token.' });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'Not authorized.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: `Role '${req.user.role}' cannot perform this action.` });
    }
    next();
  };
}

function generateToken(user) {
  return jwt.sign({ id: user.id, role: user.role, email: user.email }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

function notFound(req, res, next) {
  res.status(404);
  next(new Error(`Route not found: ${req.method} ${req.originalUrl}`));
}

function errorHandler(err, req, res, next) {
  let statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;
  let message = err.message || 'Internal server error';

  if (err.code === '23505') { statusCode = 409; message = 'A record with this value already exists.'; }
  if (err.code === '23503') { statusCode = 400; message = 'Referenced record does not exist.'; }
  if (err.code === '23514') { statusCode = 400; message = 'One of the submitted values is not allowed.'; }

  res.status(statusCode).json({
    success: false,
    message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  });
}

// ============================================================================
// 4. EXPRESS APP
// ============================================================================

const app = express();

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== 'production') app.use(morgan('dev'));

const allowedOrigins = (process.env.CORS_ORIGIN || '*').split(',').map((o) => o.trim()).filter(Boolean);
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);

app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Great Minds Academy API is running.', time: new Date().toISOString() });
});
app.get('/', (req, res) => {
  res.json({ success: true, message: 'Great Minds Academy Result Computing System API', docs: '/api/health' });
});

// ----------------------------------------------------------------------------
// 4a. AUTH ROUTES
// ----------------------------------------------------------------------------
const ALLOWED_ROLES = ['admin', 'teacher', 'principal'];

app.post('/api/auth/register', asyncHandler(async (req, res) => {
  const { fullName, email, password, role, phone } = req.body;
  if (!fullName || !email || !password || !role) {
    return res.status(400).json({ success: false, message: 'fullName, email, password and role are required.' });
  }
  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(400).json({ success: false, message: `role must be one of: ${ALLOWED_ROLES.join(', ')}` });
  }
  if (password.length < 6) {
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
  }

  const cleanEmail = email.toLowerCase().trim();
  const existing = await db('SELECT id FROM users WHERE email = $1', [cleanEmail]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await db(
    `INSERT INTO users (full_name, email, password_hash, role, phone)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, full_name, email, role, phone, is_active, created_at`,
    [fullName.trim(), cleanEmail, passwordHash, role, phone || null]
  );
  const user = rows[0];
  res.status(201).json({ success: true, message: 'Account created successfully.', token: generateToken(user), user });
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required.' });

  const { rows } = await db('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
  const user = rows[0];
  if (!user || !user.is_active) return res.status(401).json({ success: false, message: 'Invalid email or password.' });

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid email or password.' });

  const { password_hash, ...safeUser } = user;
  res.json({ success: true, message: 'Login successful.', token: generateToken(user), user: safeUser });
}));

app.get('/api/auth/me', protect, asyncHandler(async (req, res) => {
  res.json({ success: true, user: req.user });
}));

// ----------------------------------------------------------------------------
// 4b. CLASS ROUTES
// ----------------------------------------------------------------------------
app.get('/api/classes', protect, asyncHandler(async (req, res) => {
  const { rows } = await db(
    `SELECT c.*, u.full_name AS teacher_name,
            (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) AS student_count
     FROM classes c LEFT JOIN users u ON u.id = c.teacher_id
     ORDER BY c.name ASC`
  );
  res.json({ success: true, count: rows.length, data: rows });
}));

app.get('/api/classes/:id', protect, asyncHandler(async (req, res) => {
  const { rows } = await db(
    `SELECT c.*, u.full_name AS teacher_name FROM classes c
     LEFT JOIN users u ON u.id = c.teacher_id WHERE c.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ success: false, message: 'Class not found.' });
  res.json({ success: true, data: rows[0] });
}));

app.post('/api/classes', protect, authorize('admin'), asyncHandler(async (req, res) => {
  const { name, teacherId, capacity } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Class name is required.' });
  const { rows } = await db(
    `INSERT INTO classes (name, teacher_id, capacity) VALUES ($1,$2,COALESCE($3,40)) RETURNING *`,
    [name, teacherId || null, capacity || null]
  );
  res.status(201).json({ success: true, data: rows[0] });
}));

app.put('/api/classes/:id', protect, authorize('admin'), asyncHandler(async (req, res) => {
  const { name, teacherId, capacity } = req.body;
  const { rows } = await db(
    `UPDATE classes SET name=COALESCE($1,name), teacher_id=COALESCE($2,teacher_id), capacity=COALESCE($3,capacity)
     WHERE id=$4 RETURNING *`,
    [name || null, teacherId || null, capacity || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ success: false, message: 'Class not found.' });
  res.json({ success: true, data: rows[0] });
}));

app.delete('/api/classes/:id', protect, authorize('admin'), asyncHandler(async (req, res) => {
  const { rowCount } = await db('DELETE FROM classes WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ success: false, message: 'Class not found.' });
  res.json({ success: true, message: 'Class deleted.' });
}));

// ----------------------------------------------------------------------------
// 4c. SUBJECT ROUTES
// ----------------------------------------------------------------------------
app.get('/api/subjects', protect, asyncHandler(async (req, res) => {
  const { rows } = await db('SELECT * FROM subjects ORDER BY name ASC');
  res.json({ success: true, count: rows.length, data: rows });
}));

app.post('/api/subjects', protect, authorize('admin'), asyncHandler(async (req, res) => {
  const { name, category } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Subject name is required.' });
  const { rows } = await db(
    `INSERT INTO subjects (name, category) VALUES ($1, COALESCE($2,'Core')) RETURNING *`,
    [name, category || null]
  );
  res.status(201).json({ success: true, data: rows[0] });
}));

app.put('/api/subjects/:id', protect, authorize('admin'), asyncHandler(async (req, res) => {
  const { name, category } = req.body;
  const { rows } = await db(
    `UPDATE subjects SET name=COALESCE($1,name), category=COALESCE($2,category) WHERE id=$3 RETURNING *`,
    [name || null, category || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ success: false, message: 'Subject not found.' });
  res.json({ success: true, data: rows[0] });
}));

app.delete('/api/subjects/:id', protect, authorize('admin'), asyncHandler(async (req, res) => {
  const { rowCount } = await db('DELETE FROM subjects WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ success: false, message: 'Subject not found.' });
  res.json({ success: true, message: 'Subject deleted.' });
}));

// ----------------------------------------------------------------------------
// 4d. STUDENT ROUTES
// ----------------------------------------------------------------------------
app.get('/api/students', protect, asyncHandler(async (req, res) => {
  const { classId, search } = req.query;
  const conditions = [];
  const params = [];
  if (classId) { params.push(classId); conditions.push(`s.class_id = $${params.length}`); }
  if (search) { params.push(`%${search}%`); conditions.push(`(s.full_name ILIKE $${params.length} OR s.admission_no ILIKE $${params.length})`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await db(
    `SELECT s.*, c.name AS class_name FROM students s JOIN classes c ON c.id = s.class_id
     ${where} ORDER BY s.full_name ASC`,
    params
  );
  res.json({ success: true, count: rows.length, data: rows });
}));

app.get('/api/students/:id', protect, asyncHandler(async (req, res) => {
  const { rows } = await db(
    `SELECT s.*, c.name AS class_name FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ success: false, message: 'Student not found.' });
  res.json({ success: true, data: rows[0] });
}));

app.post('/api/students', protect, authorize('admin', 'teacher'), asyncHandler(async (req, res) => {
  const { fullName, admissionNo, gender, guardianName, guardianPhone, classId } = req.body;
  if (!fullName || !admissionNo || !classId) {
    return res.status(400).json({ success: false, message: 'fullName, admissionNo and classId are required.' });
  }
  const { rows } = await db(
    `INSERT INTO students (full_name, admission_no, gender, guardian_name, guardian_phone, class_id)
     VALUES ($1,$2,COALESCE($3,'Unspecified'),$4,$5,$6) RETURNING *`,
    [fullName, admissionNo, gender || null, guardianName || null, guardianPhone || null, classId]
  );
  res.status(201).json({ success: true, data: rows[0] });
}));

app.put('/api/students/:id', protect, authorize('admin', 'teacher'), asyncHandler(async (req, res) => {
  const { fullName, admissionNo, gender, guardianName, guardianPhone, classId } = req.body;
  const { rows } = await db(
    `UPDATE students SET
       full_name=COALESCE($1,full_name), admission_no=COALESCE($2,admission_no),
       gender=COALESCE($3,gender), guardian_name=COALESCE($4,guardian_name),
       guardian_phone=COALESCE($5,guardian_phone), class_id=COALESCE($6,class_id)
     WHERE id=$7 RETURNING *`,
    [fullName || null, admissionNo || null, gender || null, guardianName || null, guardianPhone || null, classId || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ success: false, message: 'Student not found.' });
  res.json({ success: true, data: rows[0] });
}));

app.delete('/api/students/:id', protect, authorize('admin'), asyncHandler(async (req, res) => {
  const { rowCount } = await db('DELETE FROM students WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ success: false, message: 'Student not found.' });
  res.json({ success: true, message: 'Student deleted.' });
}));

// ----------------------------------------------------------------------------
// 4e. RESULT (SCORE ENTRY) ROUTES
// ----------------------------------------------------------------------------
async function upsertOneResult({ studentId, subjectId, classId, term, session, ca1, ca2, ca3, examScore, recordedBy }) {
  const { rows } = await db(
    `INSERT INTO results (student_id, subject_id, class_id, term, session, ca1, ca2, ca3, exam_score, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (student_id, subject_id, term, session)
     DO UPDATE SET ca1=EXCLUDED.ca1, ca2=EXCLUDED.ca2, ca3=EXCLUDED.ca3,
                    exam_score=EXCLUDED.exam_score, recorded_by=EXCLUDED.recorded_by, updated_at=now()
     RETURNING *`,
    [studentId, subjectId, classId, term, session, ca1 || 0, ca2 || 0, ca3 || 0, examScore || 0, recordedBy || null]
  );
  return rows[0];
}

app.post('/api/results', protect, authorize('admin', 'teacher'), asyncHandler(async (req, res) => {
  const { studentId, subjectId, classId, term, session, ca1 = 0, ca2 = 0, ca3 = 0, examScore = 0 } = req.body;
  if (!studentId || !subjectId || !classId || !term || !session) {
    return res.status(400).json({ success: false, message: 'studentId, subjectId, classId, term and session are required.' });
  }
  const validationError = validateScores({ ca1, ca2, ca3, examScore });
  if (validationError) return res.status(400).json({ success: false, message: validationError });

  const saved = await upsertOneResult({ studentId, subjectId, classId, term, session, ca1, ca2, ca3, examScore, recordedBy: req.user.id });
  res.json({ success: true, data: saved });
}));

app.post('/api/results/bulk', protect, authorize('admin', 'teacher'), asyncHandler(async (req, res) => {
  const { classId, subjectId, term, session, scores } = req.body;
  if (!classId || !subjectId || !term || !session || !Array.isArray(scores) || scores.length === 0) {
    return res.status(400).json({ success: false, message: 'classId, subjectId, term, session and a non-empty scores[] array are required.' });
  }
  for (const s of scores) {
    const err = validateScores({ ca1: s.ca1 || 0, ca2: s.ca2 || 0, ca3: s.ca3 || 0, examScore: s.examScore || 0 });
    if (err) return res.status(400).json({ success: false, message: `${err} (student ${s.studentId})` });
  }
  const saved = [];
  for (const s of scores) {
    saved.push(await upsertOneResult({
      studentId: s.studentId, subjectId, classId, term, session,
      ca1: s.ca1 || 0, ca2: s.ca2 || 0, ca3: s.ca3 || 0, examScore: s.examScore || 0, recordedBy: req.user.id,
    }));
  }
  res.json({ success: true, count: saved.length, data: saved });
}));

app.get('/api/results/class/:classId/subject/:subjectId', protect, asyncHandler(async (req, res) => {
  const { classId, subjectId } = req.params;
  const { term, session } = req.query;
  if (!term || !session) return res.status(400).json({ success: false, message: 'term and session query parameters are required.' });
  const { rows } = await db(
    `SELECT r.*, s.full_name AS student_name, s.admission_no,
            RANK() OVER (ORDER BY r.overall_total DESC) AS subject_position
     FROM results r JOIN students s ON s.id = r.student_id
     WHERE r.class_id=$1 AND r.subject_id=$2 AND r.term=$3 AND r.session=$4
     ORDER BY s.full_name ASC`,
    [classId, subjectId, term, session]
  );
  res.json({ success: true, count: rows.length, data: rows });
}));

app.get('/api/results/class/:classId/averages', protect, asyncHandler(async (req, res) => {
  const { classId } = req.params;
  const { term, session } = req.query;
  if (!term || !session) return res.status(400).json({ success: false, message: 'term and session query parameters are required.' });
  const { rows } = await db(
    `SELECT sub.name AS subject_name, ROUND(AVG(r.overall_total),1) AS average
     FROM results r JOIN subjects sub ON sub.id = r.subject_id
     WHERE r.class_id=$1 AND r.term=$2 AND r.session=$3
     GROUP BY sub.name ORDER BY sub.name ASC`,
    [classId, term, session]
  );
  res.json({ success: true, data: rows });
}));

app.delete('/api/results/:id', protect, authorize('admin', 'teacher'), asyncHandler(async (req, res) => {
  const { rowCount } = await db('DELETE FROM results WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ success: false, message: 'Result not found.' });
  res.json({ success: true, message: 'Result deleted.' });
}));

// ----------------------------------------------------------------------------
// 4f. REPORTS (result sheet JSON, remarks, single-page A4 PDF)
// ----------------------------------------------------------------------------
async function buildResultSheet(studentId, term, session) {
  const { rows: studentRows } = await db(
    `SELECT s.*, c.name AS class_name FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = $1`,
    [studentId]
  );
  const student = studentRows[0];
  if (!student) return null;

  const { rows: subjectRows } = await db(
    `WITH ranked AS (
       SELECT r.*, RANK() OVER (PARTITION BY r.subject_id ORDER BY r.overall_total DESC) AS subject_position
       FROM results r
       WHERE r.class_id = (SELECT class_id FROM students WHERE id = $1) AND r.term = $2 AND r.session = $3
     )
     SELECT ranked.*, sub.name AS subject_name
     FROM ranked JOIN subjects sub ON sub.id = ranked.subject_id
     WHERE ranked.student_id = $1 ORDER BY sub.name ASC`,
    [studentId, term, session]
  );

  const { rows: posRows } = await db(
    `WITH averages AS (
       SELECT student_id, AVG(overall_total) AS avg_score, COUNT(*) AS subject_count
       FROM results
       WHERE class_id = (SELECT class_id FROM students WHERE id = $1) AND term = $2 AND session = $3
       GROUP BY student_id
     ), ranked AS (
       SELECT *, RANK() OVER (ORDER BY avg_score DESC) AS class_position, COUNT(*) OVER () AS class_size
       FROM averages
     )
     SELECT * FROM ranked WHERE student_id = $1`,
    [studentId, term, session]
  );
  const classPosition = posRows[0] || null;

  const { rows: reportRows } = await db(
    `SELECT * FROM term_reports WHERE student_id=$1 AND term=$2 AND session=$3`,
    [studentId, term, session]
  );
  const termReport = reportRows[0] || null;

  const totalObtainable = subjectRows.length * 100;
  const totalObtained = subjectRows.reduce((sum, r) => sum + Number(r.overall_total), 0);
  const average = subjectRows.length ? totalObtained / subjectRows.length : 0;
  const overallGrade = gradeFromScore(average);
  const percentage = totalObtainable ? Math.round((totalObtained / totalObtainable) * 100) : 0;

  return {
    student,
    term,
    session,
    subjects: subjectRows.map((r) => ({
      subjectName: r.subject_name,
      ca1: Number(r.ca1), ca2: Number(r.ca2), ca3: Number(r.ca3),
      caTotal: Number(r.ca_total), examScore: Number(r.exam_score), overallTotal: Number(r.overall_total),
      grade: r.grade, remark: r.remark, subjectPosition: ordinal(r.subject_position),
    })),
    summary: {
      totalObtainable, totalObtained, average: Number(average.toFixed(1)), percentage,
      overallGrade: overallGrade.grade, overallRemark: overallGrade.remark,
      classPosition: classPosition ? ordinal(classPosition.class_position) : '—',
      classSize: classPosition ? Number(classPosition.class_size) : 0,
    },
    remarks: {
      teacherRemark: termReport?.teacher_remark || null,
      principalRemark: termReport?.principal_remark || null,
    },
  };
}

app.get('/api/reports/:studentId/sheet', protect, asyncHandler(async (req, res) => {
  const { term, session } = req.query;
  if (!term || !session) return res.status(400).json({ success: false, message: 'term and session query parameters are required.' });
  const sheet = await buildResultSheet(req.params.studentId, term, session);
  if (!sheet) return res.status(404).json({ success: false, message: 'Student not found.' });
  res.json({ success: true, data: sheet });
}));

app.post('/api/reports/:studentId/remarks', protect, authorize('admin', 'teacher', 'principal'), asyncHandler(async (req, res) => {
  const { term, session, teacherRemark, principalRemark } = req.body;
  if (!term || !session) return res.status(400).json({ success: false, message: 'term and session are required.' });
  if (req.user.role === 'teacher' && principalRemark) {
    return res.status(403).json({ success: false, message: 'Teachers cannot set the principal remark.' });
  }
  const { rows } = await db(
    `INSERT INTO term_reports (student_id, term, session, teacher_remark, principal_remark)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (student_id, term, session)
     DO UPDATE SET teacher_remark = COALESCE(EXCLUDED.teacher_remark, term_reports.teacher_remark),
                    principal_remark = COALESCE(EXCLUDED.principal_remark, term_reports.principal_remark)
     RETURNING *`,
    [req.params.studentId, term, session, teacherRemark || null, principalRemark || null]
  );
  res.json({ success: true, data: rows[0] });
}));

app.get('/api/reports/:studentId/pdf', protect, asyncHandler(async (req, res) => {
  const { term, session } = req.query;
  if (!term || !session) return res.status(400).json({ success: false, message: 'term and session query parameters are required.' });

  const sheet = await buildResultSheet(req.params.studentId, term, session);
  if (!sheet) return res.status(404).json({ success: false, message: 'Student not found.' });

  const fileName = `${sheet.student.full_name.replace(/\s+/g, '_')}_${term.replace(/\s+/g, '_')}_Result.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  renderResultSheetPDF(sheet, res);
}));
const puppeteer = require('puppeteer');

app.get('/api/reports/:studentId/pdf', async (req, res) => {
  try {
    const { studentId } = req.params;

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    // Replace with your actual frontend result URL
    const resultUrl = `${process.env.FRONTEND_URL}/results/${studentId}`;

    await page.goto(resultUrl, {
      waitUntil: 'networkidle0'
    });

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '0',
        right: '0',
        bottom: '0',
        left: '0'
      }
    });

    await browser.close();

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename=result-${studentId}.pdf`
    });

    res.send(pdf);

  } catch (error) {
    console.error('PDF generation failed:', error);
    res.status(500).json({
      error: 'Failed to generate PDF'
    });
  }
});

const NAVY = '#16233F', NAVY_DEEP = '#0B1424', GOLD = '#B08D57', GOLD_LIGHT = '#D9BE8E';
const CREAM = '#FBF7EE', INK = '#22262E', INK_SOFT = '#666C78';
const PAGE_MARGIN = 28;

function renderResultSheetPDF(sheet, res) {
  const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: false });
  doc.pipe(res);

  const pageWidth = doc.page.width, pageHeight = doc.page.height;
  const contentWidth = pageWidth - PAGE_MARGIN * 2;
  const subjectCount = sheet.subjects.length || 1;

  const HEADER_H = 66, DIVIDER_H = 4, INFO_H = 54, TABLE_HEAD_H = 20, GAP = 8;
  const SUMMARY_H = 108, REMARKS_H = 70, FOOTER_H = 34;

  const fixedOverhead = HEADER_H + DIVIDER_H + INFO_H + TABLE_HEAD_H + SUMMARY_H + REMARKS_H + FOOTER_H + GAP * 6;
  const usableHeight = pageHeight - PAGE_MARGIN * 2;
  const availableForRows = Math.max(usableHeight - fixedOverhead, subjectCount * 10);
  const rowHeight = Math.min(22, Math.max(11, availableForRows / subjectCount));
  const rowFontSize = rowHeight < 14 ? 6.5 : rowHeight < 18 ? 8 : 9;

  let y = PAGE_MARGIN;

  // HEADER
  doc.rect(PAGE_MARGIN, y, contentWidth, HEADER_H).fill(CREAM);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(20).text('GREAT MINDS ACADEMY', PAGE_MARGIN + 10, y + 10, { width: contentWidth - 190 });
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(9).text('— A C A D E M Y —', PAGE_MARGIN + 10, y + 32);
  doc.fillColor(NAVY).font('Helvetica').fontSize(8).text('LEARN  ·  LEAD  ·  SUCCEED', PAGE_MARGIN + 10, y + 46);

  const boxW = 170, boxX = PAGE_MARGIN + contentWidth - boxW;
  doc.roundedRect(boxX, y, boxW, HEADER_H, 6).fill(NAVY_DEEP);
  doc.fillColor(GOLD_LIGHT).font('Helvetica-Bold').fontSize(10).text('TERM REPORT CARD', boxX, y + 10, { width: boxW, align: 'center' });
  doc.fillColor('#FFFFFF').font('Helvetica').fontSize(8).text(`${sheet.session} SESSION`, boxX, y + 25, { width: boxW, align: 'center' });
  doc.roundedRect(boxX + boxW / 2 - 45, y + 40, 90, 16, 8).fill(GOLD);
  doc.fillColor(NAVY_DEEP).font('Helvetica-Bold').fontSize(8).text(sheet.term.toUpperCase(), boxX + boxW / 2 - 45, y + 44, { width: 90, align: 'center' });

  y += HEADER_H + GAP;
  doc.rect(PAGE_MARGIN, y, contentWidth, DIVIDER_H).fill(GOLD);
  y += DIVIDER_H + GAP;

  // INFO BOX
  doc.roundedRect(PAGE_MARGIN, y, contentWidth, INFO_H, 6).strokeColor(GOLD).lineWidth(1).stroke();
  const colW = contentWidth / 2;
  const infoLeft = [["STUDENT'S NAME", sheet.student.full_name.toUpperCase()], ['ADMISSION NO.', sheet.student.admission_no], ['CLASS', sheet.student.class_name.toUpperCase()]];
  const infoRight = [['TERM', sheet.term.toUpperCase()], ['ACADEMIC SESSION', sheet.session], ['DATE ISSUED', new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }).toUpperCase()]];
  [infoLeft, infoRight].forEach((col, i) => {
    let ry = y + 8;
    col.forEach(([k, v]) => {
      doc.fillColor(INK_SOFT).font('Helvetica-Bold').fontSize(6.5).text(k, PAGE_MARGIN + 12 + i * colW, ry);
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(8.5).text(v, PAGE_MARGIN + 12 + i * colW, ry + 8);
      ry += 15;
    });
  });
  y += INFO_H + GAP;

  // TABLE
  const cols = [
    { label: 'S/N', w: 0.05 }, { label: 'SUBJECT', w: 0.23 }, { label: '1ST CA', w: 0.09 },
    { label: '2ND CA', w: 0.09 }, { label: '3RD CA', w: 0.09 }, { label: 'CA TOTAL', w: 0.11 },
    { label: 'EXAM', w: 0.09 }, { label: 'TOTAL', w: 0.09 }, { label: 'GRADE', w: 0.08 }, { label: 'POS.', w: 0.08 },
  ];
  const colX = [];
  let cx = PAGE_MARGIN;
  cols.forEach((c) => { colX.push(cx); cx += contentWidth * c.w; });

  doc.rect(PAGE_MARGIN, y, contentWidth, TABLE_HEAD_H).fill(NAVY);
  cols.forEach((c, i) => {
    doc.fillColor(GOLD_LIGHT).font('Helvetica-Bold').fontSize(6.8).text(c.label, colX[i] + 3, y + 7, { width: contentWidth * c.w - 6, align: i === 1 ? 'left' : 'center' });
  });
  y += TABLE_HEAD_H;

  sheet.subjects.forEach((r, idx) => {
    if (idx % 2 === 1) doc.rect(PAGE_MARGIN, y, contentWidth, rowHeight).fill('#FBF6E8');
    const values = [String(idx + 1), r.subjectName, r.ca1.toFixed(0), r.ca2.toFixed(0), r.ca3.toFixed(0), r.caTotal.toFixed(0), r.examScore.toFixed(0), r.overallTotal.toFixed(0), r.grade, r.subjectPosition];
    values.forEach((val, i) => {
      doc.fillColor(i === 1 ? NAVY : INK).font(i === 1 || i === 7 ? 'Helvetica-Bold' : 'Helvetica').fontSize(rowFontSize)
        .text(val, colX[i] + 3, y + rowHeight / 2 - rowFontSize / 2, { width: contentWidth * cols[i].w - 6, align: i === 1 ? 'left' : 'center' });
    });
    doc.moveTo(PAGE_MARGIN, y + rowHeight).lineTo(PAGE_MARGIN + contentWidth, y + rowHeight).strokeColor('#E7DFC9').lineWidth(0.5).stroke();
    y += rowHeight;
  });
  y += GAP;

  // SUMMARY + KEY TO GRADES
  const panelW = (contentWidth - 12) / 2, panelStartY = y;
  doc.roundedRect(PAGE_MARGIN, y, panelW, SUMMARY_H, 5).strokeColor(GOLD_LIGHT).lineWidth(1).stroke();
  doc.rect(PAGE_MARGIN, y, panelW, 14).fill(GOLD);
  doc.fillColor(NAVY_DEEP).font('Helvetica-Bold').fontSize(7.5).text('SUMMARY OF PERFORMANCE', PAGE_MARGIN, y + 4, { width: panelW, align: 'center' });
  const summaryRows = [
    ['Total Score Obtainable', String(sheet.summary.totalObtainable)],
    ['Total Score Obtained', String(sheet.summary.totalObtained)],
    ['Percentage Score', `${sheet.summary.percentage}%`],
    ['Average Grade', sheet.summary.overallGrade],
    ['Overall Position', `${sheet.summary.classPosition} of ${sheet.summary.classSize}`],
  ];
  let sy = y + 20;
  summaryRows.forEach(([k, v]) => {
    doc.fillColor(INK_SOFT).font('Helvetica').fontSize(7.5).text(k, PAGE_MARGIN + 10, sy, { width: panelW - 90 });
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(7.5).text(v, PAGE_MARGIN + panelW - 80, sy, { width: 70, align: 'right' });
    sy += 15;
  });

  const keyX = PAGE_MARGIN + panelW + 12;
  doc.roundedRect(keyX, y, panelW, SUMMARY_H, 5).strokeColor(GOLD_LIGHT).lineWidth(1).stroke();
  doc.rect(keyX, y, panelW, 14).fill(GOLD);
  doc.fillColor(NAVY_DEEP).font('Helvetica-Bold').fontSize(7.5).text('KEY TO GRADES', keyX, y + 4, { width: panelW, align: 'center' });
  const keyRows = [['A', '70 – 100', 'Excellent'], ['B', '60 – 69', 'Very Good'], ['C', '50 – 59', 'Good'], ['D', '45 – 49', 'Credit'], ['E', '40 – 44', 'Pass'], ['F', '0 – 39', 'Fail']];
  let ky = y + 20;
  keyRows.forEach(([g, range, remark]) => {
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(7).text(g, keyX + 10, ky, { width: 20 });
    doc.fillColor(INK).font('Helvetica').fontSize(7).text(range, keyX + 40, ky, { width: 60 });
    doc.fillColor(INK_SOFT).font('Helvetica').fontSize(7).text(remark, keyX + 110, ky, { width: panelW - 120 });
    ky += 13.5;
  });
  y = panelStartY + SUMMARY_H + GAP;

  // REMARKS
  const remarkW = (contentWidth - 12) / 2;
  doc.roundedRect(PAGE_MARGIN, y, remarkW, REMARKS_H, 5).strokeColor(GOLD_LIGHT).lineWidth(1).stroke();
  doc.rect(PAGE_MARGIN, y, remarkW, 14).fill(GOLD);
  doc.fillColor(NAVY_DEEP).font('Helvetica-Bold').fontSize(7.5).text("TEACHER'S REMARKS", PAGE_MARGIN, y + 4, { width: remarkW, align: 'center' });
  doc.fillColor(INK).font('Helvetica').fontSize(7.5).text(sheet.remarks.teacherRemark || defaultTeacherRemark(sheet), PAGE_MARGIN + 10, y + 20, { width: remarkW - 20, height: REMARKS_H - 26, ellipsis: true });

  const prX = PAGE_MARGIN + remarkW + 12;
  doc.roundedRect(prX, y, remarkW, REMARKS_H, 5).strokeColor(GOLD_LIGHT).lineWidth(1).stroke();
  doc.rect(prX, y, remarkW, 14).fill(GOLD);
  doc.fillColor(NAVY_DEEP).font('Helvetica-Bold').fontSize(7.5).text("PRINCIPAL'S REMARKS", prX, y + 4, { width: remarkW, align: 'center' });
  doc.fillColor(INK).font('Helvetica').fontSize(7.5).text(sheet.remarks.principalRemark || defaultPrincipalRemark(sheet), prX + 10, y + 20, { width: remarkW - 20, height: REMARKS_H - 26, ellipsis: true });

  y += REMARKS_H + GAP;

  // FOOTER
  doc.rect(PAGE_MARGIN, y, contentWidth, FOOTER_H).fill(NAVY_DEEP);
  doc.fillColor(GOLD_LIGHT).font('Helvetica-BoldOblique').fontSize(9).text('Excellence Today, Leaders Tomorrow.', PAGE_MARGIN, y + 8, { width: contentWidth, align: 'center' });
  doc.fillColor('#C7CCDA').font('Helvetica').fontSize(6.5).text('Parent / Guardian Signature: ______________________        Date: ______________', PAGE_MARGIN, y + 22, { width: contentWidth, align: 'center' });

  doc.end();
}

function defaultTeacherRemark(sheet) {
  const avg = sheet.summary.average, first = sheet.student.full_name.split(' ')[0];
  if (avg >= 70) return `${first} is a bright, dedicated student who participates actively in class. Keep up the excellent work!`;
  if (avg >= 50) return `${first} is making steady progress this term. More consistency with assignments is encouraged.`;
  return `${first} needs closer support with core subjects going into next term.`;
}
function defaultPrincipalRemark(sheet) {
  const avg = sheet.summary.average;
  if (avg >= 70) return 'A pleasing result. We expect this standard of performance to be sustained.';
  if (avg >= 50) return 'A satisfactory result. Room still exists for improvement next term.';
  return 'This result requires urgent attention — please liaise with the class teacher.';
}

// ============================================================================
// 5. ERROR HANDLING (must be registered last)
// ============================================================================
app.use(notFound);
app.use(errorHandler);

// ============================================================================
// 6. START SERVER
// ============================================================================
const PORT = process.env.PORT || 5000;

async function start() {
  try {
    await pool.query('SELECT 1');
    console.log('✅ Connected to PostgreSQL.');
  } catch (err) {
    console.error('❌ Could not connect to PostgreSQL:', err.message);
    console.error('   Check DATABASE_URL in your Render environment variables.');
    process.exit(1);
  }

  if (String(process.env.AUTO_MIGRATE).toLowerCase() === 'true') {
    try {
      await runMigration();
    } catch (err) {
      console.error('❌ Migration failed:', err.message);
      process.exit(1);
    }
  }

  if (String(process.env.AUTO_SEED_ADMIN).toLowerCase() === 'true') {
    try {
      await seedAdmin();
    } catch (err) {
      console.error('⚠️  Admin seeding failed (continuing anyway):', err.message);
    }
  }

  app.listen(PORT, () => {
    console.log(`🚀 Great Minds Academy API listening on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  });
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});

start();
