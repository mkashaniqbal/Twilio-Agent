require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const { File } = require('form-data');
const fetch = require('node-fetch');
const app = express();

// Initialize APIs
const openai = new OpenAI(process.env.OPENAI_API_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ 
  extended: false,
  verify: (req, res, buf) => {
    req.rawBody = buf.toString(); // Needed for validation
  }
}));

// Meta Glasses Optimizations
const VOICE_TIMEOUT = 5000; // 5s timeout for voice processing
const GPT_MODEL = "gpt-4o";

// WhatsApp Webhook
app.post('/whatsapp', async (req, res) => {
  try {
    // 1. Temporary signature validation disable
    console.log("Incoming request from:", req.body.From);
    
    // 2. Process incoming message
    let textToProcess = req.body.Body || '';
    
    // 3. Voice message handling (Meta Glasses compatible)
    if (req.body.MediaUrl0 && req.body.MediaContentType0 === 'audio/ogg') {
      try {
        console.log("Processing voice message from:", req.body.MediaUrl0);
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), VOICE_TIMEOUT);
        
        const response = await fetch(req.body.MediaUrl0, { 
          signal: controller.signal 
        });
        
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        
        const audioBlob = await response.blob();
        console.log(`Audio received (${audioBlob.size} bytes)`);
        
        const transcription = await openai.audio.transcriptions.create({
          file: new File([audioBlob], "voice.ogg", { type: "audio/ogg" }),
          model: "whisper-1"
        });
        
        textToProcess = transcription.text;
        console.log("Transcription success:", textToProcess);
        
      } catch (error) {
        console.error("Voice processing error:", error);
        textToProcess = "[Couldn't process voice message. Please try again or type your message.]";
      }
    }

    // 4. Get AI response (optimized for glasses)
    const aiResponse = await Promise.race([
      openai.chat.completions.create({
        model: GPT_MODEL,
        messages: [{ role: "user", content: textToProcess }],
        max_tokens: 150 // Shorter responses for glasses
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('AI response timeout')), VOICE_TIMEOUT)
)]);

    // 5. Send reply
    await twilioClient.messages.create({
      body: aiResponse.choices[0].message.content,
      from: req.body.To,
      to: req.body.From
    });

    res.status(200).end();
  } catch (error) {
    console.error('Endpoint error:', error);
    res.status(500).send('Server Error');
  }
});

// Health check endpoint
app.get('/', (req, res) => res.send('WhatsApp AI Bot is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));