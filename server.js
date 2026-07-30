// 1. Crash Guards (Prevents background errors from crashing Express on Render)
process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRASH GUARD] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[CRASH GUARD] Uncaught Exception thrown:', err);
});

// 2. Safe dotenv initialization
try {
  require('dotenv').config();
} catch (e) {}

const express = require('express');
const multer = require('multer');
const puppeteer = require('puppeteer');
const { KnownDevices } = require('puppeteer');
const Steel = require('steel-sdk');

const app = express();

const upload = multer({ storage: multer.memoryStorage() });
const uploadMiddleware = upload.fields([
  { name: 'accountsFile', maxCount: 1 },
  { name: 'urlsFile', maxCount: 1 }
]);

const PORT = process.env.PORT || 3000;
const mobileDevice = KnownDevices['iPhone 13 Pro'];

const steel = new Steel({
  apiKey: process.env.STEEL_API_KEY,
});

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static('public'));

// --- GLOBAL QUEUE STATE ---
let isRunning = false;
let isStopping = false;
let sseClients = [];
let globalAccountIndex = 0; 
let mode2GeneratedAccounts = []; 

// --- HELPERS ---
function sendLog(message, type = 'normal', done = false) {
  console.log(`[LOG] ${message}`);
  const payload = JSON.stringify({ message, type, done });

  sseClients = sseClients.filter((client) => {
    try {
      client.res.write(`data: ${payload}\n\n`);
      return true;
    } catch (err) {
      return false;
    }
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomDelay = (min = 1000, max = 3000) => delay(Math.floor(Math.random() * (max - min + 1)) + min);

function generateRandomEmail() {
  const randStr = Math.random().toString(36).substring(2, 8);
  return `user_${Date.now()}_${randStr}@gmail.com`;
}

function generateRandomPassword() {
  return `Pass!${Math.random().toString(36).slice(-8)}`;
}

// Telecom generator for Auto Account Mode (Mix of 5-digit and 6-digit prefixes)
function generateAccountNumber() {
  const prefixes = [
    // 5-digit prefixes
    '80617', '80620', '80636', '80685', '80707', '80742', '80763', '80802',
    '80811', '80841', '80868', '81003', '81027', '81142', '81208', '90105',
    '90225', '90304', '90404', '90415',
    // 6-digit prefixes
    '806193', '806321', '806439', '806862', '807317', '807451', '807673', '808090',
    '808188', '808550', '808904', '810071', '810530', '811848', '812119', '901178',
    '902298', '903110', '904066', '904137'
  ];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];

  // Dynamically pad to ensure a 10-digit NUBAN
  const remainingLength = 10 - prefix.length;
  let suffix = '';
  for (let i = 0; i < remainingLength; i++) {
    suffix += Math.floor(Math.random() * 10).toString();
  }

  return prefix + suffix; 
}

function getNextAccount(accountMode, accountRows) {
  if (accountMode === 'auto') {
    return { accountNumber: generateAccountNumber(), bankName: 'OPay' }; 
  } else {
    if (globalAccountIndex >= accountRows.length) return null; 
    const row = accountRows[globalAccountIndex];
    globalAccountIndex++;
    return {
      accountNumber: row.accountNumber || row.account || Object.values(row)[0],
      bankName: row.bankName || 'OPay'
    };
  }
}

function parseCSVBuffer(buffer) {
  const content = buffer.toString('utf-8');
  const lines = content.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(',').map((v) => v.trim());
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });
    return row;
  });
}

function parseUrlsBuffer(buffer) {
  const content = buffer.toString('utf-8');
  return content.trim().split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('http'));
}


// ============================================================================
// ROUTES
// ============================================================================

app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(': keep-alive\n\n');

  const clientId = Date.now();
  sseClients.push({ id: clientId, res });

  req.on('close', () => {
    sseClients = sseClients.filter((client) => client.id !== clientId);
  });
});

