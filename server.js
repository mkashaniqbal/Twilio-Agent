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
    console.log("📲 Incoming message from:", req.body.From);

    let userMessage = req.body.Body || '';
    const isMedia = req.body.NumMedia > 0;

    if (isMedia && req.body.MediaContentType0?.startsWith('audio/')) {
      try {
        userMessage = await processVoiceMessage(req.body.MediaUrl0);
        console.log("📜 Transcription:", userMessage.substring(0, 100) + (userMessage.length > 100 ? "..." : ""));
      } catch (error) {
        console.error("❌ Voice processing failed:", error);
        userMessage = "[Voice message not understood. Please try again]";
      }
    }

    // Check if there's an actual transcription or fallback to default message
    let aiResponse = userMessage || "I'm having trouble responding. Please try again later.";

    if (userMessage && userMessage !== "[Voice message not understood. Please try again]") {
      // Proceed to OpenAI API if transcription is valid
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

        // Ensure we have a valid AI response
        aiResponse = completion.choices[0].message.content || aiResponse;
        console.log("✅ OpenAI AI Response:", aiResponse);
      } catch (error) {
        console.error("❌ OpenAI error:", error);
      }
    }

    // Ensure aiResponse doesn't exceed max message length
    aiResponse = aiResponse.substring(0, CONFIG.MAX_MESSAGE_LENGTH);

    // Log the response that will be sent to Twilio
    console.log("Transcription to send to Twilio:", aiResponse);

    // Send back the response to WhatsApp via Twilio
    try {
      await twilioClient.messages.create({
        body: aiResponse, // Use the correct transcription (or AI response)
        from: req.body.To,
        to: req.body.From
      });
      console.log("✅ Reply sent");
    } catch (error) {
      console.error("❌ Twilio error:", error);
    }

    res.status(200).end();
  } catch (error) {
    console.error("❌ Server error:", error);
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

console.log("Running Node version:", process.version);
