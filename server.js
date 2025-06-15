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

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

const users = [];

app.post('/register', (req, res) => {
  const { url, name, email, phone, countryCode, interval } = req.body;
  const cronMap = {
    '10sec': '*/10 * * * * *',
    '30sec': '*/30 * * * * *',
    '1min': '0 * * * * *',
    '5min': '*/5 * * * *'
  };
  const schedule = cronMap[interval];

  if (!schedule) return res.status(400).send('Invalid interval.');

  const task = cron.schedule(schedule, async () => {
    try {
      await axios.get(url);
    } catch {
      transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: `🚨 ${url} is DOWN`,
        text: `${url} seems to be down as of ${new Date().toLocaleTimeString()}`
      });

      if (phone && countryCode) {
        twilioClient.messages.create({
          body: `${url} is DOWN!`,
          from: process.env.TWILIO_PHONE,
          to: countryCode + phone
        }).catch(console.error);
      }
    }
  });

  users.push({ url, name, email, phone, countryCode, interval, task });
  res.send('Registered successfully!');
});

app.listen(process.env.PORT || 5000, () => {
  console.log(`🚀 Server running on port ${process.env.PORT}`);
});