setInterval(() => {
  sseClients.forEach((client) => {
    try { client.res.write(': keep-alive\n\n'); } catch (err) {}
  });
}, 10000);

app.get('/api/status', (req, res) => {
  res.json({ isRunning, isStopping });
});

app.post('/api/stop', (req, res) => {
  if (!isRunning) return res.json({ success: false, error: 'Automation is not running.' });
  isStopping = true;
  res.json({ success: true });
});

app.get('/api/download-accounts', (req, res) => {
  if (mode2GeneratedAccounts.length === 0) {
    return res.status(404).json({ success: false, error: 'No generated referral links found yet.' });
  }
  const csvContent = mode2GeneratedAccounts.join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=generated_referrals.csv');
  res.status(200).send(csvContent);
});


// ============================================================================
// START AUTOMATION
// ============================================================================

app.post('/api/start', uploadMiddleware, async (req, res) => {
  try {
    if (isRunning) return res.status(400).json({ success: false, error: 'Process is already running!' });

    const { accountMode, urlMode, targetUrl, urlCount } = req.body;

    let accountRows = [];
    let targetUrls = [];

    // 1. Validate Account Source
    if (accountMode === 'manual') {
      if (!req.files || !req.files['accountsFile']) {
        return res.status(400).json({ success: false, error: 'Accounts CSV required for Manual upload.' });
      }
      accountRows = parseCSVBuffer(req.files['accountsFile'][0].buffer);
      if (accountRows.length === 0) return res.status(400).json({ success: false, error: 'Accounts CSV is empty.' });
    }

    // 2. Validate URL Source
    if (urlMode === 'manual') {
      if (!req.files || !req.files['urlsFile']) {
        return res.status(400).json({ success: false, error: 'URLs CSV required for Manual upload.' });
      }
      targetUrls = parseUrlsBuffer(req.files['urlsFile'][0].buffer);
      if (targetUrls.length === 0) return res.status(400).json({ success: false, error: 'URLs CSV is empty.' });
    } else if (urlMode === 'autogen') {
      if (!targetUrl || !urlCount) {
        return res.status(400).json({ success: false, error: 'Missing Target URL or Count for Auto-gen mode.' });
      }
    }

    if (!process.env.STEEL_API_KEY) return res.status(500).json({ success: false, error: 'STEEL_API_KEY is missing' });

    res.json({ success: true, message: 'Automation Engine Starting...' });

    isRunning = true;
    isStopping = false;
    globalAccountIndex = 0;
    mode2GeneratedAccounts = [];

    // Run Hybrid Engine
    runHybridEngine({ 
      accountMode, 
      urlMode, 
      accountRows, 
      targetUrls, 
      targetUrl, 
      urlCount: Number(urlCount) 
    });

  } catch (err) {
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});


// ============================================================================
// CORE HYBRID ENGINE & WORKER LOGIC
// ============================================================================

async function runHybridEngine(config) {
  const { accountMode, urlMode, accountRows, targetUrls, targetUrl, urlCount } = config;
  const CONCURRENCY = 7;
  const SUCCESSES_NEEDED = 20;

  sendLog(`\n🚀 HYBRID ENGINE STARTED | URL Mode: ${urlMode.toUpperCase()} | Account Mode: ${accountMode.toUpperCase()}`, 'info');

  const runWorkerBatch = async (currentUrl, requiredSuccesses, logPrefix = '') => {
    let currentSuccesses = 0;

    const worker = async (workerId) => {
      while (currentSuccesses < requiredSuccesses && !isStopping) {
        const nextAccountData = getNextAccount(accountMode, accountRows);

        if (!nextAccountData) {
          sendLog(`⚠️ [Worker ${workerId}] Out of CSV accounts! Halting worker.`, 'warn');
          break; 
        }

        const success = await processAccount(nextAccountData, globalAccountIndex, `${logPrefix}W${workerId}`, currentUrl);

        if (success) {
          currentSuccesses++;
          sendLog(`✅ [Worker ${workerId}] SUCCESS (${currentSuccesses}/${requiredSuccesses}) on ${currentUrl}`, 'info');
        } else {
          sendLog(`❌ [Worker ${workerId}] Failed. Re-trying with new account...`, 'warn');
        }

        await randomDelay(1000, 2500);
      }
    };

    const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
    await Promise.all(workers);
    return currentSuccesses;
  };

  // PATH A: MANUAL URLS CSV
  if (urlMode === 'manual') {
    for (let i = 0; i < targetUrls.length; i++) {
      if (isStopping) break;
      sendLog(`\n🎯 STARTING MANUAL URL [${i + 1}/${targetUrls.length}]: ${targetUrls[i]}`);
      await runWorkerBatch(targetUrls[i], SUCCESSES_NEEDED, `[URL ${i + 1}] `);
    }
  } 
  // PATH B: AUTO-GEN URLS (Self-Feeding Seed & Fodder Farm)
  else if (urlMode === 'autogen') {
    const urlPrefix = 'rexifyuserzicone';
    const urlDomain = '@gmail.com';

    for (let cycle = 1; cycle <= urlCount; cycle++) {
      if (isStopping) break;
      sendLog(`\n🌱 [CYCLE ${cycle}/${urlCount}] CREATING SEED ACCOUNT ON MAIN TARGET...`);

      const seedAccountData = getNextAccount(accountMode, accountRows);
      if (!seedAccountData) {
        sendLog('⚠️ Out of CSV accounts for Seed! Halting Farm.', 'warn');
        break;
      }

      const seedHandle = `${urlPrefix}${cycle}`;
      const seedEmail = `${seedHandle}${urlDomain}`;
      const seedPassword = generateRandomPassword();

      // Create Seed Account on Main Target URL
      const isSeedSuccess = await processAccount(
        seedAccountData, 
        globalAccountIndex, 
        'SEED-MAKER', 
        targetUrl, 
        seedEmail, 
        seedPassword
      );

      if (isSeedSuccess) {
        const generatedRefUrl = `https://rexify.com.ng?reference=${seedHandle}`;
        mode2GeneratedAccounts.push(generatedRefUrl); 

        sendLog(`🎉 SEED CREATED! Target URL for next 20 accounts: ${generatedRefUrl}`, 'info');

        // Unleash the 20 Fodder accounts targeting this new referral link
        await runWorkerBatch(generatedRefUrl, SUCCESSES_NEEDED, `[FODDER-C${cycle}] `);
      } else {
        sendLog(`❌ SEED FAILED for ${seedEmail}. Skipping cycle...`, 'error');
      }
    }
  }

  if (isStopping) sendLog(`🛑 Process stopped manually.`, 'error', true);
  else sendLog(`✅ AUTOMATION ENGINE COMPLETE.`, 'info', true);

  isRunning = false;
  isStopping = false;
}

// Account Processing Worker (OPay Only - Max 1 Verification Attempt)
async function processAccount(accountData, rowIndex, workerId, targetUrl, customEmail = null, customPassword = null) {
  const accountNumber = accountData.accountNumber;
  const randomEmail = customEmail || generateRandomEmail();
  const randomPassword = customPassword || generateRandomPassword();

  sendLog(`[Worker ${workerId}] Processing Acc ${accountNumber} (${randomEmail})`, 'info');

  let session = null, browser = null;
  try {
    session = await steel.sessions.create({});
    browser = await puppeteer.connect({ browserWSEndpoint: `${session.websocketUrl}&apiKey=${process.env.STEEL_API_KEY}` });

    const openPages = await browser.pages();
    let page = openPages.length > 0 ? openPages[0] : await browser.newPage();
    await page.emulate(mobileDevice);
    page.setDefaultTimeout(25000);

    // STEP 1: Landing Page
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 35000 });
    await randomDelay(1000, 2000);
    const getStartedBtn = await page.waitForSelector('text/Get started', { visible: true, timeout: 15000 });
    await Promise.all([ getStartedBtn.click(), page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}) ]);

    const pages = await browser.pages();
    if (pages.length > 1) { page = pages[pages.length - 1]; await page.emulate(mobileDevice); page.setDefaultTimeout(25000); }
    await randomDelay(1500, 3000);

    // STEP 2: Registration
    const emailSelector = await page.waitForSelector('input[type="email"], input[placeholder*="email" i]', { visible: true, timeout: 15000 });
    await emailSelector.type(randomEmail, { delay: 50 });
    const passSelector = await page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 });
    await passSelector.type(randomPassword, { delay: 50 });

    const checkbox = await page.$('input[type="checkbox"]');
    if (checkbox) await checkbox.click();

    const continueBtn = await page.waitForSelector('text/Continue', { visible: true, timeout: 15000 });
    await Promise.all([ continueBtn.click(), page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}) ]);
    await randomDelay(3000, 5000);

    // STEP 3: Verification (OPay Only - Max 1 Attempt)
    let isVerified = false, verifyAttempt = 0;
    const MAX_VERIFY_ATTEMPTS = 1;
    const currentBank = 'OPay';

    while (!isVerified && verifyAttempt < MAX_VERIFY_ATTEMPTS) {
      if (isStopping) throw new Error('Process forcefully stopped.');
      verifyAttempt++;

      sendLog(`[Worker ${workerId}] Verification ${verifyAttempt}/${MAX_VERIFY_ATTEMPTS} using ${currentBank}...`);

      const accountInput = await page.waitForSelector('input[placeholder*="account number" i]', { visible: true, timeout: 15000 });
      await accountInput.click({ clickCount: 3 });
      await accountInput.press('Backspace');
      await randomDelay(300, 600);
      await accountInput.type(accountNumber, { delay: 50 });

      try {
        await page.select('select', currentBank);
      } catch (e) {
        await page.evaluate((bName) => {
          const select = document.querySelector('select');
          if (!select) return;
          for (let option of select.options) {
            if (option.text.toLowerCase().includes(bName.toLowerCase()) || option.value.toLowerCase().includes(bName.toLowerCase())) {
              select.value = option.value;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              break;
            }
          }
        }, currentBank);
      }

      const verifyBtn = await page.waitForSelector('text/Verify account', { visible: true, timeout: 15000 });
      await randomDelay(500, 1000);
      await verifyBtn.click();

      const startTime = Date.now();
      let status = 'pending';
      while (Date.now() - startTime < 12000) {
        const result = await page.evaluate(() => {
          const text = document.body.innerText || '';
          if (text.includes('Account name') || text.includes('Verified')) return 'success';
          if (text.includes('Not verified') || text.includes('Could not verify')) return 'failed';
          return 'pending';
        });
        if (result !== 'pending') { status = result; break; }
        await delay(1000);
      }

      if (status === 'success') {
        isVerified = true;
      } else {
        sendLog(`[Worker ${workerId}] Verification failed on attempt ${verifyAttempt}. Re-trying...`, 'warn');
        await randomDelay(1500, 3000);
      }
    }

    if (!isVerified) throw new Error(`Failed account verification after ${MAX_VERIFY_ATTEMPTS} attempts.`);

    const finishBtn = await page.waitForSelector('text/Finish & continue', { visible: true, timeout: 15000 });
    await randomDelay(800, 1500);
    await finishBtn.click();
    await delay(15000);

    return true;
  } catch (err) {
    sendLog(`[Worker ${workerId}] Error: ${err.message}`, 'error');
    return false;
  } finally {
    if (browser) await browser.disconnect().catch(() => {});
    if (session) await steel.sessions.release(session.id).catch(() => {});
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
