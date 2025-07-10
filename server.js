const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');
const { exec } = require('child_process');
const util = require('util');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const execAsync = util.promisify(exec);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// MongoDB connection with initialization
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://cvmaster121:cvmaster121@cluster0.lfu8e4d.mongodb.net/cvmaster?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(async () => {
  await initializeDatabase();
})
.catch(err => {
  process.exit(1);
});

// Function to initialize database and ensure collections exist
async function initializeDatabase() {
  try {
    // Force database creation by creating a document
    const db = mongoose.connection.db;
    
    // Check if the database exists by trying to get stats
    const admin = db.admin();
    const databases = await admin.listDatabases();
    const dbExists = databases.databases.some(d => d.name === 'cvmaster');
    
    if (!dbExists) {
      // Create a temporary document to force database creation
      const tempCollection = db.collection('_temp');
      await tempCollection.insertOne({ init: true, createdAt: new Date() });
      await tempCollection.drop();
    }
    
    // Check if collections exist
    const collections = await db.listCollections().toArray();
    
    // Ensure models are registered and collections exist
    const modelsToInit = [
      { model: User, name: 'users' },
      { model: Analysis, name: 'analyses' },
      { model: Comment, name: 'comments' } // Add comments collection
    ];
    
    for (const { model, name } of modelsToInit) {
      const exists = collections.some(c => c.name === name);
      if (!exists) {
        // Create collection by creating and deleting a document
        const doc = new model({
          _id: new mongoose.Types.ObjectId(),
          ...(name === 'users' ? {
            clerkId: '_init_temp',
            email: 'init@temp.com',
          } : name === 'analyses' ? {
            userId: '_init_temp',
            fileName: '_init',
            fileType: 'text',
            targetRole: '_init',
            resumeText: '_init',
            score: 0,
          } : {
            userId: '_init_temp',
            content: '_init',
            userName: '_init',
          })
        });
        
        await doc.save();
        await model.deleteOne({ _id: doc._id });
      }
    }
    
    // Create indexes for better performance
    await createIndexes();
    
  } catch (error) {
    // Don't exit on initialization error, just log it
  }
}

// Function to create indexes
async function createIndexes() {
  try {
    // User indexes
    await User.collection.createIndex({ clerkId: 1 }, { unique: true });
    await User.collection.createIndex({ email: 1 });
    
    // Analysis indexes
    await Analysis.collection.createIndex({ userId: 1 });
    await Analysis.collection.createIndex({ createdAt: -1 });
    await Analysis.collection.createIndex({ userId: 1, createdAt: -1 });
    await Analysis.collection.createIndex({ targetRole: 1 });
    await Analysis.collection.createIndex({ score: -1 });
    
    // Comment indexes
    await Comment.collection.createIndex({ createdAt: -1 });
    await Comment.collection.createIndex({ userId: 1 });
    await Comment.collection.createIndex({ userId: 1, createdAt: -1 });
  } catch (error) {
    // Handle error silently
  }
}

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

