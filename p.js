import blessed from "blessed";
import chalk from "chalk";
import { ethers } from "ethers";
import fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import axios from "axios";

const RPC_URL = "https://rpc1.testnet.incentiv.io";
const CHAIN_ID = 28802;
const CONFIG_FILE = "config.json";
const TOKEN_FILE = "token.json";
const TWO_CAPTCHA_FILE = "api.json";
const TURNSTILE_SITEKEY = "0x4AAAAAABl4Ht6hzgSZ-Na3";
const PAGE_URL = "https://testnet.incentiv.io/";

let accounts = [];
let proxies = [];
let transactionLogs = [];
let isFaucetRunning = false;
let shouldStopFaucet = false;
let faucetInterval;
let isFaucetLoopRunning = false;

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
];

const API_HEADERS = {
  'accept': '*/*',
  'accept-encoding': 'gzip, deflate, br, zstd',
  'connection': 'keep-alive',
  'origin': 'https://testnet.incentiv.io',
  'referer': 'https://testnet.incentiv.io/',
};

// Helper function untuk kompatibilitas ethers v5 dan v6
function getEthersAddress(address) {
  // Untuk ethers v6
  if (ethers.getAddress) {
    return ethers.getAddress(address);
  }
  // Untuk ethers v5
  else if (ethers.utils && ethers.utils.getAddress) {
    return ethers.utils.getAddress(address);
  }
  throw new Error('Cannot find getAddress function in ethers');
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (error) {
    addLog(`Failed to load config: ${error.message}`, "error");
  }
  return {};
}

async function saveToken(eoaAddress, smartAddress, token) {
  try {
    let tokens = {};
    if (fs.existsSync(TOKEN_FILE)) {
      const data = fs.readFileSync(TOKEN_FILE, "utf8");
      tokens = JSON.parse(data);
    }
    tokens[eoaAddress.toLowerCase()] = { smartAddress, token };
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
    addLog(`Token Saved For Wallet: ${getShortAddress(eoaAddress)}`, "success");
  } catch (error) {
    addLog(`Failed to save token: ${error.message}`, "error");
  }
}

async function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = fs.readFileSync(TOKEN_FILE, "utf8");
      const tokens = JSON.parse(data);
      accounts.forEach(account => {
        const wallet = new ethers.Wallet(account.privateKey);
        const eoaAddress = wallet.address;
        if (tokens[eoaAddress.toLowerCase()]) {
          account.smartAddress = getEthersAddress(tokens[eoaAddress.toLowerCase()].smartAddress);
          account.token = tokens[eoaAddress.toLowerCase()].token;
          addLog(`Loaded Token for account: ${getShortAddress(eoaAddress)}`, "info");
        }
      });
    }
  } catch (error) {
    addLog(`Failed to load tokens: ${error.message}`, "error");
  }
}

function addLog(message, type = "info") {
  const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  let coloredMessage;
  switch (type) {
    case "error":
      coloredMessage = chalk.redBright(message);
      break;
    case "success":
      coloredMessage = chalk.greenBright(message);
      break;
    case "warn":
      coloredMessage = chalk.magentaBright(message);
      break;
    case "wait":
      coloredMessage = chalk.yellowBright(message);
      break;
    case "info":
      coloredMessage = chalk.whiteBright(message);
      break;
    case "delay":
      coloredMessage = chalk.cyanBright(message);
      break;
    default:
      coloredMessage = chalk.white(message);
  }
  const logMessage = `[${timestamp}] ${coloredMessage}`;
  transactionLogs.push(logMessage);
  if (transactionLogs.length > 50) transactionLogs.shift();
  console.log(logMessage);
}

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function loadAccounts() {
  try {
    const data = fs.readFileSync("pk.txt", "utf8");
    accounts = data.split("\n").map(line => line.trim()).filter(line => line).map(privateKey => ({
      privateKey,
      smartAddress: null,
      token: null,
      nextFaucetTime: 0,
      isClaiming: false
    }));
    if (accounts.length === 0) throw new Error("No private keys found in pk.txt");
    addLog(`Loaded ${accounts.length} accounts from pk.txt`, "success");
    loadTokens();
  } catch (error) {
    addLog(`Failed to load accounts: ${error.message}`, "error");
    accounts = [];
  }
}

