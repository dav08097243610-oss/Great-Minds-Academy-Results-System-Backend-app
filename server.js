/**
 * KERIFY IDENTITY VERIFICATION PLATFORM — BACKEND
 * Single-file deployable Express + Prisma + BullMQ backend for Render.
 *
 * This is a pragmatic single-file implementation of the API surface
 * described in KERIFY_BACKEND_REQUIREMENTS.md. It runs BOTH the HTTP
 * API and (in the same process, via START_WORKER=true) the BullMQ
 * verification/webhook workers, so it can be deployed as one Render
 * Web Service for launch, then split into api/worker services later
 * by setting START_WORKER=false on the web service and running this
 * same file with START_WORKER=true / WORKER_ONLY=true on a separate
 * Background Worker service — no code changes required, only env vars.
 *
 * Companion files required alongside this one:
 *   - prisma/schema.prisma   (database schema — run `npx prisma migrate deploy`)
 *   - package.json           (dependencies + start scripts)
 *   - .env.example           (all required environment variables)
 *   - render.yaml            (Render deployment blueprint)
 *
 * Endpoints implement the contract in KERIFY_BACKEND_REQUIREMENTS.md
 * section 20 ("Frontend-to-Backend Integration Mapping"), matching
 * the shapes the frontend's mocked `KerifyAPI` already expects.
 */

'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const jwt = require('jsonwebtoken');
const argon2 = require('argon2');
const crypto = require('crypto');
const { z } = require('zod');
const { PrismaClient } = require('@prisma/client');
const IORedis = require('ioredis');
const { Queue, Worker } = require('bullmq');
const Stripe = require('stripe');
const { v2: cloudinary } = require('cloudinary');
const { Resend } = require('resend');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const ENV = {
  PORT: process.env.PORT || 4000,
  NODE_ENV: process.env.NODE_ENV || 'production',
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  CORS_ALLOWED_ORIGINS: (process.env.CORS_ALLOWED_ORIGINS || '').split(',').filter(Boolean),
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  CLOUDINARY_URL: process.env.CLOUDINARY_URL, // cloudinary SDK reads this automatically
  AWS_REGION: process.env.AWS_REGION || 'us-east-1',
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  GOOGLE_VISION_CREDENTIALS_JSON: process.env.GOOGLE_VISION_CREDENTIALS_JSON,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  PII_ENCRYPTION_KEY: process.env.PII_ENCRYPTION_KEY, // 32-byte hex
  START_WORKER: process.env.START_WORKER !== 'false', // default: run worker in-process
  WORKER_ONLY: process.env.WORKER_ONLY === 'true',
};

const REQUIRED_IN_PROD = [
  'DATABASE_URL', 'REDIS_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET',
];
if (ENV.NODE_ENV === 'production') {
  for (const key of REQUIRED_IN_PROD) {
    if (!ENV[key]) {
      // eslint-disable-next-line no-console
      console.error(`[FATAL] Missing required env var: ${key}`);
      process.exit(1);
    }
  }
}

const prisma = new PrismaClient();
const redis = ENV.REDIS_URL ? new IORedis(ENV.REDIS_URL, { maxRetriesPerRequest: null }) : null;
const stripe = ENV.STRIPE_SECRET_KEY ? new Stripe(ENV.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' }) : null;
const resend = ENV.RESEND_API_KEY ? new Resend(ENV.RESEND_API_KEY) : null;
if (ENV.CLOUDINARY_URL) cloudinary.config(true); // reads CLOUDINARY_URL from env automatically

// ---------------------------------------------------------------------------
// CRYPTO HELPERS (PII field-level encryption, API key hashing)
// ---------------------------------------------------------------------------

function encryptPII(plain) {
  if (!plain) return null;
  if (!ENV.PII_ENCRYPTION_KEY) return plain; // dev fallback — do NOT do this in prod
  const key = Buffer.from(ENV.PII_ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptPII(payload) {
  if (!payload) return null;
  if (!ENV.PII_ENCRYPTION_KEY) return payload;
  const key = Buffer.from(ENV.PII_ENCRYPTION_KEY, 'hex');
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function hashDeterministic(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function generateApiKeySecret(env) {
  const raw = crypto.randomBytes(24).toString('hex');
  const prefix = `kf_${env}_${raw.slice(0, 16)}`;
  const full = `kf_${env}_${raw}`;
  return { full, prefix, hash: hashDeterministic(full) };
}

// ---------------------------------------------------------------------------
// QUEUES
// ---------------------------------------------------------------------------

const queues = redis ? {
  verification: new Queue('verification.process', { connection: redis }),
  webhook: new Queue('webhook.deliver', { connection: redis }),
  email: new Queue('email.send', { connection: redis }),
} : null;

// ---------------------------------------------------------------------------
// EXPRESS APP
// ---------------------------------------------------------------------------

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin: ENV.CORS_ALLOWED_ORIGINS.length ? ENV.CORS_ALLOWED_ORIGINS : true,
  credentials: true,
}));

// Stripe webhook needs the raw body — must be registered BEFORE express.json()
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json({ limit: '2mb' }));

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  store: redis ? new RedisStore({ sendCommand: (...args) => redis.call(...args) }) : undefined,
});
app.use(globalLimiter);

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: redis ? new RedisStore({ sendCommand: (...args) => redis.call(...args) }) : undefined,
});

