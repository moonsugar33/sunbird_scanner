import puppeteer from 'puppeteer';
// This program accesses web pages without having to display their contents
import { createClient } from '@supabase/supabase-js';
// It reads from Supabase and updates data there
import figlet from 'figlet';
// It generates an ASCII title when the program starts

// Introducing Bun's native file system API
const fs = {
  // Declaring the file system "object"
  existsSync: (path) => {
    // A way to check if a file exists at a given location
    // Used when checking for browser executables (Linux, Windows, and macOS)
    try {
      return Bun.file(path).size !== undefined;
    } catch {
      return false;
    }
  },
  writeFileSync: (path, data) => Bun.write(path, data),
    // Lets this program create a .txt file
    // Used when saving scan results for the first time in a day
  appendFileSync: (path, data) => {
    // Lets this program add data to a .txt file that already exists
    // Used if multiple scans are run in the same day
    const file = Bun.file(path);
    return Bun.write(path, data, { append: true });
  }
};

// Locating a compatible browser installation, depending on the operating system
const detectBrowserExecutable = () => {
  // Detects which operating system is installed
  if (!['linux', 'win32', 'darwin'].includes(process.platform)) {
    // If the operating system is not supported, it displays an error message
    throw new Error(`Unsupported operating system: ${process.platform}.
      \nThis scanner only supports Linux, Windows, and macOS.
      \nWhy not try developing this for ${process.platform} yourself?
      \nTry Cursor here: https://cursor.sh`);
  }

  let paths;
  if (process.platform === 'win32') {
    // Windows paths, organized by architecture
    paths = [
      // 64-bit: Chrome, Chromium, Opera, Opera GX, Brave, and Edge
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Chromium\\Application\\chrome.exe',
      'C:\\Program Files\\Opera\\launcher.exe',
      'C:\\Program Files\\Opera GX\\launcher.exe',
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      // 32-bit: Chrome, Chromium, Opera, Opera GX, Brave, and Edge
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Opera\\launcher.exe',
      'C:\\Program Files (x86)\\Opera GX\\launcher.exe',
      'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
  } else if (process.platform === 'darwin') {
    // macOS paths for Chrome, Chromium, Opera, Opera GX, Brave, and Edge
    paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Opera.app/Contents/MacOS/Opera',
      '/Applications/Opera GX.app/Contents/MacOS/Opera GX',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  } else if (process.platform === 'linux') {
    // Linux-compatible browser paths, organized by distribution method
    paths = [
      // APT package manager installations: Chrome, Chromium, Opera, and Brave
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/opera',
      '/usr/bin/brave-browser',
      // Snap package manager installations: Chromium and Brave
      '/snap/bin/chromium',
      '/snap/bin/brave',
      // Flatpak package manager installations: Chromium, Opera, and Brave
      '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
      '/var/lib/flatpak/exports/bin/com.opera.Browser',
      '/var/lib/flatpak/exports/bin/com.brave.Browser',
    ];
  } 

  const foundPath = paths.find(path => fs.existsSync(path));
  // Defines the path to the browser executable, if found
  if (!foundPath) {
    // Defining friendly names for Windows and macOS
    const platform = process.platform === 'win32' ? 'Windows' 
    : process.platform === 'darwin' ? 'macOS' 
    : 'Linux';
    // OS-specific error message + download links, if no compatible browser is found
    const browserLinks = {
      'Windows': `
Chrome: https://www.google.com/chrome/
Chromium: https://www.chromium.org/getting-involved/download-chromium
Brave: https://brave.com/download/windows
Opera: https://www.opera.com/computer
Opera GX: https://www.opera.com/gx
Edge: https://www.microsoft.com/edge`,

      'macOS': `
Chrome: https://www.google.com/chrome/
Chromium: https://www.chromium.org/getting-involved/download-chromium
Brave: https://brave.com/download/macos
Opera: https://www.opera.com/computer
Opera GX: https://www.opera.com/gx
Edge: https://www.microsoft.com/edge`,

      'Linux': `
Chrome: https://www.google.com/chrome/
Brave: https://brave.com/download/
Opera: https://www.opera.com/download

Or install via package manager:
Chrome (Ubuntu/Debian): sudo apt install google-chrome-stable
Chromium (Ubuntu/Debian): sudo apt install chromium-browser
Brave (Ubuntu/Debian): sudo apt install brave-browser
Opera (Ubuntu/Debian): sudo apt install opera-stable

Chromium (Snap): sudo snap install chromium
Brave (Snap): sudo snap install brave

Chromium (Flatpak): flatpak install org.chromium.Chromium
Brave (Flatpak): flatpak install com.brave.Browser
Opera (Flatpak): flatpak install com.opera.Browser`
    };
    
    console.warn(`⚠️ No compatible browser found on ${platform}.
      \nPlease install one of these browsers:
      \n${browserLinks[platform]}`);
  }
  return foundPath;
};

// Constants and configurations for different scanners
const SCANNER_CONFIGS = {
  GAZAVETTERS: {
    tableName: 'gv-links',
    displayName: 'GazaVetters Scanner',
    description: 'Scans GazaVetters fundraising campaigns'
  },
  SUNBIRD: {
    tableName: 'sunbird',
    displayName: 'Sunbird Scanner',
    description: 'Scans Sunbird fundraising campaigns'
  }
};

// Shared constants and configurations
const SHARED_CONFIG = {
  CURRENCY_MAPPING: {
    // Symbols to codes
    '€': 'EUR',
    '$': 'USD',
    '£': 'GBP',
    '¥': 'JPY',
    '₹': 'INR',
    '₽': 'RUB',
    '₪': 'ILS',
    '₱': 'PHP',
    '₩': 'KRW',
    'R$': 'BRL',
    
    // Nordic currencies
    'kr': 'SEK',
    'Kr': 'SEK',
    'KR': 'SEK',
    'SEK': 'SEK',
    'NOK': 'NOK',
    'DKK': 'DKK',
    
    // Other currency codes
    'EUR': 'EUR',
    'USD': 'USD',
    'GBP': 'GBP'
  },
  CURRENCY_SYMBOLS: {
    'EUR': '€',
    'USD': '$',
    'GBP': '£',
    'JPY': '¥',
    'INR': '₹',
    'RUB': '₽',
    'ILS': '₪',
    'PHP': '₱',
    'KRW': '₩',
    'BRL': 'R$',
    'SEK': 'kr',
    'NOK': 'kr',
    'DKK': 'kr'
  },
  BROWSER_CONFIG: {
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-audio',
      '--disable-notifications',
      '--window-size=1920,1080',
      '--js-flags="--max-old-space-size=4096"',
      '--single-process',
      '--disable-features=site-per-process',
      '--disable-site-isolation-trials',
      '--disable-features=BlinkRuntimeCallStats',
      '--disable-field-trial-config',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-translate',
      '--disable-component-extensions-with-background-pages',
      ...(process.platform === 'linux' ? [
        '--no-zygote',
        '--disable-accelerated-2d-canvas',
        '--disable-gl-drawing-for-tests',
        '--use-gl=swiftshader'
      ] : process.platform === 'win32' ? [
        '--disable-gpu-sandbox',
        '--disable-win32k-lockdown',
        '--no-zygote',
        '--disable-d3d11',
        '--enable-bun-optimizations'
      ] : [
        '--disable-d3d11'
      ])
    ],
    defaultViewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true,
    waitForInitialPage: true,
    executablePath: detectBrowserExecutable()
  },
  RATE_LIMIT: {
    requestsPerMinute: 30,
    minDelay: 5000,
    maxDelay: 20000
  },
  ERROR_STRATEGIES: {
    'TimeoutError': { retries: 3, delay: 5000 },
    'NetworkError': { retries: 3, delay: 3000 },
    'ElementsNotFound': { retries: 3, delay: 2000 },
    'default': { retries: 2, delay: 2000 }
  }
};