function loadProxies() {
  try {
    if (fs.existsSync("proxy.txt")) {
      const data = fs.readFileSync("proxy.txt", "utf8");
      proxies = data.split("\n").map(proxy => proxy.trim()).filter(proxy => proxy);
      if (proxies.length === 0) throw new Error("No proxy found in proxy.txt");
      addLog(`Loaded ${proxies.length} proxies from proxy.txt`, "success");
    } else {
      addLog("No proxy.txt found, running without proxy.", "info");
    }
  } catch (error) {
    addLog(`Failed to load proxy: ${error.message}`, "info");
    proxies = [];
  }
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) {
    return new SocksProxyAgent(proxyUrl);
  } else {
    return new HttpsProxyAgent(proxyUrl);
  }
}

async function getIP(proxyUrl) {
  try {
    const agent = createAgent(proxyUrl);
    const response = await axios.get('https://api.ipify.org?format=json', {
      httpsAgent: agent,
      headers: { 'User-Agent': userAgents[0] },
      timeout: 5000
    });
    return response.data.ip;
  } catch (error) {
    addLog(`Failed to fetch IP: ${error.message}`, "warn");
    return "Unknown";
  }
}

async function makeApiCall(url, method, data, proxyUrl, token = null) {
  try {
    let headers = {
      ...API_HEADERS,
      'user-agent': userAgents[Math.floor(Math.random() * userAgents.length)]
    };
    if (method === 'POST' && data) headers['content-type'] = 'application/json';
    if (token) headers['token'] = token;

    const agent = createAgent(proxyUrl);
    const response = await axios({
      method,
      url,
      data,
      headers,
      httpsAgent: agent,
      timeout: 30000
    });
    return response.data;
  } catch (error) {
    if (error.response) {
      addLog(`API call failed (${url}): ${error.response.status} - ${JSON.stringify(error.response.data)}`, "error");
    } else {
      addLog(`API call failed (${url}): ${error.message}`, "error");
    }
    throw error;
  }
}

async function testToken(account, proxyUrl) {
  try {
    await makeApiCall('https://api.testnet.incentiv.io/api/user', 'GET', null, proxyUrl, account.token);
    return true;
  } catch (error) {
    if (error.response && error.response.status === 401) {
      addLog(`Token invalid/expired for account: ${getShortAddress(account.smartAddress)}`, "warn");
      return false;
    }
    throw error;
  }
}

async function loginAccount(account, proxyUrl) {
  try {
    const wallet = new ethers.Wallet(account.privateKey);
    const address = getEthersAddress(wallet.address);
    addLog(`Logging in for account: ${getShortAddress(address)}`, "wait");

    const challengeRes = await makeApiCall(
      `https://api.testnet.incentiv.io/api/user/challenge?type=BROWSER_EXTENSION&address=${address}`,
      'GET',
      null,
      proxyUrl
    );

    if (!challengeRes || !challengeRes.result || !challengeRes.result.challenge) {
      addLog(`Unexpected challenge response: ${JSON.stringify(challengeRes)}`, "error");
      throw new Error("Challenge response invalid or address not registered.");
    }

    const challenge = challengeRes.result.challenge;
    const signature = await wallet.signMessage(challenge);

    const loginPayload = { type: "BROWSER_EXTENSION", challenge, signature };
    const loginRes = await makeApiCall(
      `https://api.testnet.incentiv.io/api/user/login`,
      'POST',
      loginPayload,
      proxyUrl
    );

    if (!loginRes || !loginRes.result || !loginRes.result.address || !loginRes.result.token) {
      addLog(`Unexpected login response: ${JSON.stringify(loginRes)}`, "error");
      throw new Error("Login response invalid.");
    }

    account.smartAddress = getEthersAddress(loginRes.result.address);
    account.token = loginRes.result.token;
    const eoaAddress = wallet.address;
    await saveToken(eoaAddress, account.smartAddress, account.token);
    addLog(`Login Successfully, Smart Address: ${getShortAddress(account.smartAddress)}`, "success");

    // Update next faucet time
    const userRes = await makeApiCall('https://api.testnet.incentiv.io/api/user', 'GET', null, proxyUrl, account.token);
    if (userRes.code === 200) {
      account.nextFaucetTime = userRes.result.nextFaucetRequestTimestamp || 0;
    }

    return true;
  } catch (error) {
    addLog(`Login failed for account: ${error.message}`, "error");
    return false;
  }
}

