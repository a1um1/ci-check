const fs = require('fs');
const path = require('path');

const TARGET_URL = 'https://m3ow.xyz';
const TIMEOUT_MS = 10000;
const DATA_DIR = path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'status.json');
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Default status structure
const defaultData = {
  status: 'unknown',
  lastCheck: '',
  latency: 0,
  uptime24h: 100,
  uptime7d: 100,
  uptime30d: 100,
  history: [],
  incidents: []
};

// Helper to load data
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const content = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(content);
    } catch (e) {
      console.error('Failed to parse status.json, resetting database:', e);
    }
  }
  return JSON.parse(JSON.stringify(defaultData));
}

// Helper to save data
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Calculate uptime percentage for a given timeframe (in hours)
function calculateUptime(history, hours) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const filtered = history.filter(h => new Date(h.timestamp).getTime() >= cutoff);
  if (filtered.length === 0) return 100;
  
  const upCount = filtered.filter(h => h.status === 'up').length;
  return parseFloat(((upCount / filtered.length) * 100).toFixed(2));
}

// Send discord webhook alert
async function sendDiscordAlert(previousStatus, currentStatus, durationMs = null) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log('DISCORD_WEBHOOK_URL is not set. Skipping discord notification.');
    return;
  }

  const timestamp = new Date().toISOString();
  let color = 15158332; // Red for Down
  let title = '🔴 Website Down Alert';
  let description = `**${TARGET_URL}** is currently unreachable.`;

  if (currentStatus === 'up') {
    color = 3066993; // Green for Up
    title = '🟢 Website Restored';
    description = `**${TARGET_URL}** is back online.`;
    if (durationMs) {
      const minutes = Math.round(durationMs / 60000);
      description += `\n**Downtime Duration:** ${minutes} minute(s)`;
    }
  }

  const payload = {
    embeds: [
      {
        title: title,
        description: description,
        color: color,
        timestamp: timestamp,
        footer: {
          text: 'CI Status Checker'
        }
      }
    ]
  };

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.error(`Discord webhook failed with status: ${res.status}`);
    } else {
      console.log('Discord webhook notification sent.');
    }
  } catch (e) {
    console.error('Error sending Discord webhook:', e);
  }
}

async function runCheck() {
  const data = loadData();
  const previousStatus = data.status;
  const startTime = Date.now();
  let currentStatus = 'down';
  let latency = 0;

  console.log(`Checking ${TARGET_URL}...`);
  try {
    // Implement fetch with timeout
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(TARGET_URL, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'CI-Status-Checker/1.0 (GitHub Action Uptime Bot)'
      }
    });
    clearTimeout(id);

    latency = Date.now() - startTime;

    if (response.status >= 200 && response.status < 400) {
      currentStatus = 'up';
      console.log(`Site is UP. Latency: ${latency}ms, Status: ${response.status}`);
    } else {
      console.log(`Site is DOWN. Latency: ${latency}ms, Status: ${response.status}`);
    }
  } catch (err) {
    latency = Date.now() - startTime;
    console.log(`Site is DOWN. Error: ${err.message}. Latency: ${latency}ms`);
  }

  const timestamp = new Date().toISOString();
  
  // Record status & update history
  data.status = currentStatus;
  data.lastCheck = timestamp;
  data.latency = latency;
  
  data.history.push({
    timestamp,
    status: currentStatus,
    latency
  });

  // Prune history to keep only 30 days (30 days * 24 hrs * 12 checks/hr = 8,640 records)
  const maxRecords = 30 * 24 * 12;
  if (data.history.length > maxRecords) {
    data.history = data.history.slice(data.history.length - maxRecords);
  }

  // Handle Incidents & Alerts
  if (previousStatus !== 'unknown' && previousStatus !== currentStatus) {
    console.log(`Status changed from ${previousStatus} to ${currentStatus}!`);
    
    let durationMs = null;
    
    if (currentStatus === 'down') {
      // Create new incident
      data.incidents.unshift({
        downAt: timestamp,
        recoveredAt: null,
        durationMinutes: null
      });
    } else if (currentStatus === 'up') {
      // Resolve active incident
      const activeIncident = data.incidents.find(i => i.recoveredAt === null);
      if (activeIncident) {
        activeIncident.recoveredAt = timestamp;
        durationMs = Date.now() - new Date(activeIncident.downAt).getTime();
        activeIncident.durationMinutes = Math.round(durationMs / 60000);
      }
    }

    // Keep incidents list short (last 20 incidents)
    if (data.incidents.length > 20) {
      data.incidents = data.incidents.slice(0, 20);
    }

    // Send alert to Discord
    await sendDiscordAlert(previousStatus, currentStatus, durationMs);
  }

  // Calculate statistics
  data.uptime24h = calculateUptime(data.history, 24);
  data.uptime7d = calculateUptime(data.history, 7 * 24);
  data.uptime30d = calculateUptime(data.history, 30 * 24);

  // Save the result
  saveData(data);
  console.log('Status database updated successfully.');
}

runCheck();
