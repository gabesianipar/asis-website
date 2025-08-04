const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Rate limiting to prevent spam
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3, // limit each IP to 3 requests per windowMs
  message: {
    error: 'Rate Limit Exceeded',
    message: 'Too many applications submitted. Please try again in 15 minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// CORS configuration - explicitly including all potential origins
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

// Multer configuration with comprehensive file restrictions
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 6, // max 6 files total
    fields: 20, // max number of form fields
    fieldSize: 1024 * 1024 // 1MB per field
  },
  fileFilter: (req, file, cb) => {
    console.log(`Processing file: ${file.originalname}, type: ${file.mimetype}`);
    
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
      const error = new Error(`Invalid file type: ${file.mimetype}. Allowed: PDF, DOC, DOCX, JPG, PNG, GIF, TXT`);
      error.code = 'INVALID_FILE_TYPE';
      cb(error, false);
    }
  }
});

// Initialize Supabase client with comprehensive error checking
if (!process.env.SUPABASE_URL) {
  console.error('❌ Missing SUPABASE_URL environment variable');
  process.exit(1);
}

if (!process.env.SUPABASE_ANON_KEY) {
  console.error('❌ Missing SUPABASE_ANON_KEY environment variable');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

// Test database and storage connection
async function testConnections() {
  try {
    // Test database
    const { data, error } = await supabase
      .from('applications')
      .select('count', { count: 'exact', head: true });
    
    if (error) {
      console.error('❌ Database connection failed:', error.message);
      return false;
    }
    console.log('✅ Database connection successful');

    // Test storage
    try {
      const { data: buckets, error: storageError } = await supabase.storage.listBuckets();
      if (storageError) {
        console.warn('⚠️  Storage connection issues:', storageError.message);
      } else {
        console.log('✅ Storage connection successful');
      }
    } catch (storageErr) {
      console.warn('⚠️  Storage test failed:', storageErr.message);
    }

    return true;
  } catch (err) {
    console.error('❌ Connection test failed:', err.message);
    return false;
  }
}

// Enhanced file upload with better error handling
async function uploadFileToSupabase(file, folder) {
  if (!file) return null;

  try {
    // Validate file size client-side as well
    if (file.size > 10 * 1024 * 1024) {
      throw new Error('File size exceeds 10MB limit');
    }

    const fileExtension = file.originalname.split('.').pop()?.toLowerCase() || 'bin';
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const timestamp = Date.now();
    const filePath = `${folder}/${timestamp}_${sanitizedName}`;

    console.log(`📤 Uploading: ${filePath} (${(file.size / 1024 / 1024).toFixed(2)}MB)`);

    const { data, error } = await supabase.storage
      .from('uploads')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
        cacheControl: '3600'
      });

    if (error) {
      console.error('❌ File upload error:', error);
      throw new Error(`Upload failed: ${error.message || 'Unknown storage error'}`);
    }

    const { data: urlData } = supabase.storage
      .from('uploads')
      .getPublicUrl(filePath);

    if (!urlData?.publicUrl) {
      throw new Error('Failed to generate public URL');
    }

    console.log(`✅ Upload successful: ${urlData.publicUrl}`);
    return urlData.publicUrl;

  } catch (err) {
    console.error('❌ Upload function error:', err);
    throw new Error(`File upload failed: ${err.message || 'Unknown error'}`);
  }
}

// Enhanced input validation
function validateInput(body) {
  const required = ['usc_email', 'personal_email', 'year', 'why'];
  const missing = required.filter(field => 
    !body[field] || 
    (typeof body[field] === 'string' && body[field].trim() === '')
  );

  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }

  // Enhanced email validation
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  
  if (!emailRegex.test(body.usc_email.trim())) {
    throw new Error('Invalid USC email format');
  }
  
  if (!emailRegex.test(body.personal_email.trim())) {
    throw new Error('Invalid personal email format');
  }

  // Additional validation
  const maxLength = 10000; // 10k characters max for text fields
  if (body.why && body.why.length > maxLength) {
    throw new Error(`'Why' field exceeds maximum length of ${maxLength} characters`);
  }

  return true;
}