// Site-specific configurations
const SITE_CONFIGS = {
  GOFUNDME: {
    type: 'gofundme',
    selectors: {
      title: 'h1.p-campaign-title',
      raised: '.progress-meter_progressBarHeading__Nxc77',
      goal: '.progress-meter_circleGoalDonations__5gSh1',
      supporters: '.progress-meter_circleGoalDonations__5gSh1'
    }
  },
  CHUFFED: {
    type: 'chuffed',
    selectors: {
      title: 'h1.campaign-container__title',
      raised: '[data-testid="progress-meter-raised"]',
      goal: '[data-testid="progress-meter-target"]',
      supporters: '.campaign-container__share-values h3'
    },
    api: {
      endpoint: 'https://chuffed.org/api/graphql',
      query: `query getCampaign($id: ID!) {
        campaign(id: $id) {
          id
          collected {
            amount
            __typename
          }
          donations {
            totalCount
            __typename
          }
          target {
            amount
            currency
            currencyNode {
              symbol
              __typename
            }
            __typename
          }
          title
          __typename
        }
      }`
    }
  }
};

// Add this function at the top level
async function cleanupMemory(browser) {
  try {
    if (!browser) return;
    
    const pages = await browser.pages();
    await Promise.all(pages.map(async (page) => {
      if (!page.isClosed()) {
        await page.removeAllListeners();
        await page.close();
      }
    }));
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
  } catch (error) {
    console.error('Error during memory cleanup:', error);
  }
}

// Add this logging utility
class Logger {
  static levels = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
  };

  constructor(level = 'INFO') {
    this.level = Logger.levels[level] || Logger.levels.INFO;
  }

  formatMessage(level, message, context = {}) {
    const timestamp = new Date().toISOString();
    let contextStr = '';
    
    if (Object.keys(context).length) {
      contextStr = Object.entries(context)
        .map(([key, value]) => {
          // Format error objects specially
          if (key === 'error' && value instanceof Error) {
            return `\n   ${key}: ${value.message}`;
          }
          // Skip stack traces unless it's an ERROR level message
          if (key === 'stack' && level !== 'ERROR') {
            return '';
          }
          return `\n   ${key}: ${value}`;
        })
        .filter(Boolean) // Remove empty strings
        .join('');
    }

    // Add color to the level indicator
    const coloredLevel = {
      'DEBUG': '\x1b[36mDEBUG\x1b[0m', // Cyan
      'INFO': '\x1b[32mINFO\x1b[0m',   // Green
      'WARN': '\x1b[33mWARN\x1b[0m',   // Yellow
      'ERROR': '\x1b[31mERROR\x1b[0m'  // Red
    }[level];

    return `[${timestamp}] ${coloredLevel}: ${message}${contextStr}`;
  }

  debug(message, context = {}) {
    if (this.level <= Logger.levels.DEBUG) {
      console.log(this.formatMessage('DEBUG', message, context));
    }
  }

  info(message, context = {}) {
    if (this.level <= Logger.levels.INFO) {
      console.log(this.formatMessage('INFO', message, context));
    }
  }

  warn(message, context = {}) {
    if (this.level <= Logger.levels.WARN) {
      console.warn(this.formatMessage('WARN', message, context));
    }
  }

  error(message, error, context = {}) {
    if (this.level <= Logger.levels.ERROR) {
      console.error(this.formatMessage('ERROR', message, {
        ...context,
        error: error?.message,
        stack: error?.stack
      }));
    }
  }
}

// Add these optimization utilities
class PerformanceMonitor {
  constructor() {
    this.metrics = {
      memory: [],
      timing: new Map(),
      errors: new Map()
    };
  }