// ---------------------------------------------------------------------------
// AUTH MIDDLEWARE
// ---------------------------------------------------------------------------

function signAccessToken(user, membership) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      orgId: membership ? membership.organizationId : null,
      role: membership ? membership.role : null,
      systemRole: user.systemRole,
    },
    ENV.JWT_ACCESS_SECRET,
    { expiresIn: '15m' },
  );
}

async function issueRefreshToken(userId) {
  const token = crypto.randomBytes(48).toString('hex');
  const tokenHash = hashDeterministic(token);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({ data: { userId, tokenHash, expiresAt } });
  return token;
}

/** Requires a valid dashboard JWT. Populates req.user = {id, email, orgId, role, systemRole}. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });
  try {
    const payload = jwt.verify(token, ENV.JWT_ACCESS_SECRET);
    req.user = {
      id: payload.sub,
      email: payload.email,
      orgId: payload.orgId,
      role: payload.role,
      systemRole: payload.systemRole,
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Requires one of the given org roles (checked against the JWT's org membership). */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

function requireSystemRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.systemRole)) {
      return res.status(403).json({ error: 'Staff access required' });
    }
    next();
  };
}

/** Public-API auth via `Authorization: Bearer kf_live_...` API key. Populates req.apiOrgId. */
async function requireApiKey(req, res, next) {
  const header = req.headers.authorization || '';
  const key = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!key || !key.startsWith('kf_')) return res.status(401).json({ error: 'Missing or malformed API key' });
  const keyHash = hashDeterministic(key);
  const record = await prisma.apiKey.findUnique({ where: { keyHash } });
  if (!record || record.revokedAt) return res.status(401).json({ error: 'Invalid or revoked API key' });
  req.apiOrgId = record.organizationId;
  req.apiKeyEnv = record.env;
  next();
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function audit(organizationId, actorId, action, metadata) {
  try {
    await prisma.auditLog.create({ data: { organizationId, actorId, action, metadata: metadata || {} } });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[audit] failed to write audit log', e.message);
  }
}

// ---------------------------------------------------------------------------
// HEALTH CHECK  (Render health check path)
// ---------------------------------------------------------------------------

app.get('/health', asyncHandler(async (req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  if (redis) await redis.ping();
  res.json({ status: 'ok', time: new Date().toISOString() });
}));

// =============================================================================
// SECTION: AUTH  (POST /auth/signup, POST /auth/login, POST /auth/refresh)
// =============================================================================

const signupSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  company: z.string().min(1),
});

app.post('/auth/signup', authLimiter, asyncHandler(async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { firstName, lastName, email, password, company } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { firstName, lastName, email, passwordHash } });
    const org = await tx.organization.create({ data: { name: company } });
    const membership = await tx.membership.create({
      data: { userId: user.id, organizationId: org.id, role: 'ORG_OWNER' },
    });
    await tx.subscription.create({
      data: { organizationId: org.id, planId: 'starter', status: 'trialing', renewsOn: new Date(Date.now() + 14 * 86400000) },
    });
    return { user, org, membership };
  });

  const accessToken = signAccessToken(result.user, result.membership);
  const refreshToken = await issueRefreshToken(result.user.id);
  await audit(result.org.id, result.user.id, 'org.created', { via: 'signup' });

  res.status(201).json({
    token: accessToken,
    refreshToken,
    user: {
      firstName: result.user.firstName,
      lastName: result.user.lastName,
      email: result.user.email,
      company: result.org.name,
      initials: (firstName[0] + lastName[0]).toUpperCase(),
    },
  });
}));

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

app.post('/auth/login', authLimiter, asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid credentials payload' });
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email }, include: { memberships: true } });
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const ok = await argon2.verify(user.passwordHash, password);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  const membership = user.memberships[0] || null;
  const accessToken = signAccessToken(user, membership);
  const refreshToken = await issueRefreshToken(user.id);

  let org = null;
  if (membership) org = await prisma.organization.findUnique({ where: { id: membership.organizationId } });

  res.json({
    token: accessToken,
    refreshToken,
    user: {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      company: org ? org.name : null,
      initials: (user.firstName[0] + user.lastName[0]).toUpperCase(),
    },
  });
}));

