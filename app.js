const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const { notFound, errorHandler } = require('./middleware/errorMiddleware');

const authRoutes = require('./routes/auth.routes');
const classRoutes = require('./routes/class.routes');
const subjectRoutes = require('./routes/subject.routes');
const studentRoutes = require('./routes/student.routes');
const resultRoutes = require('./routes/result.routes');
const reportRoutes = require('./routes/report.routes');

const app = express();

// ---------- Security & parsing middleware ----------
app.use(helmet({ crossOriginResourcePolicy: false })); // allow PDF/embeds to load cross-origin
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// ---------- CORS (allow your Vercel frontend) ----------
const allowedOrigins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser tools (curl/Postman with no Origin header) and wildcard config
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);

// ---------- Basic rate limiting ----------
app.use(
  '/api/',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ---------- Health check (useful for Render) ----------
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Great Minds Academy API is running.', time: new Date().toISOString() });
});

// ---------- Routes ----------
app.use('/api/auth', authRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/subjects', subjectRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/results', resultRoutes);
app.use('/api/reports', reportRoutes);

app.get('/', (req, res) => {
  res.json({ success: true, message: 'Great Minds Academy Result Computing System API', docs: '/api/health' });
});

// ---------- Error handling ----------
app.use(notFound);
app.use(errorHandler);

module.exports = app;
