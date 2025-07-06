const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://cvmaster:cvmaster@cluster0.x4mwoog.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('MongoDB connected successfully'))
.catch(err => console.error('MongoDB connection error:', err));

// Schemas
const userSchema = new mongoose.Schema({
  clerkId: { type: String, required: true, unique: true },
  email: { type: String, required: true },
  firstName: String,
  lastName: String,
  profile: {
    jobTitle: String,
    company: String,
    location: String,
    phone: String,
    linkedin: String,
    bio: String,
  },
  preferences: {
    emailNotifications: { type: Boolean, default: true },
    weeklyReports: { type: Boolean, default: false },
    marketingEmails: { type: Boolean, default: false },
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const analysisSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  fileName: { type: String, required: true },
  fileType: { type: String, enum: ['text', 'file'], required: true },
  targetRole: { type: String, required: true },
  resumeText: { type: String, required: true },
  score: { type: Number, required: true },
  analysis: {
    strengths: [String],
    improvements: [String],
    keywords: [String],
    atsScore: Number,
    suggestions: [String],
  },
  rewrittenResume: String,
  coverLetter: String,
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model('User', userSchema);
const Analysis = mongoose.model('Analysis', analysisSchema);

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = 'uploads/';
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /pdf|doc|docx|txt/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only PDF, DOC, DOCX, and TXT files are allowed'));
    }
  }
});

// Helper function to extract text from different file types
async function extractTextFromFile(filePath, fileType) {
  try {
    if (fileType === 'application/pdf' || path.extname(filePath).toLowerCase() === '.pdf') {
      const dataBuffer = await fs.readFile(filePath);
      const data = await pdf(dataBuffer);
      return data.text;
    } else if (fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || 
               fileType === 'application/msword' || 
               path.extname(filePath).toLowerCase() === '.docx' ||
               path.extname(filePath).toLowerCase() === '.doc') {
      const dataBuffer = await fs.readFile(filePath);
      const result = await mammoth.extractRawText({ buffer: dataBuffer });
      return result.value;
    } else if (fileType === 'text/plain' || path.extname(filePath).toLowerCase() === '.txt') {
      return await fs.readFile(filePath, 'utf8');
    } else {
      throw new Error('Unsupported file type');
    }
  } catch (error) {
    console.error('Error extracting text:', error);
    throw error;
  }
}

// Gemini API helper function
async function analyzeWithGemini(resumeText, targetRole) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyC_6VsNFZV_jELQrwz1dF6nnmQN00RBk-U';
  const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

  const prompt = `
    You are an expert resume analyzer and career consultant. Analyze the following resume for the target role: "${targetRole}".
    
    Resume content:
    ${resumeText}
    
    Please provide a comprehensive analysis in the following JSON format:
    {
      "score": <number between 0-100>,
      "atsScore": <number between 0-100>,
      "strengths": [<list of 3-5 key strengths>],
      "improvements": [<list of 3-5 areas for improvement>],
      "keywords": [<list of 5-10 relevant keywords missing or present>],
      "suggestions": [<list of 3-5 specific actionable suggestions>],
      "rewrittenResume": "<complete rewritten resume in markdown format optimized for the target role>",
      "coverLetter": "<professional cover letter tailored for the target role in markdown format>"
    }
    
    Make sure the rewritten resume and cover letter are ATS-friendly, use industry-specific keywords, and are tailored specifically for the ${targetRole} position.
    
    IMPORTANT: Return ONLY valid JSON without any markdown formatting or backticks.
  `;

  try {
    const response = await axios.post(
      GEMINI_API_URL,
      {
        contents: [{
          parts: [{
            text: prompt
          }]
        }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192,
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        params: {
          key: GEMINI_API_KEY
        }
      }
    );

    const generatedText = response.data.candidates[0].content.parts[0].text;
    
    // Clean the response to ensure valid JSON
    let cleanedText = generatedText.trim();
    // Remove markdown code blocks if present
    cleanedText = cleanedText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    
    const analysis = JSON.parse(cleanedText);
    return analysis;
  } catch (error) {
    console.error('Gemini API error:', error.response?.data || error.message);
    throw new Error('Failed to analyze resume with AI');
  }
}

// Routes

// User routes
app.post('/api/users/sync', async (req, res) => {
  try {
    const { clerkId, email, firstName, lastName } = req.body;
    
    let user = await User.findOne({ clerkId });
    
    if (!user) {
      user = new User({
        clerkId,
        email,
        firstName,
        lastName,
      });
    } else {
      user.email = email;
      user.firstName = firstName;
      user.lastName = lastName;
      user.updatedAt = new Date();
    }
    
    await user.save();
    res.json({ success: true, user });
  } catch (error) {
    console.error('User sync error:', error);
    res.status(500).json({ error: 'Failed to sync user' });
  }
});