// NEW: Comment schema
const commentSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  userName: { type: String, required: true },
  userEmail: { type: String, required: true },
  content: { type: String, required: true, maxlength: 1000 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const User = mongoose.model('User', userSchema);
const Analysis = mongoose.model('Analysis', analysisSchema);
const Comment = mongoose.model('Comment', commentSchema);

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

// ENHANCED PDF PARSING FUNCTIONS
// File validation function
async function validateFile(filePath, originalName) {
  try {
    const stats = await fs.stat(filePath);
    
    // Check file size (max 10MB)
    if (stats.size > 10 * 1024 * 1024) {
      throw new Error('File size exceeds 10MB limit');
    }
    
    // Check if file is empty
    if (stats.size === 0) {
      throw new Error('File is empty');
    }
    
    // Additional file type validation based on content
    const buffer = await fs.readFile(filePath);
    
    // PDF signature check
    if (originalName.toLowerCase().endsWith('.pdf')) {
      const pdfSignature = buffer.slice(0, 4).toString();
      if (!pdfSignature.includes('%PDF')) {
        throw new Error('Invalid PDF file format');
      }
    }
    
    return true;
  } catch (error) {
    throw new Error(`File validation failed: ${error.message}`);
  }
}

// Enhanced PDF text extraction with multiple fallback strategies
async function extractPDFText(filePath) {
  const strategies = [
    () => extractWithPdfParse(filePath),
    () => extractWithPdfParseOptions(filePath),
    () => extractWithPopplerUtils(filePath),
    () => extractBasicPdfInfo(filePath)
  ];

  let lastError;
  
  for (const [index, strategy] of strategies.entries()) {
    try {
      const result = await strategy();
      
      if (result && result.trim().length > 0) {
        return result;
      }
    } catch (error) {
      lastError = error;
      continue;
    }
  }
  
  // If all strategies fail, return a meaningful error
  throw new Error(`Unable to extract text from PDF. All extraction methods failed. Last error: ${lastError?.message || 'Unknown error'}`);
}

// Strategy 1: Standard pdf-parse
async function extractWithPdfParse(filePath) {
  const dataBuffer = await fs.readFile(filePath);
  const data = await pdf(dataBuffer);
  return data.text;
}

// Strategy 2: pdf-parse with custom options
async function extractWithPdfParseOptions(filePath) {
  const dataBuffer = await fs.readFile(filePath);
  
  const options = {
    pagerender: renderPage,
    normalizeWhitespace: true,
    disableCombineTextItems: false,
    max: 0, // Maximum number of pages to parse
  };
  
  const data = await pdf(dataBuffer, options);
  return data.text;
}

// Custom page render function for pdf-parse
function renderPage(pageData) {
  // Check if we have text items
  if (!pageData.getTextContent) {
    return '';
  }
  
  return pageData.getTextContent().then(textContent => {
    let lastY, text = '';
    
    for (let item of textContent.items) {
      if (lastY == item.transform[5] || !lastY) {
        text += item.str;
      } else {
        text += '\n' + item.str;
      }
      lastY = item.transform[5];
    }
    return text;
  }).catch(() => '');
}

// Strategy 3: Using poppler-utils (if available on system)
async function extractWithPopplerUtils(filePath) {
  try {
    const { stdout } = await execAsync(`pdftotext "${filePath}" -`);
    return stdout;
  } catch (error) {
    throw new Error('Poppler utils not available or failed');
  }
}

// Strategy 4: Basic PDF info extraction (last resort)
async function extractBasicPdfInfo(filePath) {
  const dataBuffer = await fs.readFile(filePath);
  
  // Try to extract basic info from PDF structure
  const pdfString = dataBuffer.toString('binary');
  
  // Extract title and subject if available
  let extractedText = '';
  
  // Look for title
  const titleMatch = pdfString.match(/\/Title\s*\(([^)]+)\)/);
  if (titleMatch) {
    extractedText += `Title: ${titleMatch[1]}\n`;
  }
  
  // Look for subject
  const subjectMatch = pdfString.match(/\/Subject\s*\(([^)]+)\)/);
  if (subjectMatch) {
    extractedText += `Subject: ${subjectMatch[1]}\n`;
  }
  
  // Look for keywords
  const keywordsMatch = pdfString.match(/\/Keywords\s*\(([^)]+)\)/);
  if (keywordsMatch) {
    extractedText += `Keywords: ${keywordsMatch[1]}\n`;
  }
  
  // Try to extract some readable text patterns
  const textMatches = pdfString.match(/\(([A-Za-z0-9\s,\.]{10,})\)/g);
  if (textMatches) {
    const cleanText = textMatches
      .map(match => match.slice(1, -1))
      .filter(text => text.length > 10 && /[a-zA-Z]/.test(text))
      .join(' ');
    extractedText += cleanText;
  }
  
  if (extractedText.trim().length === 0) {
    throw new Error('No readable text found in PDF');
  }
  
  return extractedText;
}

