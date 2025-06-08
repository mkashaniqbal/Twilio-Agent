require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const fetch = require('node-fetch');
const { Blob } = require('buffer');
const app = express();

// Configure OpenAI with enhanced settings
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 30000, // 30 seconds timeout
  maxRetries: 3
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Middleware with proper configuration
app.use(express.json({ limit: '5mb' })); // Increased for voice messages
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Configuration constants
const CONFIG = {
  GPT_MODEL: "gpt-4o",
  WHISPER_MODEL: "whisper-1",
  MAX_TOKENS: 300,
  VOICE_TIMEOUT: 20000, // 20 seconds
  GPT_TIMEOUT: 15000, // 15 seconds
  MAX_MESSAGE_LENGTH: 1600 // WhatsApp character limit
};

// Helper function to process voice messages
async function processVoiceMessage(mediaUrl) {
  try {
    console.log("Fetching voice message from:", mediaUrl);
    
    const audioResponse = await fetch(mediaUrl, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(
          `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString('base64')
      },
      timeout: CONFIG.VOICE_TIMEOUT
    });

    if (!audioResponse.ok) {
      throw new Error(`Audio fetch failed with status: ${audioResponse.status}`);
    }

    const audioBuffer = await audioResponse.arrayBuffer();
    const audioBlob = new Blob([Buffer.from(audioBuffer)], { type: 'audio/ogg' });

    console.log("Transcribing audio with Whisper...");
    const transcription = await openai.audio.transcriptions.create({
      file: audioBlob,
      model: CONFIG.WHISPER_MODEL,
      response_format: "text"
    });

    return transcription.text;
  } catch (error) {
    console.error("Voice processing error:", error.message);
    throw error;
  }
}

// Enhanced WhatsApp endpoint
app.post('/whatsapp', async (req, res) => {
  try {
    console.log("Incoming message from:", req.body.From);
    
    let userMessage = req.body.Body || '';
    const isMedia = req.body.NumMedia > 0;

    // Handle voice messages
    if (isMedia && req.body.MediaContentType0?.startsWith('audio/')) {
      try {
        userMessage = await processVoiceMessage(req.body.MediaUrl0);
        console.log("Transcription successful:", userMessage.substring(0, 100) + (userMessage.length > 100 ? "..." : ""));
      } catch (error) {
        console.error("Voice message processing failed:", error);
        userMessage = "[Couldn't process voice message. Please try again or send text]";
      }
    }

    // Generate AI response
    let aiResponse;
    try {
      const completion = await openai.chat.completions.create({
        model: CONFIG.GPT_MODEL,
        messages: [{
          role: "system",
          content: "You're a helpful WhatsApp assistant. Keep responses concise and friendly."
        }, {
          role: "user",
          content: userMessage || "Hello"
        }],
        max_tokens: CONFIG.MAX_TOKENS,
        temperature: 0.7
      });

      aiResponse = completion.choices[0].message.content;
      console.log("Generated response:", aiResponse.substring(0, 50) + "...");
    } catch (error) {
      console.error("OpenAI API error:", error.message);
      aiResponse = "I'm experiencing technical difficulties. Please try again later.";
    }

    // Send Twilio response
    try {
      await twilioClient.messages.create({
        body: aiResponse.substring(0, CONFIG.MAX_MESSAGE_LENGTH),
        from: req.body.To,
        to: req.body.From
      });
      console.log("Response sent successfully");
    } catch (twilioError) {
      console.error("Twilio send error:", twilioError.message);
      throw twilioError;
    }

    res.status(200).end();
  } catch (error) {
    console.error("Endpoint error:", error);
    res.status(500).json({ 
      error: "Internal server error",
      details: error.message 
    });
  }
});

// Enhanced health check
app.get('/', (req, res) => {
  res.json({
    status: "operational",
    timestamp: new Date().toISOString(),
    services: {
      openai: "connected",
      twilio: "connected",
      whisper: "ready"
    },
    config: {
      model: CONFIG.GPT_MODEL,
      max_tokens: CONFIG.MAX_TOKENS
    }
  });
});

// Server startup
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Configuration:", JSON.stringify(CONFIG, null, 2));
});