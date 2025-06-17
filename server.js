require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

let currentTask = null;
const logs = [];

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

app.post('/register', (req, res) => {
  const { url, email, phone, countryCode, interval } = req.body;

  const cronMap = {
    '10sec': '*/10 * * * * *',
    '30sec': '*/30 * * * * *',
    '1min': '0 * * * * *',
    '5min': '*/5 * * * *'
  };

  if (!cronMap[interval]) {
    return res.status(400).send('Invalid interval selected.');
  }

  if (currentTask) currentTask.stop();

  const schedule = cronMap[interval];
  currentTask = cron.schedule(schedule, async () => {
    try {
      await axios.get(url);
      logs.push(`${new Date().toISOString()} - UP`);
    } catch (err) {
      logs.push(`${new Date().toISOString()} - DOWN`);
      transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: `🚨 ${url} is DOWN`,
        text: `${url} is down as of ${new Date().toLocaleTimeString()}`
      }).catch(console.error);

      if (phone && countryCode) {
        twilioClient.messages.create({
          body: `${url} is DOWN!`,
          from: process.env.TWILIO_PHONE,
          to: `${countryCode}${phone}`
        }).catch(console.error);
      }
    }
  });

  res.send('Monitoring started successfully!');
});

app.post('/stop-monitoring', (req, res) => {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
    logs.push(`${new Date().toISOString()} - Monitoring Stopped`);
  }
  res.send('Monitoring stopped.');
});

app.get('/logs', (req, res) => {
  res.type('text/plain').send(logs.join('\n'));
});

// ✅ Use the correct PORT on Render
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