app.get('/api/users/:clerkId', async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.params.clerkId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

app.put('/api/users/:clerkId/profile', async (req, res) => {
  try {
    const { profile, preferences } = req.body;
    
    const user = await User.findOneAndUpdate(
      { clerkId: req.params.clerkId },
      {
        profile,
        preferences,
        updatedAt: new Date(),
      },
      { new: true }
    );
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Analysis routes
app.post('/api/analyze/text', async (req, res) => {
  try {
    const { resumeText, targetRole, userId } = req.body;
    
    if (!resumeText || !targetRole || !userId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Analyze with Gemini
    const analysis = await analyzeWithGemini(resumeText, targetRole);
    
    // Save analysis to database
    const savedAnalysis = new Analysis({
      userId,
      fileName: 'Pasted Resume',
      fileType: 'text',
      targetRole,
      resumeText,
      score: analysis.score,
      analysis: {
        strengths: analysis.strengths,
        improvements: analysis.improvements,
        keywords: analysis.keywords,
        atsScore: analysis.atsScore,
        suggestions: analysis.suggestions,
      },
      rewrittenResume: analysis.rewrittenResume,
      coverLetter: analysis.coverLetter,
    });
    
    await savedAnalysis.save();
    
    res.json({
      success: true,
      analysisId: savedAnalysis._id,
      score: analysis.score,
      analysis: savedAnalysis.analysis,
      rewrittenResume: analysis.rewrittenResume,
      coverLetter: analysis.coverLetter,
    });
  } catch (error) {
    console.error('Text analysis error:', error);
    res.status(500).json({ error: 'Failed to analyze resume' });
  }
});

app.post('/api/analyze/file', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const { targetRole, userId } = req.body;
    
    if (!targetRole || !userId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Extract text from file
    const resumeText = await extractTextFromFile(req.file.path, req.file.mimetype);
    
    // Analyze with Gemini
    const analysis = await analyzeWithGemini(resumeText, targetRole);
    
    // Save analysis to database
    const savedAnalysis = new Analysis({
      userId,
      fileName: req.file.originalname,
      fileType: 'file',
      targetRole,
      resumeText,
      score: analysis.score,
      analysis: {
        strengths: analysis.strengths,
        improvements: analysis.improvements,
        keywords: analysis.keywords,
        atsScore: analysis.atsScore,
        suggestions: analysis.suggestions,
      },
      rewrittenResume: analysis.rewrittenResume,
      coverLetter: analysis.coverLetter,
    });
    
    await savedAnalysis.save();
    
    // Clean up uploaded file
    await fs.unlink(req.file.path);
    
    res.json({
      success: true,
      analysisId: savedAnalysis._id,
      score: analysis.score,
      analysis: savedAnalysis.analysis,
      rewrittenResume: analysis.rewrittenResume,
      coverLetter: analysis.coverLetter,
    });
  } catch (error) {
    console.error('File analysis error:', error);
    // Clean up file on error
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }
    res.status(500).json({ error: 'Failed to analyze resume' });
  }
});

app.get('/api/analyses/:userId', async (req, res) => {
  try {
    const analyses = await Analysis.find({ userId: req.params.userId })
      .sort({ createdAt: -1 })
      .select('-resumeText -rewrittenResume -coverLetter'); // Exclude large text fields for list view
    
    res.json(analyses);
  } catch (error) {
    console.error('Get analyses error:', error);
    res.status(500).json({ error: 'Failed to get analyses' });
  }
});

app.get('/api/analysis/:analysisId', async (req, res) => {
  try {
    const analysis = await Analysis.findById(req.params.analysisId);
    
    if (!analysis) {
      return res.status(404).json({ error: 'Analysis not found' });
    }
    
    res.json(analysis);
  } catch (error) {
    console.error('Get analysis error:', error);
    res.status(500).json({ error: 'Failed to get analysis' });
  }
});

app.delete('/api/analysis/:analysisId', async (req, res) => {
  try {
    const analysis = await Analysis.findByIdAndDelete(req.params.analysisId);
    
    if (!analysis) {
      return res.status(404).json({ error: 'Analysis not found' });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete analysis error:', error);
    res.status(500).json({ error: 'Failed to delete analysis' });
  }
});

// Download routes
app.get('/api/download/resume/:analysisId', async (req, res) => {
  try {
    const analysis = await Analysis.findById(req.params.analysisId);
    
    if (!analysis) {
      return res.status(404).json({ error: 'Analysis not found' });
    }
    
    // Ensure we have content to download
    if (!analysis.rewrittenResume) {
      return res.status(404).json({ error: 'No rewritten resume available' });
    }
    
    const filename = `resume-${analysis.targetRole.replace(/\s+/g, '-')}-enhanced.md`;
    
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', Buffer.byteLength(analysis.rewrittenResume, 'utf8'));
    res.send(analysis.rewrittenResume);
  } catch (error) {
    console.error('Download resume error:', error);
    res.status(500).json({ error: 'Failed to download resume' });
  }
});

app.get('/api/download/coverletter/:analysisId', async (req, res) => {
  try {
    const analysis = await Analysis.findById(req.params.analysisId);
    
    if (!analysis) {
      return res.status(404).json({ error: 'Analysis not found' });
    }
    
    // Ensure we have content to download
    if (!analysis.coverLetter) {
      return res.status(404).json({ error: 'No cover letter available' });
    }
    
    const filename = `cover-letter-${analysis.targetRole.replace(/\s+/g, '-')}.md`;
    
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', Buffer.byteLength(analysis.coverLetter, 'utf8'));
    res.send(analysis.coverLetter);
  } catch (error) {
    console.error('Download cover letter error:', error);
    res.status(500).json({ error: 'Failed to download cover letter' });
  }
});

// Download report route (combined analysis report)
app.get('/api/download/report/:analysisId', async (req, res) => {
  try {
    const analysis = await Analysis.findById(req.params.analysisId);
    
    if (!analysis) {
      return res.status(404).json({ error: 'Analysis not found' });
    }
    
    // Create a comprehensive report
    const report = `# Resume Analysis Report

## Analysis Details
- **Date:** ${new Date(analysis.createdAt).toLocaleDateString()}
- **Target Role:** ${analysis.targetRole}
- **Overall Score:** ${analysis.score}/100
- **ATS Score:** ${analysis.analysis.atsScore || 'N/A'}/100

## Strengths
${analysis.analysis.strengths?.map(s => `- ${s}`).join('\n') || 'No strengths identified'}

## Areas for Improvement
${analysis.analysis.improvements?.map(i => `- ${i}`).join('\n') || 'No improvements identified'}

## Key Keywords
${analysis.analysis.keywords?.join(', ') || 'No keywords identified'}

## Recommendations
${analysis.analysis.suggestions?.map(s => `- ${s}`).join('\n') || 'No suggestions provided'}

---

## Enhanced Resume
${analysis.rewrittenResume || 'No enhanced resume available'}

---

## Cover Letter
${analysis.coverLetter || 'No cover letter available'}
`;
    
    const filename = `analysis-report-${analysis.targetRole.replace(/\s+/g, '-')}.md`;
    
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', Buffer.byteLength(report, 'utf8'));
    res.send(report);
  } catch (error) {
    console.error('Download report error:', error);
    res.status(500).json({ error: 'Failed to download report' });
  }
});

// Stats route
app.get('/api/stats/:userId', async (req, res) => {
  try {
    const analyses = await Analysis.find({ userId: req.params.userId });
    
    const totalAnalyses = analyses.length;
    const averageScore = totalAnalyses > 0
      ? Math.round(analyses.reduce((sum, a) => sum + a.score, 0) / totalAnalyses)
      : 0;
    const bestScore = totalAnalyses > 0
      ? Math.max(...analyses.map(a => a.score))
      : 0;
    
    const roleDistribution = analyses.reduce((acc, analysis) => {
      acc[analysis.targetRole] = (acc[analysis.targetRole] || 0) + 1;
      return acc;
    }, {});
    
    res.json({
      totalAnalyses,
      averageScore,
      bestScore,
      roleDistribution,
      recentAnalyses: analyses.slice(0, 5).map(a => ({
        id: a._id,
        fileName: a.fileName,
        targetRole: a.targetRole,
        score: a.score,
        createdAt: a.createdAt,
      })),
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to get statistics' });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Smart Resume Analyzer Backend Server',
    apiEndpoint: '/api',
    status: 'running'
  });
});

// Root API endpoint
app.get('/api', (req, res) => {
  res.json({
    message: 'Smart Resume Analyzer API',
    version: '1.0.0',
    endpoints: {
      health: 'GET /api/health',
      users: {
        sync: 'POST /api/users/sync',
        get: 'GET /api/users/:clerkId',
        updateProfile: 'PUT /api/users/:clerkId/profile'
      },
      analysis: {
        analyzeText: 'POST /api/analyze/text',
        analyzeFile: 'POST /api/analyze/file',
        getAnalyses: 'GET /api/analyses/:userId',
        getAnalysis: 'GET /api/analysis/:analysisId',
        deleteAnalysis: 'DELETE /api/analysis/:analysisId'
      },
      download: {
        resume: 'GET /api/download/resume/:analysisId',
        coverLetter: 'GET /api/download/coverletter/:analysisId'
      },
      stats: 'GET /api/stats/:userId'
    }
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({ error: error.message || 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Cleanup on exit
process.on('SIGINT', async () => {
  await mongoose.connection.close();
  process.exit(0);
});