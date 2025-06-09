require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const fetch = require('node-fetch');
const fs = require('fs');
const { Readable } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);

if (typeof globalThis.File === 'undefined') {
  globalThis.File = require('node:buffer').File;
}

const app = express();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

const CONFIG = {
  GPT_MODEL: "gpt-4o",
  WHISPER_MODEL: "whisper-1",
  MAX_TOKENS: 300,
  MAX_MESSAGE_LENGTH: 1600
};

// 🧠 OGG to MP3 converter using FFMPEG
async function convertOggToMp3(oggBuffer) {
  return new Promise((resolve, reject) => {
    const inputStream = Readable.from(oggBuffer);
    const outputChunks = [];

    ffmpeg(inputStream)
      .inputFormat('ogg')
      .audioCodec('libmp3lame')
      .format('mp3')
      .on('error', reject)
      .on('end', () => {
        resolve(Buffer.concat(outputChunks));
      })
      .pipe()
      .on('data', chunk => outputChunks.push(chunk));
  });
}

// 🎙️ Process WhatsApp voice message
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

    const file = new File([mp3Buffer], 'voice.mp3', { type: 'audio/mpeg' });

    console.log("📝 Transcribing with OpenAI Whisper...");
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: CONFIG.WHISPER_MODEL,
      response_format: "text"
    });

    console.log("📜 Transcription received:", transcription.text);
    return transcription.text || '';
  } catch (err) {
    console.error("❌ Voice Processing Error:", err.message);
    throw err;
  }
}

// 🚀 WhatsApp Webhook
app.post('/whatsapp', async (req, res) => {
  try {
    const from = req.body.From;
    const to = req.body.To;
    const isMedia = req.body.NumMedia > 0;
    const contentType = req.body.MediaContentType0?.toLowerCase() || '';
    let userMessage = req.body.Body || '';

    console.log("📲 Incoming message from:", from);

    if (isMedia && (contentType.includes('audio') || contentType.includes('ogg'))) {
      try {
        userMessage = await processVoiceMessage(req.body.MediaUrl0);
        if (!userMessage.trim()) {
          userMessage = "[Voice message not understood. Please try again]";
        }
      } catch {
        userMessage = "[Voice message not understood. Please try again]";
      }
    }

    let aiResponse = "I'm having trouble responding. Please try again later.";

    if (userMessage && !userMessage.startsWith("[")) {
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
        console.error("❌ GPT Error:", error.message);
      }
    } else {
      aiResponse = userMessage; // fallback message already set
    }

    // ✉️ Send response via Twilio
    await twilioClient.messages.create({
      body: aiResponse.substring(0, CONFIG.MAX_MESSAGE_LENGTH),
      from: to,
      to: from
    });

    console.log("✅ Reply sent");
    res.status(200).end();
  } catch (error) {
    console.error("💥 Server error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Health check
app.get('/', (req, res) => {
  res.json({ status: "running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
