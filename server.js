require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const fetch = require('node-fetch');
const fs = require('fs');
const { Readable } = require('stream');
const app = express();

// Configure OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 30000,
  maxRetries: 3
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Middleware
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

const CONFIG = {
  GPT_MODEL: "gpt-4o",
  WHISPER_MODEL: "whisper-1",
  MAX_TOKENS: 300,
  VOICE_TIMEOUT: 20000,
  GPT_TIMEOUT: 15000,
  MAX_MESSAGE_LENGTH: 1600
};

// Robust voice processor using buffers
async function processVoiceMessage(mediaUrl) {
  try {
    console.log("Fetching voice message from:", mediaUrl);
    
    const audioResponse = await fetch(mediaUrl, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(
          `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString('base64')
      }
    });

    if (!audioResponse.ok) {
      throw new Error(`Audio fetch failed: ${audioResponse.status}`);
    }

    // Get audio as buffer
    const audioBuffer = await audioResponse.buffer();
    
    // Create a readable stream from buffer
    const audioStream = Readable.from(audioBuffer);
    
    console.log("Transcribing audio...");
    const transcription = await openai.audio.transcriptions.create({
      file: audioStream,
      model: CONFIG.WHISPER_MODEL,
      response_format: "text"
    });

    return transcription.text;
  } catch (error) {
    console.error("Voice processing error:", error);
    throw error;
  }
}

// WhatsApp endpoint (unchanged from working version)
app.post('/whatsapp', async (req, res) => {
  try {
    console.log("Incoming message from:", req.body.From);
    
    let userMessage = req.body.Body || '';
    const isMedia = req.body.NumMedia > 0;

    if (isMedia && req.body.MediaContentType0?.startsWith('audio/')) {
      try {
        userMessage = await processVoiceMessage(req.body.MediaUrl0);
        console.log("Transcription:", userMessage.substring(0, 100) + (userMessage.length > 100 ? "..." : ""));
      } catch (error) {
        console.error("Voice processing failed:", error);
        userMessage = "[Voice message not understood. Please try again]";
      }
    }

    let aiResponse = "I'm having trouble responding. Please try again later.";
    if (userMessage) {
      try {
        const completion = await openai.chat.completions.create({
          model: CONFIG.GPT_MODEL,
          messages: [
            {
              role: "system",
              content: "You're a helpful WhatsApp assistant. Respond concisely."
            },
            {
              role: "user",
              content: userMessage
            }
          ],
          max_tokens: CONFIG.MAX_TOKENS,
          temperature: 0.7
        });
        aiResponse = completion.choices[0].message.content;
      } catch (error) {
        console.error("OpenAI error:", error);
      }
    }

    try {
      await twilioClient.messages.create({
        body: aiResponse.substring(0, CONFIG.MAX_MESSAGE_LENGTH),
        from: req.body.To,
        to: req.body.From
      });
      console.log("Reply sent");
    } catch (error) {
      console.error("Twilio error:", error);
    }

    res.status(200).end();
  } catch (error) {
    console.error("Server error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: "running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server ready on port ${PORT}`);
});