// Safe error message extraction
function getErrorMessage(error) {
  if (!error) return 'Unknown error occurred';
  if (typeof error === 'string') return error;
  if (error.message && typeof error.message === 'string') return error.message;
  if (error.toString && typeof error.toString === 'function') return error.toString();
  return 'An error occurred';
}

// Main submit route - EXPLICITLY ASYNC FUNCTION
app.post('/submit', submitLimiter, upload.fields([
  { name: 'resume', maxCount: 1 },
  { name: 'marketing_portfolio', maxCount: 5 }
]), async (req, res) => {
  const startTime = Date.now();
  console.log('\n🚀 === NEW SUBMISSION REQUEST ===');
  console.log('Timestamp:', new Date().toISOString());
  console.log('IP:', req.ip);
  console.log('Body fields:', Object.keys(req.body));
  console.log('Files:', req.files ? Object.keys(req.files) : 'No files');

  try {
    // Step 1: Validate input
    console.log('📋 Step 1: Validating input...');
    validateInput(req.body);

    const body = req.body;

    // Step 2: Check for duplicates with better error handling
    console.log('🔍 Step 2: Checking for duplicates...');
    const { data: existing, error: findError } = await supabase
      .from('applications')
      .select('id, usc_email, personal_email')
      .or(`usc_email.eq.${body.usc_email.trim()},personal_email.eq.${body.personal_email.trim()}`);

    if (findError) {
      console.error('❌ Duplicate check failed:', findError);
      throw new Error(`Database error during duplicate check: ${getErrorMessage(findError)}`);
    }

    if (existing && existing.length > 0) {
      console.log('⚠️  Duplicate application detected');
      return res.status(409).json({
        error: 'Duplicate Application',
        message: 'An application with this email address has already been submitted.'
      });
    }

    // Step 3: Handle file uploads
    console.log('📁 Step 3: Processing file uploads...');
    let resume_url = null;
    let marketing_portfolio_urls = [];

    if (req.files?.resume?.[0]) {
      console.log('📄 Uploading resume...');
      try {
        resume_url = await uploadFileToSupabase(req.files.resume[0], 'resumes');
      } catch (uploadError) {
        console.error('❌ Resume upload failed:', uploadError);
        throw new Error(`Resume upload failed: ${getErrorMessage(uploadError)}`);
      }
    }

    if (req.files?.marketing_portfolio) {
      console.log(`🎨 Uploading ${req.files.marketing_portfolio.length} portfolio files...`);
      for (let i = 0; i < req.files.marketing_portfolio.length; i++) {
        const file = req.files.marketing_portfolio[i];
        try {
          const url = await uploadFileToSupabase(file, 'marketing_portfolio');
          if (url) {
            marketing_portfolio_urls.push(url);
            console.log(`✅ Portfolio file ${i + 1} uploaded successfully`);
          }
        } catch (fileError) {
          console.error(`❌ Portfolio file ${i + 1} upload failed:`, fileError);
          // Continue with other files, don't fail entire submission
        }
      }
    }

    // Step 4: Prepare application data
    console.log('💾 Step 4: Preparing application data...');
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

    // Step 5: Insert into database
    console.log('🗄️  Step 5: Inserting into database...');
    const { data, error } = await supabase
      .from('applications')
      .insert([applicationData])
      .select();

    if (error) {
      console.error('❌ Database insertion failed:', error);
      throw new Error(`Database insertion failed: ${getErrorMessage(error)}`);
    }

    if (!data || data.length === 0) {
      throw new Error('No data returned from database insertion');
    }

    // Success!
    const duration = Date.now() - startTime;
    console.log(`✅ SUCCESS! Application submitted in ${duration}ms`);
    console.log('📤 Sending success response...');

    res.status(200).json({
      success: true,
      message: 'Application submitted successfully',
      data: {
        id: data[0].id,
        usc_email: data[0].usc_email,
        submitted_at: data[0].created_at || new Date().toISOString()
      }
    });

  } catch (err) {
    const duration = Date.now() - startTime;
    console.error(`❌ SUBMISSION FAILED after ${duration}ms:`, err);

    const errorMessage = getErrorMessage(err);

    // Categorize errors and return appropriate responses
    if (errorMessage.includes('Missing required fields') || 
        errorMessage.includes('Invalid') ||
        errorMessage.includes('exceeds maximum length')) {
      return res.status(400).json({
        error: 'Validation Error',
        message: errorMessage
      });
    }

    if (errorMessage.includes('File') || errorMessage.includes('upload')) {
      return res.status(500).json({
        error: 'Upload Error',
        message: 'File upload failed. Please check your files and try again.'
      });
    }

    if (errorMessage.includes('Database')) {
      return res.status(500).json({
        error: 'Database Error',
        message: 'Database operation failed. Please try again later.'
      });
    }

    // Generic server error
    return res.status(500).json({
      error: 'Server Error',
      message: 'An unexpected error occurred. Please try again later.'
    });
  }
});