// Enhanced Word document extraction
async function extractWordText(filePath) {
  try {
    const dataBuffer = await fs.readFile(filePath);
    const result = await mammoth.extractRawText({ buffer: dataBuffer });
    
    if (!result.value || result.value.trim().length === 0) {
      throw new Error('No text content found in document');
    }
    
    return result.value;
  } catch (error) {
    throw new Error(`Failed to extract text from Word document: ${error.message}`);
  }
}

// Main text extraction function with enhanced error handling
async function extractTextFromFile(filePath, fileType, originalName) {
  try {
    // Validate file first
    await validateFile(filePath, originalName);
    
    let text;
    
    if (fileType === 'application/pdf' || path.extname(filePath).toLowerCase() === '.pdf') {
      text = await extractPDFText(filePath);
    } else if (fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || 
               fileType === 'application/msword' || 
               path.extname(filePath).toLowerCase() === '.docx' ||
               path.extname(filePath).toLowerCase() === '.doc') {
      text = await extractWordText(filePath);
    } else if (fileType === 'text/plain' || path.extname(filePath).toLowerCase() === '.txt') {
      text = await fs.readFile(filePath, 'utf8');
    } else {
      throw new Error('Unsupported file type');
    }
    
    // Validate extracted text
    if (!text || text.trim().length === 0) {
      throw new Error('No readable text found in the file');
    }
    
    // Check if text is too short (might indicate extraction failure)
    if (text.trim().length < 10) {
      throw new Error('Extracted text is too short - file might be corrupted or contain only images');
    }
    
    return text;
  } catch (error) {
    // Return a user-friendly error message
    if (error.message.includes('bad XRef entry') || error.message.includes('PDF')) {
      throw new Error('This PDF file appears to be corrupted or uses an unsupported format. Please try converting it to a different format or using a text file instead.');
    } else if (error.message.includes('Word') || error.message.includes('docx')) {
      throw new Error('Unable to read this Word document. Please try saving it as a PDF or text file.');
    } else {
      throw new Error(`Unable to extract text from this file: ${error.message}`);
    }
  }
}