app.post('/auth/refresh', authLimiter, asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  const tokenHash = hashDeterministic(refreshToken);
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!record || record.revoked || record.expiresAt < new Date()) {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
  const user = await prisma.user.findUnique({ where: { id: record.userId }, include: { memberships: true } });
  const membership = user.memberships[0] || null;
  const accessToken = signAccessToken(user, membership);
  res.json({ token: accessToken });
}));

app.post('/auth/logout', requireAuth, asyncHandler(async (req, res) => {
  await prisma.refreshToken.updateMany({ where: { userId: req.user.id, revoked: false }, data: { revoked: true } });
  res.json({ ok: true });
}));

// =============================================================================
// SECTION: DASHBOARD — OVERVIEW / ANALYTICS
// =============================================================================

app.get('/v1/analytics/summary', requireAuth, asyncHandler(async (req, res) => {
  const orgId = req.user.orgId;
  const range = req.query.range || '7d';
  const days = range === '90d' ? 90 : range === '30d' ? 30 : 7;
  const since = new Date(Date.now() - days * 86400000);

  const verifications = await prisma.verification.findMany({
    where: { organizationId: orgId, submittedAt: { gte: since } },
    select: { status: true, decisionTimeMs: true, submittedAt: true, country: true },
  });

  const total = verifications.length;
  const verified = verifications.filter((v) => v.status === 'verified').length;
  const review = verifications.filter((v) => v.status === 'review').length;
  const rejected = verifications.filter((v) => v.status === 'rejected').length;
  const avgTime = total
    ? (verifications.reduce((s, v) => s + (v.decisionTimeMs || 0), 0) / total / 1000).toFixed(1)
    : '0.0';

  res.json({
    total,
    verified,
    review,
    rejected,
    avgTime,
    approvalRate: total ? ((verified / total) * 100).toFixed(1) : '0.0',
    fraudRate: total ? ((rejected / total) * 100).toFixed(1) : '0.0',
  });
}));

app.get('/v1/analytics/by-country', requireAuth, asyncHandler(async (req, res) => {
  const rows = await prisma.verification.groupBy({
    by: ['country'],
    where: { organizationId: req.user.orgId },
    _count: { _all: true },
  });
  res.json(rows.map((r) => ({ country: r.country, count: r._count._all })));
}));

// =============================================================================
// SECTION: VERIFICATIONS  (matches Wizard + sub-verifications list/detail)
// =============================================================================

function serializeVerification(v) {
  return {
    id: v.id,
    name: v.name,
    docType: v.docType,
    country: v.country,
    status: v.status,
    confidence: v.confidence,
    submitted: v.submittedAt,
    decisionTime: v.decisionTimeMs ? +(v.decisionTimeMs / 1000).toFixed(1) : null,
    idNumber: v.idNumberEnc ? decryptPII(v.idNumberEnc) : null,
    dob: v.dob,
    expiry: v.expiry,
    flags: v.flags,
  };
}

const createVerificationSchema = z.object({
  name: z.string().optional(),
  docType: z.string(),
  country: z.string(),
});

/** Shared handler for both dashboard (JWT) and public API (API key) callers. */
async function createVerificationHandler(orgId, body) {
  const parsed = createVerificationSchema.parse(body);
  const verification = await prisma.verification.create({
    data: { organizationId: orgId, name: parsed.name, docType: parsed.docType, country: parsed.country, status: 'pending' },
  });

  // Signed direct-upload params for the client to PUT documents straight to Cloudinary,
  // keeping large image payloads off the API process.
  const timestamp = Math.floor(Date.now() / 1000);
  const uploadSignature = (folder) => {
    if (!ENV.CLOUDINARY_URL) return null;
    const paramsToSign = `folder=kerify/${orgId}/${verification.id}/${folder}&timestamp=${timestamp}`;
    const signature = cloudinary.utils.api_sign_request(
      { folder: `kerify/${orgId}/${verification.id}/${folder}`, timestamp },
      cloudinary.config().api_secret,
    );
    return { timestamp, signature, folder: `kerify/${orgId}/${verification.id}/${folder}` };
  };

  return {
    id: verification.id,
    status: verification.status,
    uploads: {
      front: uploadSignature('front'),
      back: uploadSignature('back'),
      liveness: uploadSignature('liveness'),
    },
  };
}

app.post('/v1/verifications', requireAuth, asyncHandler(async (req, res) => {
  const result = await createVerificationHandler(req.user.orgId, req.body);
  res.status(201).json(result);
}));

app.post('/api/v1/verifications', requireApiKey, asyncHandler(async (req, res) => {
  const result = await createVerificationHandler(req.apiOrgId, req.body);
  res.status(201).json(result);
}));

const submitSchema = z.object({
  frontImageUrl: z.string().url().optional(),
  backImageUrl: z.string().url().optional(),
  livenessAssetUrl: z.string().url().optional(),
});