// Health check endpoint
app.get('/health', async (req, res) => {
  const health = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  };

  try {
    // Quick database ping
    await supabase.from('applications').select('count', { count: 'exact', head: true });
    health.database = 'connected';
  } catch (err) {
    health.database = 'error';
    health.status = 'DEGRADED';
  }

  res.json(health);
});


app.get('/success', (req, res) => {
  const html = '<!DOCTYPE html>' +
    '<html>' +
    '<head>' +
    '<title>Application Submitted - ASIS</title>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<style>' +
    'body { font-family: Inter, Montserrat, Arial, sans-serif; background: #fffbe6; color: #222; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }' +
    '.success-container { background: #fff; border-radius: 18px; box-shadow: 0 2px 16px rgba(153,0,0,0.08); padding: 2.5rem 2rem; max-width: 400px; text-align: center; border: 2px solid #ffe18c; animation: slideUp 0.6s ease-out; }' +
    '@keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }' +
    '.success-container h1 { color: #990000; font-size: 2rem; margin-bottom: 1rem; }' +
    '.success-container p { font-size: 1.1rem; margin-bottom: 1.5rem; line-height: 1.5; }' +
    '.success-container a { color: #990000; text-decoration: none; font-weight: 600; background: #ffe18c; padding: 12px 24px; border-radius: 8px; display: inline-block; transition: all 0.2s; }' +
    '.success-container a:hover { background: #ffd700; transform: translateY(-1px); }' +
    '</style>' +
    '</head>' +
    '<body>' +
    '<div class="success-container">' +
    '<h1>🎉 Thank You!</h1>' +
    '<p>Your application has been submitted successfully.<br>' +
    'We appreciate your interest in ASIS.<br>' +
    'We\'ll be in touch soon!</p>' +
    '<a href="/">Submit Another Application</a>' +
    '</div>' +
    '</body>' +
    '</html>';

  res.send(html);
});

// Enhanced error handling middleware
app.use((error, req, res, next) => {
  console.error('🔥 Global error handler triggered:', error);

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'File Too Large',
        message: 'File size must be less than 10MB'
      });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        error: 'Too Many Files',
        message: 'Maximum 6 files allowed'
      });
    }
    if (error.code === 'LIMIT_FIELD_COUNT') {
      return res.status(400).json({
        error: 'Too Many Fields',
        message: 'Form has too many fields'
      });
    }
  }

  if (error.code === 'INVALID_FILE_TYPE') {
    return res.status(400).json({
      error: 'Invalid File Type',
      message: error.message
    });
  }

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

const PORT = process.env.PORT || 3001;

app.listen(PORT, async () => {
  console.log('\n🚀 === SERVER STARTING ===');
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`✅ Success page: http://localhost:${PORT}/success`);
  console.log(`🌐 CORS enabled for: 127.0.0.1:5500, localhost:3000, localhost:3001`);
  
  const connected = await testConnections();
  if (connected) {
    console.log('🎉 All systems ready!');
  } else {
    console.log('⚠️  Some connections failed - check configuration');
  }
  console.log('='.repeat(50));
});

module.exports = app;