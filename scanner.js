import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import cliProgress from 'cli-progress';
import figlet from 'figlet';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import fs from 'fs';

// Configure dotenv
dotenv.config();

// Function to detect browser executable
const detectBrowserExecutable = () => {
  if (process.platform !== 'linux') return undefined;
  
  const paths = [
    '/usr/bin/chromium',           // Debian/Ubuntu
    '/usr/bin/chromium-browser',   // Ubuntu/Debian alternative
    '/usr/bin/google-chrome',      // Chrome fallback
    '/snap/bin/chromium',          // Snap package
  ];
  
  const foundPath = paths.find(path => fs.existsSync(path));
  if (!foundPath) {
    console.warn('⚠️ No Chromium/Chrome executable found. Please install chromium-browser or google-chrome');
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
      '--disable-features=site-per-process',
      '--js-flags="--max-old-space-size=2048"',
      '--single-process',
      '--disable-javascript-harmony-shipping',
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
      ] : [
        '--disable-d3d11'
      ])
    ],
    defaultViewport: { width: 800, height: 600 },
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
      process.env.SUPABASE_ANON_KEY
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
      responseTimesMs: [],
      errors: {},
      memoryUsage: [],
      browserCrashes: 0,
      avgResponseTime: 0
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
      
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      console.log('👋 Shutdown complete');
      process.exit(0);
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

  async shortenUrl(url) {
    try {
      this.logger.debug(`    ├─ Calling shortener API...`);
      
      const options = {
        method: 'POST',
        url: 'https://gazafund.me/api/v1/links',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'insomnia/2023.5.8',
          'Accept': 'application/json',
          'Authorization': `Bearer ${process.env.SHORTENER_BEARER_TOKEN}`
        },
        data: new URLSearchParams({
          url: url,
          domain_id: '3',
          privacy: '1',
          urls: '',
          multiple_links: '0',
          alias: '',
          space_id: ''
        }).toString()
      };

      const response = await axios(options);

      // Accept both 200 and 201 as valid response codes
      if ((response.status === 200 || response.status === 201) && response.data?.data) {
        const shortUrl = response.data.data.short_url || response.data.data.shortUrl;
        if (shortUrl) {
          this.logger.debug(`    └─✨ Created ${shortUrl} (-${url.length - shortUrl.length} chars)`);
          return shortUrl;
        }
      }
      
      this.logger.warn(`    └─⚠️ No short URL in response`, {
        status: response.status,
        data: JSON.stringify(response.data, null, 2)
      });
      return null;

    } catch (error) {
      this.logger.warn(`    └─❌ API error: ${error.message}`, {
        error: error.response?.data || error.message
      });
      return null;
    }
  }

  async updateCampaignData(id, target, raised, name, currency) {
    const maxRetries = 3;
    let attempt = 0;
    
    while (attempt < maxRetries) {
      try {
        // Check for existing short URL
        const { data: existing } = await this.supabase
          .from(this.config.tableName)
          .select('short, link')
          .eq('id', id)
          .single();

        let shortUrl = existing?.short;
        if (!shortUrl && existing?.link) {
          this.logger.debug(`  ├─🔗 No cached short URL found`);
          shortUrl = await this.shortenUrl(existing.link);
        } else if (shortUrl) {
          this.logger.debug(`  ├─♻️ Using cached: ${shortUrl}`);
        }

        this.logger.debug(`  ├─💾 Saving to database...`);
        const { error } = await this.supabase
          .from(this.config.tableName)
          .update({
            target: parseInt(target) || null,
            raised: parseInt(raised) || null,
            title: name || null,
            currency: currency || null,
            short: shortUrl,
            updated_at: new Date().toISOString()
          })
          .eq('id', id);

        if (error) throw error;

        this.logger.debug(`  └─✅ Updated${shortUrl ? ` with ${shortUrl}` : ''}`);
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

    // Sanitize input
    text = text.toString().trim();
    
    try {
      // First, try to match the GoFundMe specific HTML format
      const gfmMatch = text.match(
        /<span[^>]*>([\d,. ]+)<\/span>\s*<span[^>]*>([A-Z]{3}|[Kk][Rr]?)\s*<\/span>/i
      );

      if (gfmMatch) {
        const amount = gfmMatch[1].replace(/[,\s]/g, '');
        const rawCurrency = gfmMatch[2].trim().toUpperCase();
        return {
          currency: SHARED_CONFIG.CURRENCY_MAPPING[rawCurrency] || rawCurrency,
          amount: amount,
          raw: gfmMatch[0]
        };
      }

      // Then try to match post-amount currencies
      const postAmountMatch = text.match(
        /([\d,. ]+)\s*([A-Z]{3}|[Kk][Rr]?)\b/i
      );

      if (postAmountMatch) {
        const amount = postAmountMatch[1].replace(/[,\s]/g, '');
        const rawCurrency = postAmountMatch[2].trim().toUpperCase();
        return {
          currency: SHARED_CONFIG.CURRENCY_MAPPING[rawCurrency] || rawCurrency,
          amount: amount,
          raw: postAmountMatch[0]
        };
      }

      // Finally, try to match pre-amount currencies
      const preAmountMatch = text.match(
        /([€$£¥₹₽₪₱₩R$]|[Kk]r\.?|EUR|USD|GBP)\s*([\d,.]+)/i
      );

      if (preAmountMatch) {
        const amount = preAmountMatch[2].replace(/[,\s]/g, '');
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
        raw: text // Return original text for debugging
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
    const kSuffixMatch = text.match(/([€$£¥₹₽₪₱₩R$]|[Kk]r\.?|EUR|USD|GBP)?\s*([\d,. ]+)[kK]\b/i);
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
    const match = url.match(/chuffed\.org\/project\/(\d+)/);
    return match ? match[1] : null;
  }

  async fetchChuffedData(projectId) {
    try {
      const response = await axios.post(SITE_CONFIGS.CHUFFED.api.endpoint, [{
        operationName: 'getCampaign',
        variables: { id: parseInt(projectId) },
        query: SITE_CONFIGS.CHUFFED.api.query
      }], {
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
        }
      });

      if (!response.data || !response.data[0]?.data) {
        throw new Error('Invalid response structure from Chuffed API');
      }

      return response.data[0]?.data;
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
          const currency = data.target?.currency || 'AUD';
          const title = data.title || '';

          this.logger.info(`└─📊 ${title.substring(0, 40)}${title.length > 40 ? '...' : ''}`);
          this.logger.info(`  ├─💰 ${raised} ${currency} of ${target} ${currency}`);
          this.logger.info(`  └─👥 ${data.donations?.totalCount || 0} donations`);

          const updated = await this.updateCampaignData(
            campaign.id, target || null, raised || null, title, currency
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
          const supporters = this.parseGoFundMeSupporters(data.supportersText);

          // Log the extracted data
          this.logger.info(`└─📊 ${data.title.substring(0, 40)}${data.title.length > 40 ? '...' : ''}`);
          this.logger.info(`  ├─💰 ${raised.amount} ${raised.currency} of ${goal.amount} ${goal.currency}`);
          this.logger.info(`  └─👥 ${supporters || 0} donations`);

          // Update database
          const updated = await this.updateCampaignData(
            campaign.id, 
            goal.amount, 
            raised.amount, 
            data.title, 
            raised.currency
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
    if (this.failedScans.items.length === 0) return '';
    
    const report = [
      '\n Failed Scans Report',
      '='.repeat(50),
      `Total Failed: ${this.failedScans.items.length}`,
      '\nDetailed Breakdown:',
      ...this.failedScans.items.map(item => (
        `- ID: ${item.id}\n  URL: ${item.url}\n  Reason: ${item.reason}\n  Time: ${item.timestamp}`
      )),
      '='.repeat(50),
    ].join('\n');
    
    try {
      const fileName = `failed_scans_${new Date().toISOString().split('T')[0]}.txt`;
      fs.writeFileSync(fileName, report);
      return `${report}\n\nReport saved to: ${fileName}`;
    } catch (error) {
      return `${report}\n\nFailed to save report: ${error.message}`;
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
    console.log(`️ Total Runtime: ${minutes}m ${seconds}s`);
    
    if (this.failedScans.items.length > 0) {
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

      await axios.post(process.env.DISCORD_WEBHOOK_URL, {
        embeds: [embed]
      });
    } catch (error) {
      console.error('Failed to send Discord webhook:', error.message);
    }
  }

  async sendScanSummaryToDiscord() {
    const duration = Date.now() - this.metrics.startTime;
    const minutes = Math.floor(duration / 60000);
    const seconds = ((duration % 60000) / 1000).toFixed(1);
    
    const summaryMessage = [
      '**📊 Scan Summary**',
      '```',
      `✅ Successful: ${this.metrics.successCount}`,
      `❌ Failed: ${this.metrics.failureCount}`,
      `⏭️ Skipped: ${this.metrics.skippedCount}`,
      `⚠️ Not Found: ${this.metrics.notFoundCount}`,
      `⏱️ Runtime: ${minutes}m ${seconds}s`,
      '```'
    ].join('\n');

    // Use red color for failed scans, green for successful
    const color = this.metrics.failureCount > 0 ? 0xff0000 : 0x00ff00;
    
    await this.sendDiscordWebhook(summaryMessage, color);
  }

  async run({ startIndex = 1, endIndex = null }) {
    let browser = null;
    let pageCount = 0;
    const MAX_PAGES_BEFORE_RESTART = 25; // Reduced from previous values
    
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

      try {
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
            try {
              await browser.close();
            } catch (err) {
              console.error('Error closing browser:', err);
            }
          }
          this.displaySummary();
          // Send final summary to Discord
          await this.sendScanSummaryToDiscord();
        }
      } catch (error) {
        // Send critical error notification
        await this.sendDiscordWebhook(
          `💥 Critical error:\n\`\`\`\n${error.message}\n\`\`\``,
          0xff0000
        );
        throw error;
      }
    }
  }

  // Export the scanner and configurations
  export {
    FundraisingScanner,
    SCANNER_CONFIGS,
    SHARED_CONFIG,
    SITE_CONFIGS
  }; 