function loadTwoCaptchaKey() {
  try {
    if (fs.existsSync(TWO_CAPTCHA_FILE)) {
      const data = fs.readFileSync(TWO_CAPTCHA_FILE, "utf8");
      const config = JSON.parse(data);
      return config.twoCaptchaKey;
    }
  } catch (error) {
    addLog(`Failed to load 2Captcha key: ${error.message}`, "error");
  }
  return null;
}

async function solveTurnstile(twoCaptchaKey) {
  try {
    addLog(`Sending captcha task to 2Captcha for solving.`, "info");
    const res = await axios.post('https://2captcha.com/in.php', null, {
      params: {
        key: twoCaptchaKey,
        method: 'turnstile',
        sitekey: TURNSTILE_SITEKEY,
        pageurl: PAGE_URL,
        json: 1
      },
      timeout: 30000
    });

    if (res.data.status !== 1) throw new Error(res.data.request || 'Unknown error from 2captcha');
    const requestId = res.data.request;

    addLog(`Captcha task sent, waiting for solution (ID: ${requestId})...`, "wait");

    // Wait for solution (max 2 minutes)
    for (let i = 0; i < 24; i++) {
      await sleep(5000);
      const poll = await axios.get('https://2captcha.com/res.php', {
        params: {
          key: twoCaptchaKey,
          action: 'get',
          id: requestId,
          json: 1
        },
        timeout: 30000
      });

      if (poll.data.status === 1) {
        const token = poll.data.request;
        addLog(`Captcha solved successfully.`, "success");
        return token;
      } else if (poll.data.request === 'CAPCHA_NOT_READY') {
        addLog(`Captcha not ready yet, polling again... (${i + 1}/24)`, "wait");
        continue;
      } else {
        throw new Error(poll.data.request || 'Unknown error from 2captcha');
      }
    }

    throw new Error('Captcha solving timeout');
  } catch (error) {
    addLog(`Failed to solve Turnstile: ${error.message}`, "error");
    throw error;
  }
}