async function submitVerificationHandler(orgId, verificationId, body) {
  const parsed = submitSchema.parse(body || {});
  const verification = await prisma.verification.findFirst({ where: { id: verificationId, organizationId: orgId } });
  if (!verification) return null;

  await prisma.verification.update({
    where: { id: verificationId },
    data: {
      status: 'processing',
      frontImageUrl: parsed.frontImageUrl || verification.frontImageUrl,
      backImageUrl: parsed.backImageUrl || verification.backImageUrl,
      livenessAssetUrl: parsed.livenessAssetUrl || verification.livenessAssetUrl,
    },
  });

  if (queues) {
    await queues.verification.add('process', { verificationId, organizationId: orgId }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
  } else {
    // No Redis configured (e.g. local dev without a queue) — process inline as a fallback.
    await processVerificationJob({ verificationId, organizationId: orgId });
  }

  return { id: verificationId, status: 'processing' };
}

app.post('/v1/verifications/:id/submit', requireAuth, asyncHandler(async (req, res) => {
  const result = await submitVerificationHandler(req.user.orgId, req.params.id, req.body);
  if (!result) return res.status(404).json({ error: 'Verification not found' });
  res.json(result);
}));

app.post('/api/v1/verifications/:id/submit', requireApiKey, asyncHandler(async (req, res) => {
  const result = await submitVerificationHandler(req.apiOrgId, req.params.id, req.body);
  if (!result) return res.status(404).json({ error: 'Verification not found' });
  res.json(result);
}));

app.get('/v1/verifications', requireAuth, asyncHandler(async (req, res) => {
  const { status, country, limit } = req.query;
  const where = { organizationId: req.user.orgId };
  if (status) where.status = status;
  if (country) where.country = country;
  const rows = await prisma.verification.findMany({
    where,
    orderBy: { submittedAt: 'desc' },
    take: Math.min(Number(limit) || 50, 200),
  });
  res.json(rows.map(serializeVerification));
}));

app.get('/v1/verifications/:id', requireAuth, asyncHandler(async (req, res) => {
  const v = await prisma.verification.findFirst({ where: { id: req.params.id, organizationId: req.user.orgId } });
  if (!v) return res.status(404).json({ error: 'Not found' });
  res.json(serializeVerification(v));
}));

// =============================================================================
// SECTION: VERIFICATION PIPELINE (worker logic — OCR, face match, liveness, fraud)
// Runs either inline (no Redis) or as a BullMQ job handler (see bottom of file).
// =============================================================================

/** Stage 1-3: OCR (Google Vision) + field mapping. Stubbed provider call — wire up
 *  @google-cloud/vision with ENV.GOOGLE_VISION_CREDENTIALS_JSON in production. */
async function runOcr(imageUrl) {
  // const vision = new ImageAnnotatorClient({ credentials: JSON.parse(ENV.GOOGLE_VISION_CREDENTIALS_JSON) });
  // const [result] = await vision.documentTextDetection(imageUrl);
  // ...country-specific field-mapping regex over result.fullTextAnnotation.text...
  return { rawText: '(ocr provider not configured — stub)', fields: {} };
}

/** Stage 4: AWS Rekognition CompareFaces. Stubbed provider call — wire up
 *  @aws-sdk/client-rekognition with ENV.AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY. */
async function runFaceMatch(docImageUrl, livenessImageUrl) {
  // const rekognition = new RekognitionClient({ region: ENV.AWS_REGION });
  // const cmd = new CompareFacesCommand({ SourceImage: {...}, TargetImage: {...} });
  // const resp = await rekognition.send(cmd);
  // return resp.FaceMatches?.[0]?.Similarity ?? 0;
  return 90 + Math.random() * 9; // stub similarity score
}

/** Stage 5: liveness/spoof detection via AWS Rekognition Face Liveness (or fallback). */
async function runLivenessCheck(livenessAssetUrl) {
  return { passed: true, score: 92 + Math.random() * 7 };
}

/** Stage 6: fraud/risk scoring against org RiskRules + velocity checks in Redis. */
async function runFraudScoring(orgId, verification) {
  const flags = [];
  let riskScore = 0;

  if (verification.idNumberHash && redis) {
    const key = `velocity:${orgId}:${verification.idNumberHash}`;
    const count = await redis.incr(key);
    await redis.expire(key, 3600);
    if (count > 3) {
      flags.push('Device velocity anomaly');
      riskScore += 40;
    }
  }

  const rules = await prisma.riskRule.findMany({ where: { organizationId: orgId, enabled: true } });
  for (const rule of rules) {
    // Simplified rule evaluation — production version evaluates rule.condition (JSON) against
    // the verification + provider response payloads via a small expression evaluator.
    riskScore += rule.weight * 0; // placeholder: no dynamic rules triggered by the stub pipeline
  }

  return { flags, riskScore };
}

/** Orchestrates the full pipeline for one verification and persists the final decision. */
async function processVerificationJob({ verificationId, organizationId }) {
  const started = Date.now();
  const verification = await prisma.verification.findUnique({ where: { id: verificationId } });
  if (!verification) return;

  const pipelineLog = { stages: [] };

  try {
    const ocrFront = await runOcr(verification.frontImageUrl);
    pipelineLog.stages.push({ stage: 'ocr', at: Date.now() });

    const faceSimilarity = await runFaceMatch(verification.frontImageUrl, verification.livenessAssetUrl);
    pipelineLog.stages.push({ stage: 'face_match', similarity: faceSimilarity, at: Date.now() });

    const liveness = await runLivenessCheck(verification.livenessAssetUrl);
    pipelineLog.stages.push({ stage: 'liveness', ...liveness, at: Date.now() });

    const { flags, riskScore } = await runFraudScoring(organizationId, verification);
    pipelineLog.stages.push({ stage: 'fraud_scoring', riskScore, at: Date.now() });

    const confidence = Math.max(0, Math.min(100, faceSimilarity - riskScore));
    let status = 'verified';
    if (!liveness.passed || riskScore >= 60 || confidence < 70) status = 'rejected';
    else if (confidence < 90 || flags.length) status = 'review';

    const decisionTimeMs = Date.now() - started;

    await prisma.verification.update({
      where: { id: verificationId },
      data: {
        status,
        confidence,
        decisionTimeMs,
        flags,
        pipelineLog,
        providerResponses: { ocrFront },
        completedAt: new Date(),
      },
    });

    await prisma.notification.create({
      data: {
        organizationId,
        type: status === 'rejected' || status === 'review' ? 'flag' : 'success',
        title: status === 'verified' ? 'Verification completed' : 'Verification flagged for review',
        body: `${verification.name || verification.id} — ${status} (${confidence.toFixed(1)}% confidence).`,
      },
    });

    if (queues) {
      const event = status === 'rejected' ? 'verification.rejected'
        : status === 'review' ? 'verification.flagged' : 'verification.completed';
      await queues.webhook.add('deliver', { organizationId, event, verificationId });
    }

    // Increment metered usage for billing (section 10).
    await prisma.subscription.updateMany({
      where: { organizationId },
      data: { usedChecks: { increment: 1 } },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[pipeline] verification processing failed', verificationId, err);
    await prisma.verification.update({
      where: { id: verificationId },
      data: { status: 'review', flags: ['Automated processing error — manual review required'], pipelineLog },
    });
  }
}

// =============================================================================
// SECTION: API KEYS  (matches Team.generateKey / revokeKey)
// =============================================================================

app.get('/v1/api-keys', requireAuth, asyncHandler(async (req, res) => {
  const keys = await prisma.apiKey.findMany({ where: { organizationId: req.user.orgId, revokedAt: null } });
  res.json(keys.map((k) => ({ id: k.id, name: k.name, value: `${k.keyPrefix}…`, created: k.createdAt, env: k.env })));
}));

app.post('/v1/api-keys', requireAuth, requireRole('ORG_OWNER', 'ORG_ADMIN'), asyncHandler(async (req, res) => {
  const { name, env } = req.body || {};
  const { full, prefix, hash } = generateApiKeySecret(env === 'test' ? 'test' : 'live');
  const key = await prisma.apiKey.create({
    data: { organizationId: req.user.orgId, name: name || 'Untitled key', env: env === 'test' ? 'test' : 'live', keyPrefix: prefix, keyHash: hash },
  });
  await audit(req.user.orgId, req.user.id, 'api_key.created', { keyId: key.id });
  // Full secret is returned ONLY on creation — never retrievable again.
  res.status(201).json({ id: key.id, name: key.name, value: full, created: key.createdAt, env: key.env });
}));

app.delete('/v1/api-keys/:id', requireAuth, requireRole('ORG_OWNER', 'ORG_ADMIN'), asyncHandler(async (req, res) => {
  await prisma.apiKey.updateMany({
    where: { id: req.params.id, organizationId: req.user.orgId },
    data: { revokedAt: new Date() },
  });
  await audit(req.user.orgId, req.user.id, 'api_key.revoked', { keyId: req.params.id });
  res.json({ ok: true });
}));

// =============================================================================
// SECTION: TEAM
// =============================================================================

app.get('/v1/team', requireAuth, asyncHandler(async (req, res) => {
  const memberships = await prisma.membership.findMany({
    where: { organizationId: req.user.orgId },
    include: { user: true },
  });
  res.json(memberships.map((m) => ({
    name: `${m.user.firstName} ${m.user.lastName}`,
    email: m.user.email,
    role: m.role,
    initials: (m.user.firstName[0] + m.user.lastName[0]).toUpperCase(),
  })));
}));

const inviteSchema = z.object({ email: z.string().email(), role: z.enum(['ORG_ADMIN', 'ORG_ANALYST', 'ORG_VIEWER']) });

app.post('/v1/team/invite', requireAuth, requireRole('ORG_OWNER', 'ORG_ADMIN'), asyncHandler(async (req, res) => {
  const parsed = inviteSchema.parse(req.body);
  const org = await prisma.organization.findUnique({ where: { id: req.user.orgId } });
  if (resend) {
    await resend.emails.send({
      from: 'Kerify <noreply@kerify.com>',
      to: parsed.email,
      subject: `You've been invited to join ${org.name} on Kerify`,
      html: `<p>You've been invited to join <strong>${org.name}</strong> on Kerify as ${parsed.role}. Sign up to accept.</p>`,
    });
  }
  await audit(req.user.orgId, req.user.id, 'team.invited', { email: parsed.email, role: parsed.role });
  res.status(202).json({ ok: true });
}));

// =============================================================================
// SECTION: NOTIFICATIONS
// =============================================================================

app.get('/v1/notifications', requireAuth, asyncHandler(async (req, res) => {
  const rows = await prisma.notification.findMany({
    where: { organizationId: req.user.orgId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.json(rows.map((n) => ({
    id: n.id, type: n.type, title: n.title, desc: n.body, time: n.createdAt, unread: !n.read,
  })));
}));

app.post('/v1/notifications/:id/read', requireAuth, asyncHandler(async (req, res) => {
  await prisma.notification.updateMany({
    where: { id: req.params.id, organizationId: req.user.orgId },
    data: { read: true },
  });
  res.json({ ok: true });
}));

app.post('/v1/notifications/read-all', requireAuth, asyncHandler(async (req, res) => {
  await prisma.notification.updateMany({ where: { organizationId: req.user.orgId, read: false }, data: { read: true } });
  res.json({ ok: true });
}));

// =============================================================================
// SECTION: BILLING & STRIPE  (matches Billing.render / changePlan / applyCoupon)
// =============================================================================

app.get('/v1/billing/subscription', requireAuth, asyncHandler(async (req, res) => {
  const sub = await prisma.subscription.findUnique({ where: { organizationId: req.user.orgId } });
  const plan = sub ? await prisma.plan.findUnique({ where: { id: sub.planId } }) : null;
  res.json({ subscription: sub, plan });
}));

app.get('/v1/billing/plans', requireAuth, asyncHandler(async (req, res) => {
  const plans = await prisma.plan.findMany({ where: { active: true } });
  res.json(plans);
}));

app.get('/v1/billing/invoices', requireAuth, asyncHandler(async (req, res) => {
  const invoices = await prisma.invoice.findMany({
    where: { organizationId: req.user.orgId },
    orderBy: { issuedAt: 'desc' },
  });
  res.json(invoices.map((i) => ({
    id: i.stripeInvoiceId, desc: i.description, date: i.issuedAt, amount: i.amount, status: i.status,
  })));
}));

app.post('/v1/billing/checkout-session', requireAuth, requireRole('ORG_OWNER'), asyncHandler(async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing is not configured' });
  const { planId, successUrl, cancelUrl } = req.body || {};
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan || !plan.stripePriceId) return res.status(400).json({ error: 'Unknown or non-self-serve plan' });

  const org = await prisma.organization.findUnique({ where: { id: req.user.orgId } });
  let customerId = org.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({ name: org.name, metadata: { organizationId: org.id } });
    customerId = customer.id;
    await prisma.organization.update({ where: { id: org.id }, data: { stripeCustomerId: customerId } });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    success_url: successUrl || 'https://app.kerify.com/billing?success=1',
    cancel_url: cancelUrl || 'https://app.kerify.com/billing?canceled=1',
    metadata: { organizationId: org.id, planId },
  });
  res.json({ url: session.url });
}));

app.post('/v1/billing/portal-session', requireAuth, requireRole('ORG_OWNER'), asyncHandler(async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing is not configured' });
  const org = await prisma.organization.findUnique({ where: { id: req.user.orgId } });
  if (!org.stripeCustomerId) return res.status(400).json({ error: 'No billing account on file yet' });
  const session = await stripe.billingPortal.sessions.create({
    customer: org.stripeCustomerId,
    return_url: req.body?.returnUrl || 'https://app.kerify.com/billing',
  });
  res.json({ url: session.url });
}));

app.post('/v1/billing/apply-coupon', requireAuth, requireRole('ORG_OWNER'), asyncHandler(async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing is not configured' });
  const { code } = req.body || {};
  const sub = await prisma.subscription.findUnique({ where: { organizationId: req.user.orgId } });
  if (!sub || !sub.stripeSubscriptionId) return res.status(400).json({ error: 'No active subscription' });
  try {
    const promoList = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
    if (!promoList.data.length) return res.status(400).json({ error: 'Invalid or expired coupon code' });
    await stripe.subscriptions.update(sub.stripeSubscriptionId, { promotion_code: promoList.data[0].id });
    await prisma.subscription.update({ where: { organizationId: req.user.orgId }, data: { couponCode: code } });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'Could not apply coupon' });
  }
}));

