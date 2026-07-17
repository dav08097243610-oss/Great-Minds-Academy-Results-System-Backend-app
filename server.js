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

// ---- Single-page A4 PDF layout engine (pdfkit — no headless browser needed) ----
// Colors mirror the frontend's CSS custom properties exactly, so the downloaded
// PDF matches the on-screen "generated result" as closely as pdfkit allows.
const NAVY = '#16233F', NAVY_DEEP = '#0B1424', GOLD = '#B08D57', GOLD_LIGHT = '#D9BE8E';
const CREAM = '#FBF7EE', INK = '#22262E', INK_SOFT = '#666C78';
const GREEN = '#2E7D4F', GREEN_BG = '#E9F5EE';
const BLUE = '#2E5FA3', BLUE_BG = '#EAF1FB';
const AMBER = '#B4791F', AMBER_BG = '#FBF0DE';
const RED = '#B23B3B', RED_BG = '#FBEAEA';
const D_COLOR = '#B45E17', D_BG = '#FDEBD6';
const E_COLOR = '#B4531F', E_BG = '#FBE4D6';
const GRADE_COLORS = {
  A: [GREEN, GREEN_BG], B: [BLUE, BLUE_BG], C: [AMBER, AMBER_BG],
  D: [D_COLOR, D_BG], E: [E_COLOR, E_BG], F: [RED, RED_BG],
};
const PAGE_MARGIN = 28;

// The school crest, embedded as base64 so the whole PDF is generated from this
// single backend file with no external asset lookups — same crest the frontend uses.
const LOGO_BASE64 = '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';
const LOGO_BUFFER = Buffer.from(LOGO_BASE64, 'base64');

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

  // HEADER — crest on the left next to the school name/tagline, exactly like
  // the "sh-left" block in the frontend's live report view.
  doc.rect(PAGE_MARGIN, y, contentWidth, HEADER_H).fill(CREAM);
  const logoSize = 46, logoX = PAGE_MARGIN + 10, logoY = y + (HEADER_H - logoSize) / 2;
  doc.image(LOGO_BUFFER, logoX, logoY, { width: logoSize, height: logoSize });
  const textX = logoX + logoSize + 12;
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(18).text('GREAT MINDS ACADEMY', textX, y + 11, { width: contentWidth - 190 - (textX - PAGE_MARGIN) });
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8.5).text('ACADEMY', textX, y + 32);
  doc.fillColor(NAVY).font('Helvetica').fontSize(8).text('Learn · Lead · Succeed', textX, y + 45);

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
      if (i === 8) return; // grade column drawn separately as a colored badge below
      doc.fillColor(i === 1 ? NAVY : INK).font(i === 1 || i === 7 ? 'Helvetica-Bold' : 'Helvetica').fontSize(rowFontSize)
        .text(val, colX[i] + 3, y + rowHeight / 2 - rowFontSize / 2, { width: contentWidth * cols[i].w - 6, align: i === 1 ? 'left' : 'center' });
    });
    // Grade badge — colored pill matching the frontend's badge-<grade> classes
    const [gColor, gBg] = GRADE_COLORS[r.grade] || [INK, '#EEEEEE'];
    const gradeColW = contentWidth * cols[8].w;
    const badgeW = Math.min(gradeColW - 6, 22), badgeH = Math.min(rowHeight - 4, 13);
    const badgeX = colX[8] + (gradeColW - badgeW) / 2, badgeY = y + (rowHeight - badgeH) / 2;
    doc.roundedRect(badgeX, badgeY, badgeW, badgeH, badgeH / 2).fill(gBg);
    doc.fillColor(gColor).font('Helvetica-Bold').fontSize(rowFontSize)
      .text(r.grade, badgeX, badgeY + badgeH / 2 - rowFontSize / 2 + 0.5, { width: badgeW, align: 'center' });
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
    const [gColor, gBg] = GRADE_COLORS[g] || [INK, '#EEEEEE'];
    doc.roundedRect(keyX + 10, ky - 1, 16, 10, 5).fill(gBg);
    doc.fillColor(gColor).font('Helvetica-Bold').fontSize(6.5).text(g, keyX + 10, ky + 1.5, { width: 16, align: 'center' });
    doc.fillColor(INK).font('Helvetica').fontSize(7).text(range, keyX + 34, ky, { width: 60 });
    doc.fillColor(INK_SOFT).font('Helvetica').fontSize(7).text(remark, keyX + 104, ky, { width: panelW - 114 });
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
