require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const fetch = require('node-fetch');
const app = express();
const openai = new OpenAI(process.env.OPENAI_API_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
app.use(express.json());

app.use(express.urlencoded({ extended: false }));

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

    // 2. Process Incoming Message
    const userMessage = req.body.Body;
    const mediaUrl = req.body.MediaUrl0;

    let textToProcess = userMessage;

    // 3. Transcribe Voice Message (if any)
    if (mediaUrl && req.body.MediaContentType0 === 'audio/ogg') {
      const transcription = await openai.audio.transcriptions.create({
        file: await fetch(mediaUrl).then(res => res.blob()),
        model: "whisper-1"
      });
      textToProcess = transcription.text;
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