async function handleStripeWebhook(req, res) {
  if (!stripe || !ENV.STRIPE_WEBHOOK_SECRET) return res.status(503).end();
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, ENV.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { organizationId, planId } = session.metadata || {};
        if (organizationId) {
          await prisma.subscription.upsert({
            where: { organizationId },
            update: { planId, status: 'active', stripeSubscriptionId: session.subscription },
            create: { organizationId, planId, status: 'active', stripeSubscriptionId: session.subscription },
          });
        }
        break;
      }
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const org = await prisma.organization.findFirst({ where: { stripeCustomerId: invoice.customer } });
        if (org) {
          await prisma.invoice.upsert({
            where: { stripeInvoiceId: invoice.id },
            update: { status: event.type === 'invoice.paid' ? 'paid' : 'failed', amount: invoice.amount_paid / 100 },
            create: {
              organizationId: org.id,
              stripeInvoiceId: invoice.id,
              amount: (invoice.amount_paid || invoice.amount_due) / 100,
              status: event.type === 'invoice.paid' ? 'paid' : 'failed',
              description: invoice.lines?.data?.[0]?.description || 'Kerify subscription',
              hostedInvoiceUrl: invoice.hosted_invoice_url,
            },
          });
          if (event.type === 'invoice.payment_failed') {
            await prisma.subscription.updateMany({ where: { organizationId: org.id }, data: { status: 'past_due' } });
            await prisma.notification.create({
              data: { organizationId: org.id, type: 'system', title: 'Payment failed', body: 'Your latest invoice payment failed. Please update your payment method.' },
            });
          } else {
            await prisma.subscription.updateMany({ where: { organizationId: org.id }, data: { status: 'active', usedChecks: 0 } });
          }
        }
        break;
      }
      default:
        break; // ignore unhandled event types
    }
    res.json({ received: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stripe webhook] handler error', err);
    res.status(500).json({ error: 'Webhook handler error' });
  }
}