async function claimFaucet(account, proxyUrl) {
  if (account.isClaiming) return false;

  account.isClaiming = true;
  try {
    addLog(`Checking faucet eligibility for ${getShortAddress(account.smartAddress)}`, "info");

    // Get user data to check eligibility
    const userRes = await makeApiCall('https://api.testnet.incentiv.io/api/user', 'GET', null, proxyUrl, account.token);
    if (userRes.code !== 200) throw new Error('Failed to fetch user data');

    const nextTimestamp = userRes.result.nextFaucetRequestTimestamp;
    account.nextFaucetTime = nextTimestamp;

    if (Date.now() < nextTimestamp) {
      const timeLeft = nextTimestamp - Date.now();
      const hours = Math.floor(timeLeft / (1000 * 60 * 60));
      const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
      addLog(`Account ${getShortAddress(account.smartAddress)} not eligible for faucet yet. Next in: ${hours}h ${minutes}m`, "warn");
      return false;
    }

    const usingProxy = proxyUrl ? `Yes` : 'No';
    const ip = await getIP(proxyUrl);
    addLog(`Preparing to claim faucet. Using proxy: ${usingProxy}, IP: ${ip}`, "info");

    const twoCaptchaKey = loadTwoCaptchaKey();
    if (!twoCaptchaKey) throw new Error('2Captcha key not set');

    const token = await solveTurnstile(twoCaptchaKey);
    addLog(`Submitting faucet claim with solved captcha.`, "info");

    const payload = { verificationToken: token };
    const faucetRes = await makeApiCall(
      'https://api.testnet.incentiv.io/api/user/faucet',
      'POST',
      payload,
      proxyUrl,
      account.token
    );

    if (faucetRes.code !== 200) throw new Error('Failed to claim faucet');

    account.nextFaucetTime = faucetRes.result.nextFaucetRequestTimestamp;
    addLog(`? Faucet claimed successfully for ${getShortAddress(account.smartAddress)}. Amount: ${faucetRes.result.amount} TCENT`, "success");
    return true;
  } catch (error) {
    addLog(`? Faucet claim failed for ${getShortAddress(account.smartAddress)}: ${error.message}`, "error");
    return false;
  } finally {
    account.isClaiming = false;
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fungsi untuk menjalankan satu siklus claim faucet
async function runFaucetCycle() {
  if (accounts.length === 0) {
    addLog("No valid accounts found.", "error");
    return;
  }

  const twoCaptchaKey = loadTwoCaptchaKey();
  if (!twoCaptchaKey) {
    addLog("? 2Captcha key not found. Please create api.json with your 2captcha key.", "error");
    addLog("Format: {\"twoCaptchaKey\": \"YOUR_API_KEY\"}", "info");
    return;
  }

  isFaucetRunning = true;
  addLog(`\n?? ========================================`, "success");
  addLog(`?? Starting Faucet Cycle - ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}`, "success");
  addLog(`?? ========================================`, "success");
  addLog(`?? Total accounts: ${accounts.length}, Proxies: ${proxies.length}`, "info");

  let successCount = 0;
  let failCount = 0;
  let skipCount = 0;

  for (let i = 0; i < accounts.length && !shouldStopFaucet; i++) {
    const account = accounts[i];
    const proxyUrl = proxies[i % proxies.length] || null;

    addLog(`\n--- Processing Account ${i + 1}/${accounts.length} ---`, "info");
    addLog(`Wallet: ${getShortAddress(new ethers.Wallet(account.privateKey).address)}`, "info");
    addLog(`Proxy: ${proxyUrl || 'No proxy'}`, "info");

    try {
      // Cek apakah wallet sudah eligible untuk claim
      const now = Date.now();
      if (account.nextFaucetTime && now < account.nextFaucetTime) {
        const timeLeft = account.nextFaucetTime - now;
        const hours = Math.floor(timeLeft / (1000 * 60 * 60));
        const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
        addLog(`? Wallet not eligible yet. Next claim in: ${hours}h ${minutes}m`, "warn");
        skipCount++;
        
        // Jeda 10 detik sebelum wallet berikutnya meskipun skip
        if (i < accounts.length - 1 && !shouldStopFaucet) {
          addLog(`? Waiting 10 seconds before next wallet...`, "delay");
          await sleep(10000);
        }
        continue;
      }

      // Login jika diperlukan
      let needsLogin = true;
      if (account.smartAddress && account.token) {
        const tokenValid = await testToken(account, proxyUrl);
        if (tokenValid) {
          addLog(`? Token valid, skipping login`, "success");
          needsLogin = false;
        } else {
          addLog(`?? Token invalid, re-logging in`, "warn");
        }
      }

      if (needsLogin) {
        addLog(`?? Logging in...`, "wait");
        const loginSuccess = await loginAccount(account, proxyUrl);
        if (!loginSuccess) {
          addLog(`? Login failed, skipping account`, "error");
          failCount++;
          
          // Jeda 10 detik sebelum wallet berikutnya
          if (i < accounts.length - 1 && !shouldStopFaucet) {
            addLog(`? Waiting 10 seconds before next wallet...`, "delay");
            await sleep(10000);
          }
          continue;
        }
      }

      // Claim faucet
      if (account.smartAddress && account.token) {
        addLog(`?? Attempting faucet claim...`, "wait");
        const result = await claimFaucet(account, proxyUrl);
        if (result) successCount++;
        else failCount++;
      } else {
        addLog(`? No smart address or token, skipping faucet claim`, "error");
        failCount++;
      }

    } catch (error) {
      addLog(`? Account ${i + 1} processing failed: ${error.message}`, "error");
      failCount++;
    }

    // Jeda 10 detik sebelum wallet berikutnya (kecuali wallet terakhir)
    if (i < accounts.length - 1 && !shouldStopFaucet) {
      addLog(`? Waiting 10 seconds before next wallet...`, "delay");
      await sleep(10000);
    }
  }

  addLog(`\n=== ?? FAUCET CYCLE SUMMARY ===`, "info");
  addLog(`? Success: ${successCount} accounts`, successCount > 0 ? "success" : "info");
  addLog(`? Failed: ${failCount} accounts`, failCount > 0 ? "error" : "info");
  addLog(`? Skipped: ${skipCount} accounts (not eligible)`, skipCount > 0 ? "warn" : "info");
  addLog(`?? Total processed: ${accounts.length} accounts`, "info");
  
  // Hitung waktu next cycle
  const nextCycleTime = new Date(Date.now() + 4 * 60 * 60 * 1000);
  addLog(`?? Next cycle at: ${nextCycleTime.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}`, "success");

  isFaucetRunning = false;
  return { successCount, failCount, skipCount };
}

// Fungsi untuk menjalankan claim faucet dalam loop
async function startFaucetLoop() {
  if (isFaucetLoopRunning) {
    addLog("?? Faucet loop is already running!", "warn");
    return;
  }

  isFaucetLoopRunning = true;
  shouldStopFaucet = false;
  
  addLog("?? =================================", "success");
  addLog("?? STARTING AUTO FAUCET LOOP", "success");
  addLog("?? Claim every 4 hours | 10s per wallet", "success");
  addLog("?? =================================", "success");
  
  // Jalankan sekali immediately
  await runFaucetCycle();
  
  // Set interval untuk menjalankan setiap 4 jam (14400000 ms)
  faucetInterval = setInterval(async () => {
    if (shouldStopFaucet) {
      stopFaucetLoop();
      return;
    }
    await runFaucetCycle();
  }, 14400000); // 4 jam dalam milidetik

  addLog("?? Faucet loop started successfully!", "success");
  addLog("?? Next cycle in 4 hours", "success");
}

// Fungsi untuk menghentikan loop
function stopFaucetLoop() {
  if (faucetInterval) {
    clearInterval(faucetInterval);
    faucetInterval = null;
  }
  isFaucetLoopRunning = false;
  shouldStopFaucet = true;
  addLog("?? Faucet loop stopped!", "info");
}

// Fungsi untuk menjalankan sekali saja (manual)
async function runFaucetOnce() {
  if (isFaucetRunning) {
    addLog("?? Faucet is already running!", "warn");
    return;
  }
  
  addLog("?? Starting manual faucet run...", "info");
  await runFaucetCycle();
  addLog("?? Manual faucet run completed!", "success");
}

// Initialize and run
async function initialize() {
  try {
    addLog("?? Initializing faucet claimer...", "info");
    loadConfig();
    loadAccounts();
    loadProxies();

    if (accounts.length === 0) {
      addLog("? No accounts to process. Please check pk.txt file.", "error");
      return;
    }

    addLog(`?? Starting faucet loop for ${accounts.length} accounts...`, "info");
    
    // Mulai loop faucet
    await startFaucetLoop();

  } catch (error) {
    addLog(`?? Initialization error: ${error.message}`, "error");
  }
}

// Handle process termination
process.on('SIGINT', () => {
  addLog("?? Process interrupted by user", "info");
  shouldStopFaucet = true;
  stopFaucetLoop();
  setTimeout(() => {
    addLog("?? Process exited gracefully", "info");
    process.exit(0);
  }, 1000);
});

process.on('SIGTERM', () => {
  addLog("?? Process terminated", "info");
  shouldStopFaucet = true;
  stopFaucetLoop();
  setTimeout(() => {
    addLog("?? Process exited gracefully", "info");
    process.exit(0);
  }, 1000);
});

// Start the application
initialize();
