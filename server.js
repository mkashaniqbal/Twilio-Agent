require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const FormData = require('form-data'); // Changed from { File } to FormData
const fetch = require('node-fetch');
const fs = require('fs');
const app = express();

// Initialize APIs with enhanced configuration
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 10000 // 10-second timeout for all OpenAI requests
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Enhanced middleware for Meta Glasses compatibility
app.use(express.json({
  limit: '10kb' // Prevent large payloads
}));

app.use(express.urlencoded({ 
  extended: false,
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Constants optimized for WhatsApp + Meta Glasses
const CONFIG = {
  VOICE_TIMEOUT: 4500, // 4.5s timeout (under WhatsApp's 5s limit)
  GPT_MODEL: "gpt-4o-2024-05-13", // Specific model version
  MAX_TOKENS: 120, // Shorter responses for glasses
  WHISPER_MODEL: "whisper-1"
};

// Enhanced WhatsApp Webhook
app.post('/whatsapp', async (req, res) => {
  try {
    console.log("Incoming request from:", req.body.From);
    
    // Process message with fallback
    let textToProcess = req.body.Body || '';
    let isVoiceMessage = false;

    // Voice message processing with robust error handling
    if (req.body.MediaUrl0 && req.body.MediaContentType0 === 'audio/ogg') {
      isVoiceMessage = true;
      try {
        console.log("Processing voice message from:", req.body.MediaUrl0);
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CONFIG.VOICE_TIMEOUT);
        
        // Add Twilio auth headers
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

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('audio/ogg')) {
          throw new Error('Invalid audio content type');
        }

        // Create temporary file for the audio
        const tempFilePath = `/tmp/voice_${Date.now()}.ogg`;
        const fileStream = fs.createWriteStream(tempFilePath);
        await new Promise((resolve, reject) => {
          response.body.pipe(fileStream);
          response.body.on('error', reject);
          fileStream.on('finish', resolve);
        });

        // Create FormData and append the file
        const form = new FormData();
        form.append('file', fs.createReadStream(tempFilePath), {
          filename: 'voice_message.ogg',
          contentType: 'audio/ogg'
        });

        const transcription = await openai.audio.transcriptions.create({
          file: form,
          model: CONFIG.WHISPER_MODEL,
          response_format: "text",
          temperature: 0.2 // More accurate transcriptions
        });
        
        // Clean up temporary file
        fs.unlinkSync(tempFilePath);
        
        textToProcess = transcription.text;
        console.log("Transcription success:", textToProcess);
        
      } catch (error) {
        console.error("Voice processing error:", error);
        textToProcess = isVoiceMessage 
          ? "[Voice note processing failed. Please try again or type your message.]"
          : textToProcess;
      }
    }

    // AI response with optimized timeout
    const aiResponse = await Promise.race([
      openai.chat.completions.create({
        model: CONFIG.GPT_MODEL,
        messages: [{ 
          role: "user", 
          content: textToProcess || "[Empty message received]"
        }],
        max_tokens: CONFIG.MAX_TOKENS,
        temperature: 0.7
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('AI response timeout')), CONFIG.VOICE_TIMEOUT)
      )
    ]);

    // Format response for Meta Glasses
    const replyText = aiResponse.choices[0].message.content
      .replace(/\n/g, ' ') // Remove newlines for better glasses display
      .substring(0, 160); // Truncate to SMS limit

    await twilioClient.messages.create({
      body: replyText,
      from: req.body.To,
      to: req.body.From,
      shortenUrls: true // Optimize for glasses
    });

    res.status(200).end();
  } catch (error) {
    console.error('Endpoint error:', error);
    try {
      // Attempt to send error notification
      await twilioClient.messages.create({
        body: "Bot encountered an error. Please try again.",
        from: req.body.To,
        to: req.body.From
      });
    } catch (twilioError) {
      console.error("Failed to send error notification:", twilioError);
    }
    res.status(500).send('Server Error');
  }
});

// Enhanced health check
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    version: '1.0',
    capabilities: {
      whatsapp: true,
      voice_transcription: true,
      gpt_model: CONFIG.GPT_MODEL
    }
  });
});

// Start server with enhanced error handling
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

server.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});

process.on('SIGTERM', () => {
  server.close(() => {
    console.log('Server gracefully shutdown');
  });
});