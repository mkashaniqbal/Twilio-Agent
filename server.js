require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const FormData = require('form-data');
const fetch = require('node-fetch');
const { Readable } = require('stream');
const app = express();

// Initialize APIs
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 10000
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Middleware
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ 
  extended: false,
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Config
const CONFIG = {
  VOICE_TIMEOUT: 4500,
  GPT_MODEL: "gpt-4o-2024-05-13",
  MAX_TOKENS: 120,
  WHISPER_MODEL: "whisper-1"
};

// WhatsApp Webhook
app.post('/whatsapp', async (req, res) => {
  try {
    console.log("Incoming request from:", req.body.From);
    
    let textToProcess = req.body.Body || '';
    let isVoiceMessage = false;

    // Voice message processing
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

    // 2. Get audio as ArrayBuffer
    const audioArrayBuffer = await response.arrayBuffer();
    
    // 3. Create a Readable stream from the buffer
    const { Readable } = require('stream');
    const audioStream = Readable.from(Buffer.from(audioArrayBuffer));
    
    // 4. Create proper file object for OpenAI
    const audioFile = {
      name: 'voice_message.ogg',
      type: 'audio/ogg',
      stream: () => audioStream
    };

    // 5. Create transcription
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: CONFIG.WHISPER_MODEL,
      response_format: "text"
    });
    
    textToProcess = transcription.text;
    console.log("Transcription success:", textToProcess);
    
  } catch (error) {
    console.error("Voice processing error:", error);
    textToProcess = "[Voice note processing failed. Please try again or type your message.]";
  }
}
const contentLength = response.headers.get('content-length');
if (!contentLength || parseInt(contentLength) > 10 * 1024 * 1024) { // 10MB limit
  throw new Error('Audio file too large');
}
    // AI response
    const aiResponse = await openai.chat.completions.create({
      model: CONFIG.GPT_MODEL,
      messages: [{ 
        role: "user", 
        content: textToProcess || "[Empty message received]"
      }],
      max_tokens: CONFIG.MAX_TOKENS,
      temperature: 0.7
    });

    // Format response
    const replyText = aiResponse.choices[0].message.content
      .replace(/\n/g, ' ')
      .substring(0, 160);

    await twilioClient.messages.create({
      body: replyText,
      from: req.body.To,
      to: req.body.From,
      shortenUrls: true
    });

    res.status(200).end();
  } catch (error) {
    console.error('Endpoint error:', error);
    res.status(500).send('Server Error');
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'running' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));