  startTimer(label) {
    this.metrics.timing.set(label, process.hrtime());
  }

  endTimer(label) {
    const start = this.metrics.timing.get(label);
    if (!start) return;
    
    const [seconds, nanoseconds] = process.hrtime(start);
    return seconds * 1000 + nanoseconds / 1000000; // Convert to milliseconds
  }

  recordMemoryUsage() {
    const usage = process.memoryUsage();
    this.metrics.memory.push({
      timestamp: Date.now(),
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      rss: usage.rss
    });

    // Keep only last hour of metrics
    const oneHourAgo = Date.now() - 3600000;
    this.metrics.memory = this.metrics.memory.filter(m => m.timestamp > oneHourAgo);
  }

  async optimizePage(page) {
    await page.setRequestInterception(true);
    
    page.on('request', request => {
      const resourceType = request.resourceType();
      const url = request.url();
      
      // Block unnecessary resources
      if (
        ['image', 'stylesheet', 'font', 'media'].includes(resourceType) ||
        url.includes('analytics') ||
        url.includes('tracking') ||
        url.includes('advertisement')
      ) {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Optimize memory usage
    await page.evaluate(() => {
      window.addEventListener('beforeunload', () => {
        // Clear intervals and timeouts
        const highestId = window.setTimeout(() => {}, 0);
        for (let i = 0; i < highestId; i++) {
          window.clearTimeout(i);
          window.clearInterval(i);
        }
      });
    });
  }
}

// Add this optimization utility
class PageOptimizer {
  static async optimize(page) {
    // Block unnecessary resources
    await page.setRequestInterception(true);
    
    page.on('request', request => {
      const resourceType = request.resourceType();
      const url = request.url();
      
      // Block more resource types and patterns
      if (
        ['image', 'stylesheet', 'font', 'media', 'other'].includes(resourceType) ||
        url.includes('analytics') ||
        url.includes('tracking') ||
        url.includes('advertisement') ||
        url.includes('marketing') ||
        url.includes('facebook') ||
        url.includes('google-analytics') ||
        url.includes('.gif') ||
        url.includes('.png') ||
        url.includes('.jpg') ||
        url.includes('.jpeg') ||
        url.includes('.css')
      ) {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Optimize page settings
    await Promise.all([
      page.setCacheEnabled(false),
      page.setJavaScriptEnabled(true), // Keep JS enabled but controlled
      page.setDefaultNavigationTimeout(30000),
      page.setDefaultTimeout(30000),
    ]);

    // Inject performance optimizations
    await page.evaluateOnNewDocument(() => {
      // Disable console logging
      console.log = () => {};
      console.debug = () => {};
      console.info = () => {};
      console.warn = () => {};
      
      // Prevent memory leaks
      window.addEventListener('beforeunload', () => {
        // Clear all intervals and timeouts
        const highestId = window.setTimeout(() => {}, 0);
        for (let i = 0; i < highestId; i++) {
          window.clearTimeout(i);
          window.clearInterval(i);
        }
        
        // Clear event listeners
        const oldRemoveEventListener = window.removeEventListener.bind(window);
        window.removeEventListener = function(type, listener, options) {
          try {
            oldRemoveEventListener(type, listener, options);
          } catch (e) {}
        };
      });
    });
  }
}

// Scanner class to handle different types of scans
class FundraisingScanner {
  constructor(scannerType) {
    if (!SCANNER_CONFIGS[scannerType]) {
      throw new Error(`Invalid scanner type: ${scannerType}`);
    }
    
    this.config = SCANNER_CONFIGS[scannerType];
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      {
        auth: {
          persistSession: false
        },
        global: {
          fetch: fetch
        }
      }
    );
    
    this.isShuttingDown = false;
    this.setupShutdownHandler();
    
    // Initialize metrics
    this.metrics = {
      startTime: Date.now(),
      successCount: 0,
      failureCount: 0,
      skippedCount: 0,
      notFoundCount: 0,
      pausedCount: 0,
      zeroDonationsCount: 0,
      responseTimesMs: [],
      errors: {},
      memoryUsage: [],
      browserCrashes: 0,
      avgResponseTime: 0,
      notFoundLinks: [], // Update to store title
    };
    
    // Initialize failed scans tracking
    this.failedScans = {
      items: [],
      add: (id, url, reason) => {
        this.failedScans.items.push({
          id,
          url,
          reason,
          timestamp: new Date().toISOString()
        });
      }
    };
    
    // Add periodic monitoring
    setInterval(() => {
      const usage = process.memoryUsage();
      this.metrics.memoryUsage.push({
        timestamp: Date.now(),
        heapUsed: usage.heapUsed,
        heapTotal: usage.heapTotal
      });
      
      // Keep only last hour of metrics
      const oneHourAgo = Date.now() - 3600000;
      this.metrics.memoryUsage = this.metrics.memoryUsage.filter(m => m.timestamp > oneHourAgo);
    }, 60000);

    this.logger = new Logger(process.env.LOG_LEVEL || 'INFO');
    this.performanceMonitor = new PerformanceMonitor();
    
    // Enhanced metrics
    this.metrics = {
      ...this.metrics,
      responseTimesByPlatform: new Map(),
      errorsByType: new Map(),
      memorySnapshots: [],
      browserRestarts: 0
    };

    // More frequent memory monitoring
    setInterval(() => {
      this.performanceMonitor.recordMemoryUsage();
      
      // Check for memory pressure
      const usage = process.memoryUsage();
      if (usage.heapUsed / usage.heapTotal > 0.85) {
        this.logger.warn('High memory usage detected', {
          heapUsed: usage.heapUsed,
          heapTotal: usage.heapTotal,
          percentage: ((usage.heapUsed / usage.heapTotal) * 100).toFixed(2) + '%'
        });
      }
    }, 30000);
  }

  setupShutdownHandler() {
    process.on('SIGINT', async () => {
      console.log('\n\n🛑 Graceful shutdown initiated...');
      this.setTerminalTitle('Scanner - Shutting down');
      this.isShuttingDown = true;
      await this.cleanup(true);
    });
  }

  setTerminalTitle(title) {
    process.stdout.write(`\x1b]0;${title}\x1b\\`);
  }

  displayLogo() {
    console.clear();
    this.setTerminalTitle(`${this.config.displayName} - Running`);
    console.log(
      figlet.textSync(this.config.displayName, {
        font: 'Standard',
        horizontalLayout: 'default',
        verticalLayout: 'default'
      })
    );
    console.log('\n');
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async retry(fn, errorType = 'default', context = '') {
    const strategy = SHARED_CONFIG.ERROR_STRATEGIES[errorType] || SHARED_CONFIG.ERROR_STRATEGIES.default;
    let lastError;
    
    for (let i = 0; i < strategy.retries; i++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const retryDelay = strategy.delay * Math.pow(1.5, i); // Exponential backoff
        console.log(`⚠️ ${context}: ${errorType} retry ${i + 1}/${strategy.retries} in ${retryDelay}ms`);
        console.log(`   Error: ${error.message}`);
        await this.delay(retryDelay);
      }
    }
    throw lastError;
  }

  async rateLimiter() {
    try {
      const now = Date.now();
      if (!this.lastRequest) this.lastRequest = now;
      
      const minWait = Math.floor(60000 / SHARED_CONFIG.RATE_LIMIT.requestsPerMinute);
      const elapsed = now - this.lastRequest;
      const delay = Math.max(0, minWait - elapsed);
      
      if (delay > 0) {
        await this.delay(delay);
      }
      
      this.lastRequest = Date.now();
    } catch (error) {
      console.error('Rate limiter error:', error);
      await this.delay(SHARED_CONFIG.RATE_LIMIT.minDelay);
    }
  }

  async fetchCampaignUrls() {
    try {
      const { data, error } = await this.supabase
        .from(this.config.tableName)
        .select('id, link')
        .order('id', { ascending: true });

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error fetching URLs:', error);
      return [];
    }
  }



  async updateCampaignData(id, target, raised, name, currency, donations) {
    const maxRetries = 3;
    let attempt = 0;
    
    while (attempt < maxRetries) {
      try {
        this.logger.debug(`  ├─💾 Saving to database...`);
        const { error } = await this.supabase
          .from(this.config.tableName)
          .update({
            target: parseInt(target) || null,
            raised: parseInt(raised) || null,
            title: name || null,
            currency: currency || null,
            donations: parseInt(donations) || null,
            updated_at: new Date().toISOString()
          })
          .eq('id', id);

        if (error) throw error;

        this.logger.debug(`  └─✅ Updated`);
        return true;
        
      } catch (error) {
        attempt++;
        if (attempt === maxRetries) {
          this.logger.error(`  └─❌ Update failed: ${error.message}`);
          return false;
        }
        this.logger.warn(`  ├─⚠️ Retry ${attempt}/${maxRetries}`);
        await this.delay(2000 * attempt);
      }
    }
  }

  detectSiteType(url) {
    if (!url) return null;
    
    if (url.includes('gofundme.com')) return SITE_CONFIGS.GOFUNDME.type;
    if (url.includes('chuffed.org')) return SITE_CONFIGS.CHUFFED.type;
    
    return null;
  }

  parseRaisedAmount(text) {
    if (!text) return {
      currency: null,
      amount: null,
      raw: null
    };

    // Sanitize input and handle HTML
    text = text.toString().trim();
    
    try {
      // Handle GoFundMe dollar amounts specifically
      // Case 1: "$X USD raised" (explicit USD)
      // Case 2: "$X raised" (implicit AUD)
      const dollarMatch = text.match(/\$\s*([\d,. ]+)(?:\s+([A-Z]{3}))?\s+raised/i);
      if (dollarMatch) {
        const amount = dollarMatch[1].replace(/[,\s]/g, '');
        // If no currency code is specified after the amount, assume AUD
        const currencyCode = dollarMatch[2]?.toUpperCase() || 'AUD';
        
        return {
          currency: currencyCode,
          amount: amount,
          raw: dollarMatch[0]
        };
      }

      // Handle other currency symbols without modification
      const otherCurrencyMatch = text.match(/([€£¥₹₽₪₱₩R$]|[Kk]r\.?)\s*([\d,. ]+)/);
      if (otherCurrencyMatch) {
        const symbol = otherCurrencyMatch[1];
        const amount = otherCurrencyMatch[2].replace(/[,\s]/g, '');
        return {
          currency: SHARED_CONFIG.CURRENCY_MAPPING[symbol] || symbol,
          amount: amount,
          raw: otherCurrencyMatch[0]
        };
      }

      // Debug: Show if no match found
      console.log('DEBUG: No currency match found, raw text was:', text);
      
      return {
        currency: 'Not found',
        amount: 'Not found',
        raw: text
      };
    } catch (error) {
      console.error('Error parsing amount:', error);
      return {
        currency: null,
        amount: null,
        raw: text,
        error: error.message
      };
    }
  }

  parseTargetAmount(text) {
    if (!text) return {
      currency: 'Not found',
      amount: 'Not found',
      raw: 'Not found'
    };

    text = text.split('·')[0].trim();

    const normalizeAmount = (amount, hasK = false) => {
      amount = amount.replace(/[,\s]/g, '');
      const numAmount = parseFloat(amount);
      return hasK ? (numAmount * 1000).toString() : amount;
    };

    // Handle K suffix
    const kSuffixMatch = text.match(/([€$£¥₹₽₱₩R$]|[Kk]r\.?|EUR|USD|GBP)?\s*([\d,. ]+)[kK]\b/i);
    if (kSuffixMatch) {
      const amount = normalizeAmount(kSuffixMatch[2], true);
      const rawCurrency = kSuffixMatch[1]?.trim().toUpperCase() || 'EUR';
      return {
        currency: SHARED_CONFIG.CURRENCY_MAPPING[rawCurrency] || rawCurrency,
        amount: amount,
        raw: text
      };
    }

    // GoFundMe HTML format
    const gfmMatch = text.match(
      /<span[^>]*>([\d,. ]+)[kK]?\s*<\/span>\s*<span[^>]*>([A-Z]{3}|[Kk][Rr]?)\s*<\/span>/i
    );

    if (gfmMatch) {
      const hasK = gfmMatch[1].toLowerCase().endsWith('k');
      const amount = normalizeAmount(gfmMatch[1].replace(/[kK]$/, ''), hasK);
      const rawCurrency = gfmMatch[2].trim().toUpperCase();
      return {
        currency: SHARED_CONFIG.CURRENCY_MAPPING[rawCurrency] || rawCurrency,
        amount: amount,
        raw: gfmMatch[0]
      };
    }

    // Post-amount currencies
    const postAmountMatch = text.match(
      /([\d,. ]+)[kK]?\s*([A-Z]{3}|[Kk][Rr]?)\b/i
    );

    if (postAmountMatch) {
      const hasK = postAmountMatch[1].toLowerCase().endsWith('k');
      const amount = normalizeAmount(postAmountMatch[1].replace(/[kK]$/, ''), hasK);
      const rawCurrency = postAmountMatch[2].trim().toUpperCase();
      return {
        currency: SHARED_CONFIG.CURRENCY_MAPPING[rawCurrency] || rawCurrency,
        amount: amount,
        raw: postAmountMatch[0]
      };
    }

    // Pre-amount currencies
    const preAmountMatch = text.match(
      /([€$£¥₹₽₪₱₩R$]|[Kk]r\.?|EUR|USD|GBP)\s*([\d,.]+)[kK]?\b/i
    );

    if (preAmountMatch) {
      const hasK = preAmountMatch[2].toLowerCase().endsWith('k');
      const amount = normalizeAmount(preAmountMatch[2].replace(/[kK]$/, ''), hasK);
      const rawCurrency = preAmountMatch[1].trim().toUpperCase();
      return {
        currency: SHARED_CONFIG.CURRENCY_MAPPING[rawCurrency] || rawCurrency,
        amount: amount,
        raw: preAmountMatch[0]
      };
    }

    return {
      currency: 'Not found',
      amount: 'Not found',
      raw: 'Not found'
    };
  }

  parseGoFundMeSupporters(text) {
    if (!text) return null;

    const match = text.match(/([\d,.]+)(K|k)?\s*donation[s]?/i);
    if (match) {
      const number = parseFloat(match[1].replace(/,/g, ''));
      const hasKSuffix = match[2]?.toLowerCase() === 'k';
      
      return hasKSuffix ? Math.round(number * 1000) : Math.round(number);
    }
    return null;
  }

  async waitForAnimation(page, selector, timeout = 5000) {
    const startTime = Date.now();
    let lastValue = null;
    
    while (Date.now() - startTime < timeout) {
      const currentValue = await page.$eval(selector, el => el.textContent);
      if (currentValue === lastValue) {
        return true;
      }
      lastValue = currentValue;
      await this.delay(100);
    }
    return false;
  }

  extractChuffedId(url) {
    // First try to match numeric ID
    const numericMatch = url.match(/chuffed\.org\/project\/(\d+)/);
    if (numericMatch) return numericMatch[1];
    
    // If no numeric ID, extract the slug
    const slugMatch = url.match(/chuffed\.org\/project\/([^\/\s]+)/);
    if (!slugMatch) return null;
    
    // Return the slug prefixed with 'slug:' to indicate it needs resolution
    return `slug:${slugMatch[1]}`;
  }

  async fetchChuffedData(projectId) {
    try {
      // If it's a slug, we need to resolve it first
      if (projectId.startsWith('slug:')) {
        const slug = projectId.replace('slug:', '');
        // Make a request to the page to get the numeric ID
        const response = await fetch(`https://chuffed.org/project/${slug}`, {
          headers: {
            'accept': 'text/html',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        });
        
        const html = await response.text();
        // Extract the numeric ID from the HTML response using the campaignInit script
        const idMatch = html.match(/campaignId:\s*(\d+)/);
        if (!idMatch) throw new Error('Could not find campaign ID in page');
        projectId = idMatch[1];
      }

      const response = await fetch(SITE_CONFIGS.CHUFFED.api.endpoint, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operationName: 'getCampaign',
          variables: { id: parseInt(projectId) },
          query: SITE_CONFIGS.CHUFFED.api.query
        })
      });

      const jsonData = await response.json();
      if (!jsonData?.data?.campaign) {
        throw new Error('Invalid response structure from Chuffed API');
      }

      return jsonData.data;
    } catch (error) {
      console.error(`❌ Error fetching data from Chuffed API: ${error.message}`);
      return null;
    }
  }

  async processChuffedCampaign(campaign) {
    let retryCount = 0;
    const maxRetries = 3;

    try {
      this.logger.info(`📍 Chuffed #${campaign.id} ━━━━━━━━━━━━━`);
      
      const projectId = this.extractChuffedId(campaign.link);
      if (!projectId) throw new Error('Invalid Chuffed URL format');

      while (retryCount < maxRetries) {
        try {
          const chuffedData = await this.fetchChuffedData(projectId);
          if (!chuffedData?.campaign) throw new Error('Failed to fetch data');

          const data = chuffedData.campaign;
          const raised = (data.collected?.amount || 0) / 100;
          const target = (data.target?.amount || 0) / 100;
          const currencyCode = data.target?.currency || 'AUD';
          const currencySymbol = SHARED_CONFIG.CURRENCY_SYMBOLS[currencyCode] || currencyCode;
          const title = data.title || '';
          const donations = data.donations?.totalCount || 0;

          this.logger.info(`└─📊 ${title.substring(0, 40)}${title.length > 40 ? '...' : ''}`);
          this.logger.info(`  ├─💰 ${currencySymbol}${raised} of ${currencySymbol}${target}`);
          this.logger.info(`  └─👥 ${donations} donations`);

          const updated = await this.updateCampaignData(
            campaign.id, 
            target || null, 
            raised || null, 
            title, 
            currencyCode,
            donations
          );

          if (updated) {
            this.metrics.successCount++;
            return true;
          }
          throw new Error('Failed to update database');

        } catch (error) {
          retryCount++;
          if (retryCount === maxRetries) throw error;
          this.logger.warn(`  ↻ Retry ${retryCount}/${maxRetries}: ${error.message}`);
          await this.delay(2000 * retryCount);
        }
      }
    } catch (error) {
      this.metrics.failureCount++;
      this.logger.error(`❌ Failed: ${error.message}`, null, { id: campaign.id });
      this.failedScans.add(campaign.id, campaign.link, error.message);
      return false;
    }
  }

  async processGoFundMeCampaign(campaign, browser) {
    let page = null;
    let retryCount = 0;
    const maxRetries = 3;
    
    try {
      this.logger.info(`📍 GoFundMe #${campaign.id} ━━━━━━━━━━━━━`);

      page = await browser.newPage();
      await PageOptimizer.optimize(page);
      
      // Navigate to page
      const response = await Promise.race([
        page.goto(campaign.link, {
          waitUntil: 'domcontentloaded',
          timeout: 20000
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Navigation timeout')), 20000)
        )
      ]);

      // Handle 404 responses
      if (response.status() === 404) {
        this.logger.warn(`  └─🚫 Campaign no longer exists (404)`);
        // Store the 404 link with title
        this.metrics.notFoundLinks.push({
          id: campaign.id,
          url: campaign.link,
          title: await page.title() || 'Unknown Campaign' // Get the page title
        });
        
        // Update database to mark as dead URL
        await this.supabase
          .from(this.config.tableName)
          .update({
            is_dead: true,
            updated_at: new Date().toISOString()
          })
          .eq('id', campaign.id);
        
        this.metrics.notFoundCount++;
        return false;
      }

      // Check for paused campaign banner
      const isPaused = await page.evaluate(() => {
        const banner = document.querySelector('.hrt-promo-banner-content');
        if (!banner) return false;
        
        const pausedPhrases = [
          'no longer accepting donations',
          'disabled new donations',
          'The organiser has disabled new donations'
        ];
        
        return pausedPhrases.some(phrase => 
          banner.textContent?.toLowerCase().includes(phrase.toLowerCase())
        );
      });

      if (isPaused) {
        this.logger.warn(`  └─⏸️ Campaign is paused (not accepting donations)`);
        // Update database to mark as paused
        await this.supabase
          .from(this.config.tableName)
          .update({
            is_paused: true,
            updated_at: new Date().toISOString()
          })
          .eq('id', campaign.id);
        
        this.metrics.pausedCount = (this.metrics.pausedCount || 0) + 1;
        return false;
      }

      // Check for zero donations
      const hasNoDonations = await page.evaluate(() => {
        const zeroDonationsElement = document.querySelector('.hrt-avatar-lockup-content');
        return zeroDonationsElement?.textContent?.includes('Become the first supporter') || false;
      });

      if (hasNoDonations) {
        this.logger.info(`  └─💰 Campaign has no donations yet`);
        // Update database to mark zero donations
        await this.supabase
          .from(this.config.tableName)
          .update({
            donations: 0,
            raised: 0,
            updated_at: new Date().toISOString()
          })
          .eq('id', campaign.id);
        
        this.metrics.zeroDonationsCount = (this.metrics.zeroDonationsCount || 0) + 1;
        return true; // Still count as successful scan
      }

      if (!response?.ok()) throw new Error(`Invalid response: ${response?.status()}`);

      // Extract and process data with retries
      while (retryCount < maxRetries) {
        try {
          const selectors = SITE_CONFIGS.GOFUNDME.selectors;
          
          // Extract data
          const data = {
            title: await page.$eval(selectors.title, el => el.textContent.trim()),
            raisedText: await page.$eval(selectors.raised, el => el.textContent.trim()),
            goalText: await page.$eval(selectors.goal, el => el.textContent.trim()),
            supportersText: await page.$eval(selectors.supporters, el => el.textContent.trim())
          };

          // Parse the data
          const raised = this.parseRaisedAmount(data.raisedText);
          const goal = this.parseTargetAmount(data.goalText);
          const donations = this.parseGoFundMeSupporters(data.supportersText);

          // Ensure consistent currency between raised and goal
          const currencyCode = raised.currency || goal.currency;
          const currencySymbol = SHARED_CONFIG.CURRENCY_SYMBOLS[currencyCode] || currencyCode;

          // Log the extracted data
          this.logger.info(`└─📊 ${data.title.substring(0, 40)}${data.title.length > 40 ? '...' : ''}`);
          this.logger.info(`  ├─💰 ${currencySymbol}${raised.amount} of ${currencySymbol}${goal.amount}`);
          this.logger.info(`  └─👥 ${donations || 0} donations`);

          // Update database with consistent currency code
          const updated = await this.updateCampaignData(
            campaign.id, 
            goal.amount, 
            raised.amount, 
            data.title, 
            currencyCode,
            donations
          );

          if (updated) {
            this.metrics.successCount++;
            return true;
          }
          throw new Error('Failed to update database');

        } catch (error) {
          retryCount++;
          if (retryCount === maxRetries) throw error;
          this.logger.warn(`  ↻ Retry ${retryCount}/${maxRetries}: ${error.message}`);
          await this.delay(2000 * retryCount);
        }
      }

    } catch (error) {
      this.metrics.failureCount++;
      this.logger.error(`❌ Failed: ${error.message}`, null, { id: campaign.id });
      this.failedScans.add(campaign.id, campaign.link, error.message);
      return false;
    } finally {
      if (page) {
        await page.removeAllListeners();
        await page.close().catch(() => {});
      }
    }
  }

  async scrapeCampaign(campaign, browser) {
    this.performanceMonitor.startTimer(`campaign-${campaign.id}`);
    
    try {
      if (!campaign.link) {
        this.logger.warn('Skipping campaign with invalid URL', { id: campaign.id });
        this.metrics.skippedCount++;
        return false;
      }

      const siteType = this.detectSiteType(campaign.link);
      if (!siteType) {
        this.logger.warn('Skipping unsupported platform', { 
          id: campaign.id,
          url: campaign.link 
        });
        this.metrics.skippedCount++;
        return false;
      }

      await this.rateLimiter();

      const result = await this.retry(
        async () => {
      if (siteType === SITE_CONFIGS.CHUFFED.type) {
            return await this.processChuffedCampaign(campaign);
      } else if (siteType === SITE_CONFIGS.GOFUNDME.type) {
            return await this.processGoFundMeCampaign(campaign, browser);
          }
        },
        'CampaignProcessing',
        `Processing campaign ${campaign.id}`
      );

      const duration = this.performanceMonitor.endTimer(`campaign-${campaign.id}`);
      this.logger.debug('Campaign processing completed', {
        id: campaign.id,
        duration: `${duration}ms`,
        siteType
      });

      return result;
    } catch (error) {
      this.metrics.failureCount++;
      this.logger.error('Campaign processing failed', error, {
        id: campaign.id,
        url: campaign.link
      });
      return false;
    }
  }

  generateFailedScansReport() {
    const hasFailedScans = this.failedScans.items.length > 0;
    const has404s = this.metrics.notFoundLinks.length > 0;
    
    if (!hasFailedScans && !has404s) return '';
    
    const report = [
      '\n Failed Scans Report',
      '='.repeat(50),
      `Total Failed: ${this.failedScans.items.length}`,
      `Total 404s: ${this.metrics.notFoundLinks.length}`,
      `Combined Total: ${this.failedScans.items.length + this.metrics.notFoundLinks.length}`,
      '\nDetailed Breakdown:',
    ];
    
    // Add regular failed scans
    if (hasFailedScans) {
      report.push('\n--- Failed Scans ---');
      this.failedScans.items.forEach(item => {
        report.push(`- ID: ${item.id}\n  URL: ${item.url}\n  Reason: ${item.reason}\n  Time: ${item.timestamp}`);
      });
    }
    
    // Add 404s
    if (has404s) {
      report.push('\n--- 404 Not Found ---');
      this.metrics.notFoundLinks.forEach(link => {
        const title = link.title || `Campaign ${link.id}`;
        report.push(`- ID: ${link.id}\n  URL: ${link.url}\n  Title: ${title}\n  Reason: Campaign no longer exists (404)\n  Time: ${new Date().toISOString()}`);
      });
    }
    
    report.push('='.repeat(50));
    
    const fullReport = report.join('\n');
    
    try {
      const fileName = `failed_scans_${new Date().toISOString().split('T')[0]}.txt`;
      const timestamp = new Date().toISOString();
      
      // Check if file already exists to determine if we should append
      const fileExists = fs.existsSync(fileName);
      
      if (fileExists) {
        // Append to existing file with a separator
        const separator = `\n\n${'='.repeat(50)}\nSCAN SESSION: ${timestamp}\n${'='.repeat(50)}\n`;
        fs.appendFileSync(fileName, separator + fullReport);
        return `${fullReport}\n\nReport appended to: ${fileName}`;
      } else {
        // Create new file
        fs.writeFileSync(fileName, fullReport);
        return `${fullReport}\n\nReport saved to: ${fileName}`;
      }
    } catch (error) {
      return `${fullReport}\n\nFailed to save report: ${error.message}`;
    }
  }

  displaySummary() {
    const duration = Date.now() - this.metrics.startTime;
    const minutes = Math.floor(duration / 60000);
    const seconds = ((duration % 60000) / 1000).toFixed(1);
    
    console.log('\n' + '='.repeat(50));
    console.log('📊 Final Summary');
    console.log('='.repeat(50));
    console.log(`✅ Successful: ${this.metrics.successCount}`);
    console.log(`❌ Failed: ${this.metrics.failureCount}`);
    console.log(`⏭️ Skipped: ${this.metrics.skippedCount}`);
    console.log(`⚠️ Not Found: ${this.metrics.notFoundCount}`);
    console.log(`⏸️ Paused: ${this.metrics.pausedCount}`);
    console.log(`💰 Zero Donations: ${this.metrics.zeroDonationsCount}`);
    console.log(`️ Total Runtime: ${minutes}m ${seconds}s`);
    
    // Add 404 links if any exist
    if (this.metrics.notFoundLinks.length > 0) {
        console.log('\n404 Links:');
        this.metrics.notFoundLinks.forEach(link => {
            const title = link.title || `Campaign ${link.id}`;
            console.log(`- ID ${link.id}: ${title} \x1b[34m\x1b[4m${link.url}\x1b[0m`);
        });
    }
    
    if (this.failedScans.items.length > 0 || this.metrics.notFoundLinks.length > 0) {
        console.log(this.generateFailedScansReport());
    }
    
    console.log('='.repeat(50) + '\n');
  }

  async sendDiscordWebhook(message, color = null) {
    try {
      if (!process.env.DISCORD_WEBHOOK_URL) {
        return; // Silently return if webhook URL isn't configured
      }

      const embed = {
        description: message,
        color: color || 0x00ff00, // Default to green if no color specified
        timestamp: new Date().toISOString()
      };

      await fetch(process.env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          embeds: [embed]
        })
      });
    } catch (error) {
      console.error('Failed to send Discord webhook:', error.message);
    }
  }

  async sendScanSummaryToDiscord() {
    const duration = Date.now() - this.metrics.startTime;
    const minutes = Math.floor(duration / 60000);
    const seconds = ((duration % 60000) / 1000).toFixed(1);
    
    let summaryMessage = [
      '**📊 Scan Summary**',
      '```',
      `✅ Successful: ${this.metrics.successCount}`,
      `❌ Failed: ${this.metrics.failureCount}`,
      `⏭️ Skipped: ${this.metrics.skippedCount}`,
      `⚠️ Not Found: ${this.metrics.notFoundCount}`,
      `⏸️ Paused: ${this.metrics.pausedCount}`,
      `💰 Zero Donations: ${this.metrics.zeroDonationsCount}`,
      `⏱️ Runtime: ${minutes}m ${seconds}s`,
      '```'
    ];

    // Add 404 links if any exist
    if (this.metrics.notFoundLinks.length > 0) {
        summaryMessage.push('\n**404 Links:**');
        this.metrics.notFoundLinks.forEach(link => {
            // Use the title as the link text, fallback to ID if no title
            const linkText = link.title || `Campaign ${link.id}`;
            summaryMessage.push(` ID ${link.id}: [${linkText}](${link.url})`);
        });
    }

    // Use red color for failed scans or 404s, green for successful
    const color = (this.metrics.failureCount > 0 || this.metrics.notFoundLinks.length > 0) ? 0xff0000 : 0x00ff00;
    
    await this.sendDiscordWebhook(summaryMessage.join('\n'), color);
  }

  // Add this new method to handle cleanup
  async cleanup(exitAfter = true) {
    try {
        // Display summary and send to Discord only once
        this.displaySummary();
        await this.sendScanSummaryToDiscord();
        
        // Clean up
        console.log('🧹 Cleaning up...');
        if (global.gc) {
            global.gc();
        }
        
        if (exitAfter) {
            // Use setTimeout to ensure all async operations complete
            setTimeout(() => {
                process.exit(0);
            }, 1000);
        }
    } catch (err) {
        console.error('Error during cleanup:', err);
        if (exitAfter) {
            process.exit(1);
        }
    }
  }

  // Update the run method's finally block
  async run({ startIndex = 1, endIndex = null }) {
    let browser = null;
    let pageCount = 0;
    const MAX_PAGES_BEFORE_RESTART = 10;
    
    try {
      // Enhanced browser launch with better error handling
      browser = await this.retry(
        async () => {
          const launchedBrowser = await puppeteer.launch({
            ...SHARED_CONFIG.BROWSER_CONFIG,
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false
          });
          
          // Verify browser is working
          const page = await launchedBrowser.newPage();
          await page.close();
          
          return launchedBrowser;
        },
        'BrowserLaunch',
        'Launching browser'
      );

      this.displayLogo();
      
      const campaigns = await this.fetchCampaignUrls();
      if (!campaigns?.length) {
        await this.sendDiscordWebhook('️ No campaigns found to process', 0xffff00);
        console.log('No campaigns found to process');
        return;
      }

      const campaignsToProcess = campaigns.slice(
        startIndex - 1,
        endIndex || campaigns.length
      );

        console.log(`Found ${campaigns.length} total campaigns`);
        console.log(`Processing campaigns from #${startIndex} to #${endIndex || campaigns.length}\n`);

        for (let i = 0; i < campaignsToProcess.length; i++) {
          if (this.isShuttingDown) {
            console.log('🛑 Shutdown requested, stopping gracefully...');
            break;
          }
          
          const campaign = campaignsToProcess[i];
          const current = i + 1;
          const percentage = Math.round((current / campaignsToProcess.length) * 100);
          
          console.log(`\n--- Campaign ${current}/${campaignsToProcess.length} (${percentage}%) ---`);
          console.log(`ID: ${campaign.id} | URL: ${campaign.link}`);
          
          await this.scrapeCampaign(campaign, browser);
          
          pageCount++;
          
          // More aggressive cleanup strategy
          if (pageCount >= MAX_PAGES_BEFORE_RESTART) {
            console.log('🔄 Performing browser restart...');
            await browser.close();
            await this.delay(1000);
            browser = await puppeteer.launch(SHARED_CONFIG.BROWSER_CONFIG);
            pageCount = 0;
            
            // Force garbage collection if available
            if (global.gc) {
              global.gc();
            }
          }
        }
        
      } catch (error) {
        // Send error notification
        await this.sendDiscordWebhook(
          `❌ Error during scanning:\n\`\`\`\n${error.message}\n\`\`\``,
          0xff0000
        );
        console.error('Error during scanning:', error);
        throw error;
      } finally {
        if (browser) {
            await browser.close();
        }
        await this.cleanup(!this.isShuttingDown); // Only exit if not already shutting down
    }
  }
}

// Export statement should be at the end of the file, outside the class
export {
    FundraisingScanner,
    SCANNER_CONFIGS,
    SHARED_CONFIG,
    SITE_CONFIGS
}; 