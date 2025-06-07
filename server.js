require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const fetch = require('node-fetch');
const app = express();
const openai = new OpenAI(process.env.OPENAI_API_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
app.use(express.json());

app.use(express.urlencoded({ 
  extended: false,
  verify: (req, res, buf) => {
    req.rawBody = buf.toString(); // Needed for validation
  }
}));
// WhatsApp Webhook
app.post('/whatsapp', async (req, res) => {
  try {
    // 1. Verify Twilio Signature (SECURITY)
    const twilioSignature = req.headers['x-twilio-signature'];
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const params = req.body;
    
    // if (!twilio.validateRequest(
    //   process.env.TWILIO_AUTH_TOKEN,
    //   twilioSignature,
    //   url,
    //   params
    // )) {
    //   return res.status(403).send('Forbidden');
    // }
console.log("Validation check:", {
  token: process.env.TWILIO_AUTH_TOKEN?.slice(0, 5) + '...',
  signature: twilioSignature,
  url: url,
  computedUrl: `${req.protocol}://${req.get('host')}${req.originalUrl}`
});
    // 2. Process Incoming Message
    const userMessage = req.body.Body;
    const mediaUrl = req.body.MediaUrl0;

    let textToProcess = userMessage;

    // 3. Transcribe Voice Message (if any)
    if (mediaUrl && req.body.MediaContentType0 === 'audio/ogg') {
  try {
    console.log("Fetching audio from:", mediaUrl); // Debug log
    
    const response = await fetch(mediaUrl);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    
    const audioBlob = await response.blob();
    console.log("Audio blob size:", audioBlob.size); // Debug log

    const transcription = await openai.audio.transcriptions.create({
      file: new File([audioBlob], "voice-message.ogg", { type: "audio/ogg" }),
      model: "whisper-1"
    });
    
    textToProcess = transcription.text;
    console.log("Transcription:", transcription.text); // Debug log
    
  } catch (error) {
    console.error("Voice processing failed:", error);
    textToProcess = "[Voice message processing failed]";
  }
}

    // 4. Get AI Response
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: textToProcess }]
    });

    // 5. Send Reply via Twilio
    await twilioClient.messages.create({
      body: aiResponse.choices[0].message.content,
      from: req.body.To,
      to: req.body.From
    });

    res.status(200).end();
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Server Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));