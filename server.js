require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error", err));

// Schema
const logSchema = new mongoose.Schema({
  start: Date,
  end: Date,
  durationMinutes: Number
});

const monitorSchema = new mongoose.Schema({
  url: String,
  name: String,
  email: String,
  phone: String,
  countryCode: String,
  interval: String,
  logs: [logSchema]
});

const Monitor = mongoose.model('Monitor', monitorSchema);

// Notification setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

// Monitor state
const activeTasks = {};
const downtimeTracker = {};

function getCronExpression(interval) {
  return {
    '10sec': '*/10 * * * * *',
    '30sec': '*/30 * * * * *',
    '1min': '0 * * * * *',
    '5min': '*/5 * * * *'
  }[interval];
}

// Register endpoint
app.post('/register', async (req, res) => {
  const { url, name, email, phone, countryCode, interval } = req.body;
  const cronExpr = getCronExpression(interval);
  if (!cronExpr) return res.status(400).send('Invalid interval.');

  const monitor = await Monitor.create({ url, name, email, phone, countryCode, interval, logs: [] });
  downtimeTracker[monitor._id] = null;

  activeTasks[monitor._id] = cron.schedule(cronExpr, async () => {
    const now = new Date();

    try {
      await axios.get(url, { timeout: 5000 });
      console.log(`[UP] ${url} at ${now.toISOString()}`);

      if (downtimeTracker[monitor._id]) {
        const start = downtimeTracker[monitor._id];
        const end = now;
        const duration = Math.round((end - start) / 60000);

        await Monitor.findByIdAndUpdate(monitor._id, {
          $push: { logs: { start, end, durationMinutes: duration } }
        });

        downtimeTracker[monitor._id] = null;
      }

    } catch (err) {
      console.log(`[DOWN] ${url} at ${now.toISOString()}`);

      await Monitor.findByIdAndUpdate(monitor._id, {
        $push: {
          logs: {
            start: now,
            end: now,
            durationMinutes: 0
          }
        }
      });

      if (!downtimeTracker[monitor._id]) {
        downtimeTracker[monitor._id] = now;
      }

      transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: `🚨 ${url} is DOWN`,
        text: `${url} is down as of ${now.toLocaleTimeString()}`
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

// Stop all monitors
app.post('/stop-monitoring', async (req, res) => {
  Object.values(activeTasks).forEach(task => task.stop());
  Object.keys(activeTasks).forEach(id => delete activeTasks[id]);
  Object.keys(downtimeTracker).forEach(id => delete downtimeTracker[id]);
  res.send('Monitoring stopped.');
});

// Overview logs
app.get('/logs', async (req, res) => {
  const monitors = await Monitor.find();
  const html = `
    <html>
      <head>
        <style>
          body { font-family: sans-serif; padding: 20px; }
          ul { list-style-type: none; padding: 0; }
          li { margin-bottom: 15px; }
          button {
            margin-left: 10px;
            background-color: red;
            color: white;
            border: none;
            padding: 4px 8px;
            cursor: pointer;
            border-radius: 4px;
          }
        </style>
      </head>
      <body>
        <h2>📄 Registered URLs</h2>
        <ul>
          ${monitors.map(m => `
            <li>
              <a href="/logs/${m._id}" target="_blank">${m.url}</a><br />
              <small style="color: gray;">📧 ${m.email}</small>
              <button onclick="deleteMonitor('${m._id}')">❌ Delete</button>
            </li>`).join('')}
        </ul>
        <script>
          function deleteMonitor(id) {
            if (confirm('Are you sure you want to delete this monitor and its logs?')) {
              fetch('/delete/' + id, { method: 'DELETE' })
                .then(res => res.text())
                .then(alert)
                .then(() => location.reload())
                .catch(err => alert('Failed to delete.'));
            }
          }
        </script>
      </body>
    </html>`;
  res.send(html);
});

// Detailed log per monitor
app.get('/logs/:id', async (req, res) => {
  const monitor = await Monitor.findById(req.params.id);
  if (!monitor) return res.send(`<h3>No logs found</h3>`);

  const content = monitor.logs.map((log, index) => {
    const start = new Date(log.start);
    const end = new Date(log.end);
    const durationMs = end - start;

    const minutes = Math.floor(durationMs / 60000);
    const seconds = Math.floor((durationMs % 60000) / 1000);

    const durationStr = minutes > 0
      ? `for ${minutes} minute(s) and ${seconds} second(s)`
      : `for ${seconds} second(s)`;

    const dateStr = start.toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric'
    });

    const fromStr = start.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', second: '2-digit'
    }).toLowerCase();

    const toStr = end.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', second: '2-digit'
    }).toLowerCase();

    return `
      <div style="margin-bottom: 1.5rem; white-space: pre-wrap;">
        <strong>${index + 1}.</strong>  
        Date: ${dateStr}  
        For how long: ${durationStr}  
        From when to when: from ${fromStr} till ${toStr}
      </div>`;
  }).join('');

  res.send(`
    <html>
      <head>
        <style>
          body {
            font-family: monospace;
            background-color: #eef6fc;
            padding: 20px;
          }
        </style>
      </head>
      <body>
        <h2>📄 Downtime Logs for ${monitor.url}</h2>
        <p><strong>Email:</strong> ${monitor.email}</p>
        ${content || '<p>No downtime logs yet.</p>'}
      </body>
    </html>`);
});

// Delete monitor
app.delete('/delete/:id', async (req, res) => {
  const id = req.params.id;

  if (activeTasks[id]) {
    activeTasks[id].stop();
    delete activeTasks[id];
  }

  delete downtimeTracker[id];
  await Monitor.findByIdAndDelete(id);
  res.send('✅ Monitor deleted successfully');
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
