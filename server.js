require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Readable } = require('stream');
const app = express();

if (typeof globalThis.File === 'undefined') {
  globalThis.File = require('node:buffer').File;
}


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

// Convert OGG to MP3 (you can improve this logic based on your needs)
async function convertOggToMp3(oggBuffer) {
  // Placeholder conversion logic. Replace with actual conversion.
  return oggBuffer; // Simply returning the buffer for now.
}

// Robust voice processor using buffers
async function processVoiceMessage(mediaUrl) {
  try {
    console.log("📥 Fetching media from:", mediaUrl);

    const response = await fetch(mediaUrl, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(
          `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString('base64')
      }
    });

    if (!response.ok) {
      throw new Error(`Fetch failed with status ${response.status}`);
    }

    const oggBuffer = await response.buffer();
    console.log("✅ Downloaded voice file, size:", oggBuffer.length);

    const mp3Buffer = await convertOggToMp3(oggBuffer);
    console.log("🎧 Converted to MP3, size:", mp3Buffer.length);

    // Save MP3 to temp file
    const tempFileName = `voice-${randomUUID()}.mp3`;
    const tempFilePath = path.join(__dirname, tempFileName);
    fs.writeFileSync(tempFilePath, mp3Buffer);

    console.log("📝 Transcribing with OpenAI Whisper...");
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: CONFIG.WHISPER_MODEL,
      response_format: "text"
    });

    // Clean up temp file
    fs.unlinkSync(tempFilePath);

    console.log("📜 Transcription received:", transcription);
    return transcription.text || ''; // Ensure the transcription is retrieved
  } catch (err) {
    console.error("❌ Voice Processing Error:", err.message);
    return '';
  }
}

// WhatsApp endpoint
// WhatsApp endpoint
app.post('/whatsapp', async (req, res) => {
  try {
    const from = req.body.From;
    const to = req.body.To;
    const numMedia = parseInt(req.body.NumMedia, 10);
    const isAudio = req.body.MediaContentType0?.includes('audio');

    console.log("📲 Incoming message from:", from);

    let userMessage = req.body.Body?.trim() || "";
    let transcriptionUsed = false;

    // Handle voice messages
    if (numMedia > 0 && isAudio) {
      const mediaUrl = req.body.MediaUrl0;
      console.log("📥 Fetching media from:", mediaUrl);

      try {
        userMessage = await processVoiceMessage(mediaUrl);
        transcriptionUsed = true;
        console.log("📝 Transcription received:", userMessage);
      } catch (err) {
        console.error("❌ Failed to process voice message:", err);
        userMessage = "Sorry, I couldn't understand your voice message.";
      }
    }

    // If still no user message, send fallback
    if (!userMessage) {
      console.warn("⚠️ Empty message. Sending fallback.");
      userMessage = "I'm having trouble understanding your message. Please try again.";
    }

    // Generate AI response
    let aiResponse = "";

    try {
      const completion = await openai.chat.completions.create({
        model: CONFIG.GPT_MODEL,
        messages: [
          { role: "system", content: "You're a helpful WhatsApp assistant. Respond concisely." },
          { role: "user", content: userMessage }
        ],
        max_tokens: CONFIG.MAX_TOKENS,
        temperature: 0.7
      });

      aiResponse = completion.choices[0].message.content.trim();
      console.log("💬 AI Response:", aiResponse);
    } catch (err) {
      console.error("❌ OpenAI error:", err);
      aiResponse = "Sorry, I'm having trouble generating a response right now.";
    }

    // Trim response if needed
    if (aiResponse.length > CONFIG.MAX_MESSAGE_LENGTH) {
      aiResponse = aiResponse.slice(0, CONFIG.MAX_MESSAGE_LENGTH);
    }

    // Send message via Twilio
    try {
      const sentMessage = await twilioClient.messages.create({
        body: aiResponse,
        from: to, // Twilio number like whatsapp:+14155238886
        to: from  // User number like whatsapp:+923317430602
      });

      console.log("✅ Reply sent:", sentMessage.sid);
    } catch (err) {
      console.error("❌ Failed to send WhatsApp reply:", err);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Unhandled error in /whatsapp:", error);
    res.sendStatus(500);
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

console.log("Running Node version:", process.version);