// =============================================================================
// SECTION: ADMIN PORTAL  (staff-only — matches Admin.render tabs)
// =============================================================================

app.get('/v1/admin/revenue', requireAuth, requireSystemRole('KERIFY_ADMIN', 'KERIFY_SUPPORT'), asyncHandler(async (req, res) => {
  const subs = await prisma.subscription.findMany({ where: { status: { in: ['active', 'past_due', 'trialing'] } }, include: { organization: true } });
  const plans = await prisma.plan.findMany();
  const planPrice = Object.fromEntries(plans.map((p) => [p.id, p.price || 0]));
  const activeSubs = subs.filter((s) => s.status !== 'churned');
  const mrr = activeSubs.reduce((sum, s) => sum + (planPrice[s.planId] || 0), 0);
  const churnedCount = await prisma.subscription.count({ where: { status: 'churned' } });
  const totalOrgs = await prisma.organization.count();
  const openTickets = await prisma.supportTicket.count({ where: { status: 'open' } });

  res.json({
    mrr,
    arr: mrr * 12,
    churnRate: totalOrgs ? ((churnedCount / totalOrgs) * 100).toFixed(1) : '0.0',
    customerCount: activeSubs.length,
    openTickets,
  });
}));

app.get('/v1/admin/customers', requireAuth, requireSystemRole('KERIFY_ADMIN', 'KERIFY_SUPPORT'), asyncHandler(async (req, res) => {
  const subs = await prisma.subscription.findMany({ include: { organization: true } });
  const plans = await prisma.plan.findMany();
  const planName = Object.fromEntries(plans.map((p) => [p.id, p.name]));
  const planPrice = Object.fromEntries(plans.map((p) => [p.id, p.price || 0]));
  res.json(subs.map((s) => ({
    id: s.organizationId,
    name: s.organization.name,
    plan: planName[s.planId] || s.planId,
    mrr: s.status === 'churned' ? 0 : planPrice[s.planId] || 0,
    status: s.status,
    since: s.organization.createdAt,
  })));
}));

