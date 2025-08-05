const express = require('express');
const cors = require('cors');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config();

const app = express();

// Rate limiting
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: {
    error: 'Rate Limit Exceeded',
    message: 'Too many applications submitted. Please try again in 15 minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// CORS configuration
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5500',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:5500',
    process.env.FRONTEND_URL
  ].filter(Boolean),
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Multer configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 6,
    fields: 20,
    fieldSize: 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/gif',
      'text/plain'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      const error = new Error(`Invalid file type: ${file.mimetype}`);
      error.code = 'INVALID_FILE_TYPE';
      cb(error, false);
    }
  }
});

// Initialize Supabase (simplified for serverless)
let supabase;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    }
  );
} else {
  console.error('Missing Supabase environment variables');
}

// Serve static files
app.use(express.static('public'));

// Utility functions
async function uploadFileToSupabase(file, folder) {
  if (!file || !supabase) return null;

  try {
    if (file.size > 10 * 1024 * 1024) {
      throw new Error('File size exceeds 10MB limit');
    }

    const fileExtension = file.originalname.split('.').pop()?.toLowerCase() || 'bin';
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const timestamp = Date.now();
    const filePath = `${folder}/${timestamp}_${sanitizedName}`;

    const { data, error } = await supabase.storage
      .from('uploads')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
        cacheControl: '3600'
      });

    if (error) {
      throw new Error(`Upload failed: ${error.message}`);
    }

    const { data: urlData } = supabase.storage
      .from('uploads')
      .getPublicUrl(filePath);

    return urlData?.publicUrl;
  } catch (err) {
    console.error('Upload error:', err);
    throw new Error(`File upload failed: ${err.message}`);
  }
}

function validateInput(body) {
  const required = ['usc_email', 'personal_email', 'year', 'why'];
  const missing = required.filter(field => 
    !body[field] || (typeof body[field] === 'string' && body[field].trim() === '')
  );

  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }

  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  
  if (!emailRegex.test(body.usc_email.trim())) {
    throw new Error('Invalid USC email format');
  }
  
  if (!emailRegex.test(body.personal_email.trim())) {
    throw new Error('Invalid personal email format');
  }

  return true;
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', async (req, res) => {
  try {
    const health = {
      status: 'OK',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development'
    };

    if (supabase) {
      await supabase.from('applications').select('count', { count: 'exact', head: true });
      health.database = 'connected';
    } else {
      health.database = 'error';
      health.status = 'DEGRADED';
    }

    res.json(health);
  } catch (err) {
    res.status(500).json({
      status: 'ERROR',
      error: err.message
    });
  }
});

// Submit route (simplified)
app.post('/submit', submitLimiter, upload.fields([
  { name: 'resume', maxCount: 1 },
  { name: 'marketing_portfolio', maxCount: 5 }
]), async (req, res) => {
  try {
    if (!supabase) {
      throw new Error('Database not available');
    }

    validateInput(req.body);
    const body = req.body;

    // Check for duplicates
    const { data: existing, error: findError } = await supabase
      .from('applications')
      .select('id, usc_email, personal_email')
      .or(`usc_email.eq.${body.usc_email.trim()},personal_email.eq.${body.personal_email.trim()}`);

    if (findError) {
      throw new Error(`Database error: ${findError.message}`);
    }

    if (existing && existing.length > 0) {
      return res.status(409).json({
        error: 'Duplicate Application',
        message: 'An application with this email address has already been submitted.'
      });
    }

    // Handle file uploads
    let resume_url = null;
    let marketing_portfolio_urls = [];

    if (req.files?.resume?.[0]) {
      resume_url = await uploadFileToSupabase(req.files.resume[0], 'resumes');
    }

    if (req.files?.marketing_portfolio) {
      for (const file of req.files.marketing_portfolio) {
        try {
          const url = await uploadFileToSupabase(file, 'marketing_portfolio');
          if (url) marketing_portfolio_urls.push(url);
        } catch (fileError) {
          console.error('Portfolio file upload failed:', fileError);
        }
      }
    }

    // Prepare and insert data
    const applicationData = {
      usc_email: body.usc_email?.trim() || null,
      personal_email: body.personal_email?.trim() || null,
      year: body.year?.trim() || null,
      why: body.why?.trim() || null,
      resume_highlight: body.resume_highlight?.trim() || null,
      first_choice: body.first_choice?.trim() || null,
      second_choice: body.second_choice?.trim() || null,
      events_major: body.events_major?.trim() || null,
      operations_motivation: body.operations_motivation?.trim() || null,
      outreach_experience: body.outreach_experience?.trim() || null,
      finance_ideas: body.finance_ideas?.trim() || null,
      resume_url,
      marketing_portfolio_urls: marketing_portfolio_urls.length > 0 
        ? JSON.stringify(marketing_portfolio_urls) 
        : null,
      created_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('applications')
      .insert([applicationData])
      .select();

    if (error) {
      throw new Error(`Database insertion failed: ${error.message}`);
    }

    res.status(200).json({
      success: true,
      message: 'Application submitted successfully',
      data: {
        id: data[0].id,
        usc_email: data[0].usc_email,
        submitted_at: data[0].created_at
      }
    });

  } catch (err) {
    console.error('Submission error:', err);
    res.status(500).json({
      error: 'Server Error',
      message: err.message || 'An unexpected error occurred'
    });
  }
});

// Success page
app.get('/success', (req, res) => {
  const html = `<!DOCTYPE html>
<html>
<head>
<title>Application Submitted - ASIS</title>
<style>
body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
.success { background: #d4edda; padding: 20px; border-radius: 8px; }
</style>
</head>
<body>
<div class="success">
<h1>🎉 Thank You!</h1>
<p>Your application has been submitted successfully.</p>
<a href="/">Submit Another Application</a>
</div>
</body>
</html>`;
  res.send(html);
});

// Error handling
app.use((error, req, res, next) => {
  console.error('Error:', error);
  res.status(500).json({
    error: 'Server Error',
    message: 'An unexpected error occurred'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested resource was not found'
  });
});

// Local development server
const PORT = process.env.PORT || 3001;

if (process.env.NODE_ENV !== 'production' && require.main === module) {
  app.listen(PORT, async () => {
    console.log('\n🚀 === SERVER STARTING ===');
    console.log(`📡 Server running on port ${PORT}`);
    console.log(`🏥 Health check: http://localhost:${PORT}/health`);
    console.log(`✅ Success page: http://localhost:${PORT}/success`);
    console.log(`🌐 Application: http://localhost:${PORT}/`);
    
    // Test database connection
    if (supabase) {
      try {
        await supabase.from('applications').select('count', { count: 'exact', head: true });
        console.log('✅ Database connection successful');
      } catch (err) {
        console.log('⚠️  Database connection failed:', err.message);
      }
    }
    
    console.log('🎉 All systems ready!');
    console.log('='.repeat(50));
  });
}

// Export for Vercel
module.exports = app;