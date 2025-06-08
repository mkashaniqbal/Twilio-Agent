require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const fetch = require('node-fetch');
const app = express();

// Configure OpenAI with robust settings
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 25000, // 25 seconds
  maxRetries: 2
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Middleware with proper error handling
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Configuration
const CONFIG = {
  GPT_MODEL: "gpt-4o",
  WHISPER_MODEL: "whisper-1",
  MAX_TOKENS: 200,
  VOICE_TIMEOUT: 15000, // 15 seconds
  GPT_TIMEOUT: 10000 // 10 seconds
};

// Enhanced WhatsApp endpoint
app.post('/whatsapp', async (req, res) => {
  let responseSent = false;
  
  try {
    console.log("New message from:", req.body.From);
    
    // Process message content
    let userMessage = req.body.Body || '';
    const isMedia = req.body.NumMedia > 0;

    // Handle voice messages
    if (isMedia && req.body.MediaContentType0 === 'audio/ogg') {
      try {
        console.log("Processing voice message...");
        
        // Fetch audio with timeout
        const audioResponse = await fetch(req.body.MediaUrl0, {
          headers: {
            'Authorization': 'Basic ' + Buffer.from(
              `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
            ).toString('base64')
          },
          timeout: CONFIG.VOICE_TIMEOUT
        });

        if (!audioResponse.ok) {
          throw new Error(`Audio fetch failed: ${audioResponse.status}`);
        }

        // Process with Whisper
        const transcription = await openai.audio.transcriptions.create({
          file: await audioResponse.blob(),
          model: CONFIG.WHISPER_MODEL,
          response_format: "text"
        }, { timeout: CONFIG.VOICE_TIMEOUT });

        userMessage = transcription.text;
        console.log("Transcribed:", userMessage.substring(0, 50) + "...");
        
      } catch (error) {
        console.error("Voice processing failed:", error.message);
        userMessage = "[Voice message not understood. Please try again]";
      }
    }

    // Generate AI response
    let aiResponse = "Sorry, I couldn't generate a response.";
    try {
      const completion = await openai.chat.completions.create({
        model: CONFIG.GPT_MODEL,
        messages: [{
          role: "user",
          content: userMessage || "Hello"
        }],
        max_tokens: CONFIG.MAX_TOKENS,
        temperature: 0.7
      }, { timeout: CONFIG.GPT_TIMEOUT });

      aiResponse = completion.choices[0].message.content;
    } catch (error) {
      console.error("GPT error:", error.message);
      aiResponse = "I'm having trouble responding right now. Please try again later.";
    }

    // Send Twilio response
    try {
      await twilioClient.messages.create({
        body: aiResponse.substring(0, 1600), // WhatsApp limit
        from: req.body.To,
        to: req.body.From
      });
    } catch (twilioError) {
      console.error("Twilio send failed:", twilioError.message);
    }

    if (!responseSent) {
      res.status(200).end();
      responseSent = true;
    }

  } catch (error) {
    console.error("Endpoint crashed:", error);
    if (!responseSent) {
      res.status(500).json({ error: "Server error" });
      responseSent = true;
    }
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: "active",
    services: {
      openai: true,
      twilio: true
    }
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Configuration:", {
    model: CONFIG.GPT_MODEL,
    maxTokens: CONFIG.MAX_TOKENS
  });
});