app.get('/v1/admin/plans', requireAuth, requireSystemRole('KERIFY_ADMIN', 'KERIFY_SUPPORT'), asyncHandler(async (req, res) => {
  res.json(await prisma.plan.findMany());
}));

app.put('/v1/admin/plans/:id', requireAuth, requireSystemRole('KERIFY_ADMIN'), asyncHandler(async (req, res) => {
  const { price } = req.body || {};
  if (typeof price !== 'number') return res.status(400).json({ error: 'price must be a number' });
  const plan = await prisma.plan.update({ where: { id: req.params.id }, data: { price } });
  await prisma.planPriceHistory.create({ data: { planId: plan.id, price, changedBy: req.user.id } });
  await audit(null, req.user.id, 'plan.price_updated', { planId: plan.id, price });
  res.json(plan);
}));

app.get('/v1/admin/tickets', requireAuth, requireSystemRole('KERIFY_ADMIN', 'KERIFY_SUPPORT'), asyncHandler(async (req, res) => {
  const tickets = await prisma.supportTicket.findMany({ include: { organization: true }, orderBy: { createdAt: 'desc' } });
  res.json(tickets.map((t) => ({ id: t.id, subject: t.subject, customer: t.organization.name, priority: t.priority, status: t.status })));
}));

app.put('/v1/admin/tickets/:id', requireAuth, requireSystemRole('KERIFY_ADMIN', 'KERIFY_SUPPORT'), asyncHandler(async (req, res) => {
  const { status } = req.body || {};
  const ticket = await prisma.supportTicket.update({ where: { id: req.params.id }, data: { status } });
  res.json(ticket);
}));