// Enhanced Gemini API helper function
async function analyzeWithGemini(resumeText, targetRole) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyC_6VsNFZV_jELQrwz1dF6nnmQN00RBk-U';
  const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

  // Truncate very long resumes to avoid API limits
  const maxLength = 15000;
  const truncatedText = resumeText.length > maxLength 
    ? resumeText.substring(0, maxLength) + '...[truncated]'
    : resumeText;

  const prompt = `
    You are an expert resume analyzer and career consultant. Analyze the following resume for the target role: "${targetRole}".
    
    Resume content:
    ${truncatedText}
    
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
        },
        safetySettings: [
          {
            category: "HARM_CATEGORY_HARASSMENT",
            threshold: "BLOCK_MEDIUM_AND_ABOVE"
          },
          {
            category: "HARM_CATEGORY_HATE_SPEECH",
            threshold: "BLOCK_MEDIUM_AND_ABOVE"
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        params: {
          key: GEMINI_API_KEY
        },
        timeout: 30000 // 30 second timeout
      }
    );

    if (!response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      throw new Error('Invalid response format from Gemini API');
    }

    const generatedText = response.data.candidates[0].content.parts[0].text;
    
    // Clean the response to ensure valid JSON
    let cleanedText = generatedText.trim();
    // Remove markdown code blocks if present
    cleanedText = cleanedText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    
    try {
      const analysis = JSON.parse(cleanedText);
      
      // Validate analysis structure and provide defaults
      return {
        score: analysis.score || 0,
        atsScore: analysis.atsScore || 0,
        strengths: Array.isArray(analysis.strengths) ? analysis.strengths : ['Analysis pending'],
        improvements: Array.isArray(analysis.improvements) ? analysis.improvements : ['Analysis pending'],
        keywords: Array.isArray(analysis.keywords) ? analysis.keywords : [],
        suggestions: Array.isArray(analysis.suggestions) ? analysis.suggestions : ['Analysis pending'],
        rewrittenResume: analysis.rewrittenResume || 'Enhanced resume will be generated',
        coverLetter: analysis.coverLetter || 'Cover letter will be generated'
      };
    } catch (parseError) {
      throw new Error('Invalid response format from AI service');
    }
  } catch (error) {
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
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// NEW: Comment routes
app.post('/api/comments', async (req, res) => {
  try {
    const { userId, userName, userEmail, content } = req.body;
    
    if (!userId || !userName || !userEmail || !content) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    
    // Validate content length
    if (content.length > 1000) {
      return res.status(400).json({ error: 'Comment cannot exceed 1000 characters' });
    }
    
    // Validate content is not empty after trimming
    if (content.trim().length === 0) {
      return res.status(400).json({ error: 'Comment cannot be empty' });
    }
    
    const comment = new Comment({
      userId,
      userName,
      userEmail,
      content: content.trim(),
    });
    
    await comment.save();
    
    res.json({ success: true, comment });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create comment' });
  }
});

app.get('/api/comments', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    
    const comments = await Comment.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('-userEmail'); // Don't expose email addresses
    
    const total = await Comment.countDocuments();
    
    res.json({
      comments,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get comments' });
  }
});

app.get('/api/comments/user/:userId', async (req, res) => {
  try {
    const comments = await Comment.find({ userId: req.params.userId })
      .sort({ createdAt: -1 })
      .limit(20);
    
    res.json(comments);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get user comments' });
  }
});

app.put('/api/comments/:commentId', async (req, res) => {
  try {
    const { content, userId } = req.body;
    
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Comment cannot be empty' });
    }
    
    if (content.length > 1000) {
      return res.status(400).json({ error: 'Comment cannot exceed 1000 characters' });
    }
    
    const comment = await Comment.findOneAndUpdate(
      { _id: req.params.commentId, userId }, // Only allow user to update their own comment
      {
        content: content.trim(),
        updatedAt: new Date(),
      },
      { new: true }
    );
    
    if (!comment) {
      return res.status(404).json({ error: 'Comment not found or unauthorized' });
    }
    
    res.json({ success: true, comment });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update comment' });
  }
});

app.delete('/api/comments/:commentId', async (req, res) => {
  try {
    const { userId } = req.body;
    
    const comment = await Comment.findOneAndDelete({
      _id: req.params.commentId,
      userId, // Only allow user to delete their own comment
    });
    
    if (!comment) {
      return res.status(404).json({ error: 'Comment not found or unauthorized' });
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete comment' });
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
    res.status(500).json({ error: 'Failed to analyze resume' });
  }
});

// Enhanced file analysis route
app.post('/api/analyze/file', upload.single('resume'), async (req, res) => {
  let filePath = null;
  
  try {
    if (!req.file) {
      return res.status(400).json({ 
        error: 'No file uploaded',
        details: 'Please select a file to upload'
      });
    }
    
    filePath = req.file.path;
    const { targetRole, userId } = req.body;
    
    if (!targetRole || !userId) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        details: 'Target role and user ID are required'
      });
    }
    
    // Extract text from file with enhanced error handling
    let resumeText;
    try {
      resumeText = await extractTextFromFile(filePath, req.file.mimetype, req.file.originalname);
    } catch (extractionError) {
      return res.status(400).json({
        error: 'File processing failed',
        details: extractionError.message,
        suggestions: [
          'Try converting your PDF to a text file',
          'Ensure your PDF is not password protected',
          'Check that your file is not corrupted',
          'Try using a different file format (DOCX, TXT)'
        ]
      });
    }
    
    // Validate extracted text quality
    if (resumeText.length < 50) {
      return res.status(400).json({
        error: 'Insufficient content',
        details: 'The extracted text is too short. This might indicate that your file contains mostly images or is corrupted.',
        extractedLength: resumeText.length,
        suggestions: [
          'Ensure your resume contains readable text, not just images',
          'Try copying and pasting your resume text instead',
          'Convert image-based PDFs to text-based format'
        ]
      });
    }
    
    // Analyze with Gemini
    let analysis;
    try {
      analysis = await analyzeWithGemini(resumeText, targetRole);
    } catch (analysisError) {
      return res.status(500).json({
        error: 'AI analysis failed',
        details: 'Unable to analyze your resume at the moment. Please try again later.',
        extractedText: resumeText.substring(0, 200) + '...' // Show first 200 chars for debugging
      });
    }
    
    // Save analysis to database
    const savedAnalysis = new Analysis({
      userId,
      fileName: req.file.originalname,
      fileType: 'file',
      targetRole,
      resumeText,
      score: analysis.score,
      analysis: {
        strengths: analysis.strengths || [],
        improvements: analysis.improvements || [],
        keywords: analysis.keywords || [],
        atsScore: analysis.atsScore || 0,
        suggestions: analysis.suggestions || [],
      },
      rewrittenResume: analysis.rewrittenResume || '',
      coverLetter: analysis.coverLetter || '',
    });
    
    await savedAnalysis.save();
    
    res.json({
      success: true,
      analysisId: savedAnalysis._id,
      fileName: req.file.originalname,
      extractedLength: resumeText.length,
      score: analysis.score,
      analysis: savedAnalysis.analysis,
      rewrittenResume: analysis.rewrittenResume,
      coverLetter: analysis.coverLetter,
    });
    
  } catch (error) {
    // Determine error type and provide appropriate response
    let errorMessage = 'Failed to analyze resume';
    let errorDetails = error.message;
    let statusCode = 500;
    
    if (error.message.includes('PDF') || error.message.includes('corrupted')) {
      statusCode = 400;
      errorMessage = 'File format issue';
      errorDetails = 'Unable to process this file. Please try a different format or ensure the file is not corrupted.';
    } else if (error.message.includes('Gemini') || error.message.includes('AI')) {
      statusCode = 503;
      errorMessage = 'AI service temporarily unavailable';
      errorDetails = 'Please try again in a few moments.';
    }
    
    res.status(statusCode).json({ 
      error: errorMessage,
      details: errorDetails,
      fileName: req.file?.originalname,
      timestamp: new Date().toISOString()
    });
    
  } finally {
    // Always clean up uploaded file
    if (filePath) {
      try {
        await fs.unlink(filePath);
      } catch (cleanupError) {
        // Handle cleanup error silently
      }
    }
  }
});

app.get('/api/analyses/:userId', async (req, res) => {
  try {
    const analyses = await Analysis.find({ userId: req.params.userId })
      .sort({ createdAt: -1 })
      .select('-resumeText -rewrittenResume -coverLetter'); // Exclude large text fields for list view
    
    res.json(analyses);
  } catch (error) {
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
    
    const filename = `resume-${analysis.targetRole.replace(/\s+/g, '-')}-enhanced.txt`;
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', Buffer.byteLength(analysis.rewrittenResume, 'utf8'));
    res.send(analysis.rewrittenResume);
  } catch (error) {
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
    
    const filename = `cover-letter-${analysis.targetRole.replace(/\s+/g, '-')}.txt`;
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', Buffer.byteLength(analysis.coverLetter, 'utf8'));
    res.send(analysis.coverLetter);
  } catch (error) {
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
    const report = `RESUME ANALYSIS REPORT
