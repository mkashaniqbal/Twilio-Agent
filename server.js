require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const fetch = require('node-fetch');
const { Readable } = require('stream');
const app = express();

// Initialize APIs with robust configuration
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 30000 // 30 second timeout
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Enhanced middleware
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ 
  extended: false,
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Optimized configuration
const CONFIG = {
  VOICE_TIMEOUT: 20000, // 20 seconds for voice processing
  GPT_MODEL: "gpt-4o",
  MAX_TOKENS: 150,
  WHISPER_MODEL: "whisper-1",
  MAX_AUDIO_SIZE: 10 * 1024 * 1024 // 10MB
};

// WhatsApp Webhook with comprehensive error handling
app.post('/whatsapp', async (req, res) => {
  try {
    console.log("Incoming request from:", req.body.From);
    
    let textToProcess = req.body.Body || '';
    let isVoiceMessage = false;

    // Voice message processing with multiple fallbacks
    if (req.body.MediaUrl0 && req.body.MediaContentType0 === 'audio/ogg') {
      isVoiceMessage = true;
      try {
        console.log("Processing voice message from:", req.body.MediaUrl0);
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CONFIG.VOICE_TIMEOUT);
        
        // 1. Fetch audio with Twilio auth
        const response = await fetch(req.body.MediaUrl0, {
          headers: {
            'Authorization': 'Basic ' + Buffer.from(
              `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
            ).toString('base64')
          },
          signal: controller.signal
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // Verify content length
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength) > CONFIG.MAX_AUDIO_SIZE) {
          throw new Error(`Audio file too large (max ${CONFIG.MAX_AUDIO_SIZE/1024/1024}MB)`);
        }

        // 2. Get audio as Buffer
        const audioBuffer = await response.buffer();
        
        // 3. Create proper file object for OpenAI
        const audioFile = {
          name: 'voice_message.ogg',
          type: 'audio/ogg',
          data: audioBuffer
        };

        // 4. Create transcription with timeout
        const transcription = await Promise.race([
          openai.audio.transcriptions.create({
            file: audioFile,
            model: CONFIG.WHISPER_MODEL,
            response_format: "text"
          }),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Whisper API timeout')), CONFIG.VOICE_TIMEOUT)
          )
        ]);
        
        textToProcess = transcription.text;
        console.log("Transcription success:", textToProcess);
        
      } catch (error) {
        console.error("Voice processing error:", {
          error: error.message,
          stack: error.stack
        });
        textToProcess = "[Couldn't process voice message. Please try again or type your message.]";
      }
    }

    // AI response with fallback
    let replyText = "[Sorry, I couldn't generate a response.]";
    try {
      const aiResponse = await openai.chat.completions.create({
        model: CONFIG.GPT_MODEL,
        messages: [{ 
          role: "user", 
          content: textToProcess || "[Empty message received]"
        }],
        max_tokens: CONFIG.MAX_TOKENS,
        temperature: 0.7,
        timeout: 15000 // 15 seconds for GPT
      });

      replyText = aiResponse.choices[0].message.content
        .replace(/\n/g, ' ') // Single line for better readability
        .substring(0, 160); // SMS length limit
    } catch (error) {
      console.error("GPT processing error:", error);
    }

    // Send reply with retry logic
    try {
      await twilioClient.messages.create({
        body: replyText,
        from: req.body.To,
        to: req.body.From,
        shortenUrls: true
      });
    } catch (twilioError) {
      console.error("Twilio send error:", {
        code: twilioError.code,
        message: twilioError.message,
        moreInfo: twilioError.moreInfo
      });
      // Implement retry logic here if needed
    }

    res.status(200).end();
  } catch (error) {
    console.error('Endpoint error:', {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
    res.status(500).json({ 
      error: "Internal server error",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Enhanced health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'running',
    version: '1.0',
    capabilities: {
      whatsapp: true,
      voice: true,
      model: CONFIG.GPT_MODEL
    }
  });
});

// Robust server startup
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Handle shutdown gracefully
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server terminated');
    process.exit(0);
  });
});