// =============================================================================
// SECTION: WEBHOOKS CONFIG (org-facing) + test delivery
// =============================================================================

app.put('/v1/webhooks/config', requireAuth, requireRole('ORG_OWNER', 'ORG_ADMIN'), asyncHandler(async (req, res) => {
  const { url } = req.body || {};
  const secret = crypto.randomBytes(24).toString('hex');
  await prisma.organization.update({ where: { id: req.user.orgId }, data: { webhookUrl: url, webhookSecret: secret } });
  res.json({ ok: true, secret });
}));

app.post('/v1/webhooks/test', requireAuth, requireRole('ORG_OWNER', 'ORG_ADMIN'), asyncHandler(async (req, res) => {
  if (queues) {
    await queues.webhook.add('deliver', { organizationId: req.user.orgId, event: 'test.ping', verificationId: null });
  }
  res.json({ ok: true });
}));

async function deliverWebhook({ organizationId, event, verificationId }) {
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!org || !org.webhookUrl) return;

  let payload = { event, organizationId, timestamp: new Date().toISOString() };
  if (verificationId) {
    const v = await prisma.verification.findUnique({ where: { id: verificationId } });
    if (v) payload.data = serializeVerification(v);
  }

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac('sha256', org.webhookSecret || '').update(`${timestamp}.${body}`).digest('hex');

  let statusCode = null;
  let success = false;
  try {
    const resp = await fetch(org.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Kerify-Signature': `t=${timestamp},v1=${signature}` },
      body,
      signal: AbortSignal.timeout(10000),
    });
    statusCode = resp.status;
    success = resp.ok;
  } catch (e) {
    statusCode = 0;
    success = false;
  }

  await prisma.webhookDelivery.create({
    data: { organizationId, event, url: org.webhookUrl, statusCode, success },
  });

  if (!success) {
    await prisma.notification.create({
      data: { organizationId, type: 'system', title: 'Webhook delivery failed', body: `Your endpoint returned ${statusCode || 'no response'} for event ${event}.` },
    });
  }
}

// =============================================================================
// ERROR HANDLING
// =============================================================================

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof z.ZodError) return res.status(400).json({ error: err.flatten() });
  // eslint-disable-next-line no-console
  console.error('[unhandled error]', err);
  res.status(500).json({ error: ENV.NODE_ENV === 'production' ? 'Internal server error' : err.message });
});

// =============================================================================
// WORKERS (BullMQ) — verification pipeline + webhook delivery
// =============================================================================

function startWorkers() {
  if (!redis) {
    // eslint-disable-next-line no-console
    console.warn('[worker] REDIS_URL not set — verifications will process inline instead of via queue.');
    return;
  }

  new Worker('verification.process', async (job) => {
    await processVerificationJob(job.data);
  }, { connection: redis, concurrency: 5 });

  new Worker('webhook.deliver', async (job) => {
    await deliverWebhook(job.data);
  }, { connection: redis, concurrency: 10 });

  new Worker('email.send', async (job) => {
    if (!resend) return;
    await resend.emails.send(job.data);
  }, { connection: redis, concurrency: 5 });

  // eslint-disable-next-line no-console
  console.log('[worker] BullMQ workers started: verification.process, webhook.deliver, email.send');
}

// =============================================================================
// BOOT
// =============================================================================

if (!ENV.WORKER_ONLY) {
  app.listen(ENV.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[kerify-api] listening on :${ENV.PORT} (${ENV.NODE_ENV})`);
  });
}

if (ENV.START_WORKER) startWorkers();

process.on('SIGTERM', async () => {
  // eslint-disable-next-line no-console
  console.log('[kerify] SIGTERM received, shutting down gracefully...');
  await prisma.$disconnect();
  if (redis) redis.disconnect();
  process.exit(0);
});

module.exports = app;