======================

ANALYSIS DETAILS
----------------
Date: ${new Date(analysis.createdAt).toLocaleDateString()}
Target Role: ${analysis.targetRole}
Overall Score: ${analysis.score}/100
ATS Score: ${analysis.analysis.atsScore || 'N/A'}/100

STRENGTHS
---------
${analysis.analysis.strengths?.map(s => `• ${s}`).join('\n') || 'No strengths identified'}

AREAS FOR IMPROVEMENT
--------------------
${analysis.analysis.improvements?.map(i => `• ${i}`).join('\n') || 'No improvements identified'}

KEY KEYWORDS
------------
${analysis.analysis.keywords?.join(', ') || 'No keywords identified'}

RECOMMENDATIONS
---------------
${analysis.analysis.suggestions?.map(s => `• ${s}`).join('\n') || 'No suggestions provided'}

============================================================

ENHANCED RESUME
===============
${analysis.rewrittenResume || 'No enhanced resume available'}

============================================================

COVER LETTER
============
${analysis.coverLetter || 'No cover letter available'}
`;
    
    const filename = `analysis-report-${analysis.targetRole.replace(/\s+/g, '-')}.txt`;
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', Buffer.byteLength(report, 'utf8'));
    res.send(report);
  } catch (error) {
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
    res.status(500).json({ error: 'Failed to get statistics' });
  }
});

// Manual database initialization endpoint
app.post('/api/init-db', async (req, res) => {
  try {
    // Check if already connected
    if (mongoose.connection.readyState !== 1) {
      return res.status(500).json({ error: 'Database not connected' });
    }
    
    const db = mongoose.connection.db;
    
    // Force create collections by inserting and removing a document
    const collections = ['users', 'analyses', 'comments'];
    const results = [];
    
    for (const collName of collections) {
      try {
        const coll = db.collection(collName);
        
        // Insert a temporary document
        const result = await coll.insertOne({ 
          _temp: true, 
          createdAt: new Date(),
          _id: new mongoose.Types.ObjectId()
        });
        
        // Remove the temporary document
        await coll.deleteOne({ _id: result.insertedId });
        
        results.push({ collection: collName, status: 'created' });
      } catch (error) {
        results.push({ collection: collName, status: 'error', error: error.message });
      }
    }
    
    // Create indexes
    await createIndexes();
    
    // Get final collection list
    const finalCollections = await db.listCollections().toArray();
    
    res.json({
      success: true,
      database: mongoose.connection.name || 'cvmaster',
      results,
      collections: finalCollections.map(c => c.name),
      indexes: {
        users: await User.collection.indexes(),
        analyses: await Analysis.collection.indexes(),
        comments: await Comment.collection.indexes()
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to initialize database', details: error.message });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Smart Resume Analyzer Backend Server',
    apiEndpoint: '/api',
    status: 'running',
    version: '2.1.0',
    features: ['Enhanced PDF Processing', 'Multiple Extraction Strategies', 'Better Error Handling', 'Comment System', '50-Second Monitoring']
  });
});

// Root API endpoint
app.get('/api', (req, res) => {
  res.json({
    message: 'Smart Resume Analyzer API',
    version: '2.1.0',
    endpoints: {
      health: 'GET /api/health',
      users: {
        sync: 'POST /api/users/sync',
        get: 'GET /api/users/:clerkId',
        updateProfile: 'PUT /api/users/:clerkId/profile'
      },
      comments: {
        create: 'POST /api/comments',
        getAll: 'GET /api/comments',
        getUserComments: 'GET /api/comments/user/:userId',
        update: 'PUT /api/comments/:commentId',
        delete: 'DELETE /api/comments/:commentId'
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
        coverLetter: 'GET /api/download/coverletter/:analysisId',
        report: 'GET /api/download/report/:analysisId'
      },
      stats: 'GET /api/stats/:userId'
    }
  });
});

// Health check with database status
app.get('/api/health', async (req, res) => {
  try {
    // Check MongoDB connection
    const dbState = mongoose.connection.readyState;
    const dbStatus = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting',
    };
    
    // Get collection counts
    let userCount = 0;
    let analysisCount = 0;
    let commentCount = 0;
    
    if (dbState === 1) {
      userCount = await User.countDocuments();
      analysisCount = await Analysis.countDocuments();
      commentCount = await Comment.countDocuments();
    }
    
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      database: {
        status: dbStatus[dbState],
        name: mongoose.connection.name || 'cvmaster',
        collections: {
          users: userCount,
          analyses: analysisCount,
          comments: commentCount,
        }
      },
      uptime: process.uptime(),
      version: '2.1.0',
      features: ['Enhanced PDF Processing', 'Multiple Extraction Strategies', 'Better Error Handling', 'Comment System', '50-Second Monitoring']
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      timestamp: new Date().toISOString(),
      error: error.message 
    });
  }
});

// Database reset endpoint (for development only)
app.post('/api/reset-db', async (req, res) => {
  try {
    // Only allow in development
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Database reset not allowed in production' });
    }
    
    // Drop all collections
    await User.deleteMany({});
    await Analysis.deleteMany({});
    await Comment.deleteMany({});
    
    res.json({ 
      success: true, 
      message: 'Database reset successfully',
      collections: {
        users: await User.countDocuments(),
        analyses: await Analysis.countDocuments(),
        comments: await Comment.countDocuments(),
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reset database' });
  }
});

// Seed data endpoint (for testing - remove in production)
app.post('/api/seed', async (req, res) => {
  try {
    // Only allow in development
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Seeding not allowed in production' });
    }
    
    // Create a test user
    const testUser = await User.findOneAndUpdate(
      { clerkId: 'test_user_123' },
      {
        clerkId: 'test_user_123',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        profile: {
          jobTitle: 'Software Engineer',
          company: 'Tech Corp',
          location: 'San Francisco, CA',
        },
      },
      { upsert: true, new: true }
    );
    
    // Create sample analyses
    const sampleAnalyses = [
      {
        userId: 'test_user_123',
        fileName: 'john_doe_resume.pdf',
        fileType: 'file',
        targetRole: 'Senior Developer',
        resumeText: 'Sample resume content...',
        score: 85,
        analysis: {
          strengths: ['Strong technical skills', 'Good project experience'],
          improvements: ['Add more quantifiable achievements'],
          keywords: ['JavaScript', 'React', 'Node.js'],
          atsScore: 82,
          suggestions: ['Include more action verbs'],
        },
        rewrittenResume: '# Enhanced Resume\n\nSample enhanced content...',
        coverLetter: '# Cover Letter\n\nDear Hiring Manager...',
      },
    ];
    
    await Analysis.insertMany(sampleAnalyses);
    
    // Create sample comments
    const sampleComments = [
      {
        userId: 'test_user_123',
        userName: 'Test User',
        userEmail: 'test@example.com',
        content: 'This resume analyzer is amazing! It helped me improve my resume significantly.',
      },
      {
        userId: 'test_user_456',
        userName: 'Jane Doe',
        userEmail: 'jane@example.com',
        content: 'Great tool for job seekers. The ATS optimization feature is particularly helpful.',
      },
    ];
    
    await Comment.insertMany(sampleComments);
    
    res.json({ 
      success: true, 
      message: 'Seed data created successfully',
      user: testUser,
      analysesCreated: sampleAnalyses.length,
      commentsCreated: sampleComments.length,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to seed data' });
  }
});

// Keep-alive endpoint for external monitoring
app.get('/api/keep-alive', (req, res) => {
  res.json({ 
    status: 'alive', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  res.status(500).json({ error: error.message || 'Internal server error' });
});

// Start server
const server = app.listen(PORT, () => {
  // Start cron jobs after server starts
  startCronJobs();
});

// ENHANCED Cron Jobs with 50-second monitoring
function startCronJobs() {
  // NEW: 50-second monitoring cron job
  cron.schedule('*/50 * * * * *', async () => {
    const timestamp = new Date().toISOString();
    
    try {
      // Quick system status check
      const memUsage = process.memoryUsage();
      const memUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      const memTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
      
      // Database connection check
      const dbState = mongoose.connection.readyState;
      const dbStatusMap = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
      
      // Optional: Perform lightweight cleanup
      if (global.gc && memUsedMB > 200) {
        global.gc(); // Force garbage collection if available and memory usage is high
      }
      
      // Check for stuck uploads (files older than 10 minutes)
      await quickFileCleanup();
      
    } catch (error) {
      // Handle error silently
    }
  });
  
  // Health check cron job - runs every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      // Database health check
      const dbState = mongoose.connection.readyState;
      if (dbState === 1) {
        const userCount = await User.countDocuments();
        const analysisCount = await Analysis.countDocuments();
        const commentCount = await Comment.countDocuments();
      }
      
      // Optional: Clean up old temporary files
      await cleanupOldFiles();
      
      // Optional: Send metrics or perform maintenance tasks
      await performMaintenance();
      
    } catch (error) {
      // Handle error silently
    }
  });
  
  // Database optimization cron job - runs daily at 2 AM
  cron.schedule('0 2 * * *', async () => {
    try {
      // Compact database collections
      if (mongoose.connection.readyState === 1) {
        await mongoose.connection.db.command({ compact: 'users' });
        await mongoose.connection.db.command({ compact: 'analyses' });
        await mongoose.connection.db.command({ compact: 'comments' });
      }
    } catch (error) {
      // Handle error silently
    }
  });
}

// NEW: Quick file cleanup function for 50-second monitoring
async function quickFileCleanup() {
  try {
    const uploadDir = 'uploads/';
    
    // Check if uploads directory exists
    try {
      await fs.access(uploadDir);
    } catch {
      // Directory doesn't exist, nothing to clean
      return;
    }
    
    const files = await fs.readdir(uploadDir);
    const now = Date.now();
    const tenMinutesAgo = now - (10 * 60 * 1000); // 10 minutes in milliseconds
    let cleanedCount = 0;
    
    for (const file of files) {
      const filePath = path.join(uploadDir, file);
      const stats = await fs.stat(filePath);
      
      // Delete files older than 10 minutes (stuck uploads)
      if (stats.mtimeMs < tenMinutesAgo) {
        await fs.unlink(filePath);
        cleanedCount++;
      }
    }
    
  } catch (error) {
    // Silently ignore cleanup errors in the 50s monitor
  }
}

// Helper function to clean up old uploaded files
async function cleanupOldFiles() {
  try {
    const uploadDir = 'uploads/';
    
    // Check if uploads directory exists
    try {
      await fs.access(uploadDir);
    } catch {
      // Directory doesn't exist, nothing to clean
      return;
    }
    
    const files = await fs.readdir(uploadDir);
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000); // 1 hour in milliseconds
    
    for (const file of files) {
      const filePath = path.join(uploadDir, file);
      const stats = await fs.stat(filePath);
      
      // Delete files older than 1 hour
      if (stats.mtimeMs < oneHourAgo) {
        await fs.unlink(filePath);
      }
    }
  } catch (error) {
    // Handle error silently
  }
}

// Helper function for maintenance tasks
async function performMaintenance() {
  try {
    // Example: Clean up very old analyses (optional)
    if (process.env.AUTO_CLEANUP === 'true') {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const result = await Analysis.deleteMany({
        createdAt: { $lt: thirtyDaysAgo },
        // Only delete if user hasn't logged in recently
      });
    }
    
    // Log current system stats
    const memUsage = process.memoryUsage();
  } catch (error) {
    // Handle error silently
  }
}

// Cleanup on exit
process.on('SIGINT', async () => {
  // Stop cron jobs
  cron.getTasks().forEach(task => task.stop());
  
  // Close database connection
  await mongoose.connection.close();
  
  // Close server
  server.close(() => {
    process.exit(0);
  });
});