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
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-audio',
      '--disable-notifications',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-ipc-flooding-protection',
      ...(process.platform === 'linux' ? ['--no-zygote', '--single-process'] : [])
    ],
    defaultViewport: { width: 800, height: 600 },
    ignoreHTTPSErrors: true,
    waitForInitialPage: false,
    executablePath: process.platform === 'linux' ? '/usr/bin/chromium-browser' : undefined
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
      errors: {}
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

  async retry(fn, errorType = 'default') {
    const strategy = SHARED_CONFIG.ERROR_STRATEGIES[errorType] || SHARED_CONFIG.ERROR_STRATEGIES.default;
    let lastError;
    
    for (let i = 0; i < strategy.retries; i++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        console.log(`⚠️ ${errorType} retry ${i + 1}/${strategy.retries} in ${strategy.delay}ms`);
        await this.delay(strategy.delay);
      }
    }
    throw lastError;
  }

  async rateLimiter() {
    const now = Date.now();
    const minWait = Math.floor(60000 / SHARED_CONFIG.RATE_LIMIT.requestsPerMinute);
    const elapsed = now - this.lastRequest;
    const delay = Math.max(0, minWait - elapsed);
    
    if (delay > 0) {
      await this.delay(delay);
    }
    
    this.lastRequest = Date.now();
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
      console.log('🔗 Attempting to shorten URL...');
      
      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'insomnia/2023.5.8',
          Accept: 'application/json',
          Authorization: `Bearer ${process.env.SHORTENER_BEARER_TOKEN}`
        },
        body: new URLSearchParams({
          url: url,
          domain_id: '3',
          privacy: '1',
          urls: '',
          multiple_links: '0',
          alias: '',
          space_id: ''
        })
      };

      const response = await fetch('https://gazafund.me/api/v1/links', options);
      const data = await response.json();
      
      if (data.status === 200 && data.data?.short_url) {
        console.log(`✅ URL shortened successfully: ${data.data.short_url}`);
        return data.data.short_url;
      } else {
        console.log('❌ No short URL returned from API');
        console.log('API Response:', JSON.stringify(data, null, 2));
        return null;
      }
    } catch (error) {
      console.error(`❌ Error shortening URL: ${error.message}`);
      return null;
    }
  }

  async updateCampaignData(id, target, raised, name, currency) {
    try {
      // First check if we already have a short URL
      const { data: existing, error: fetchError } = await this.supabase
        .from(this.config.tableName)
        .select('short')
        .eq('id', id)
        .single();

      if (fetchError) throw fetchError;

      // Only get new short URL if one doesn't exist
      let shortUrl = existing?.short;
      if (!shortUrl) {
        console.log('📎 No existing short URL found, generating new one...');
        const { data: campaignData } = await this.supabase
          .from(this.config.tableName)
          .select('link')
          .eq('id', id)
          .single();
          
        if (campaignData?.link) {
          shortUrl = await this.shortenUrl(campaignData.link);
        }
      } else {
        console.log(`ℹ️ Using existing short URL: ${shortUrl}`);
      }

      const { data, error } = await this.supabase
        .from(this.config.tableName)
        .update({
          target: parseInt(target) || null,
          raised: parseInt(raised) || null,
          title: name || null,
          currency: currency || null,
          short: shortUrl,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .select();

      if (error) {
        console.error(`❌ Database update error: ${error.message}`);
        throw error;
      }

      if (shortUrl) {
        console.log(`🔗 Short URL saved to database: ${shortUrl}`);
      }

      return data ? true : false;
    } catch (error) {
      console.error(`❌ Database update error: ${error.message}`);
      return false;
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
      currency: 'Not found',
      amount: 'Not found',
      raw: 'Not found'
    };

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
      raw: 'Not found'
    };
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
    try {
      const projectId = this.extractChuffedId(campaign.link);
      if (!projectId) {
        throw new Error('Invalid Chuffed URL format');
      }

      const chuffedData = await this.fetchChuffedData(projectId);
      if (!chuffedData || !chuffedData.campaign) {
        throw new Error('Failed to fetch Chuffed campaign data');
      }

      const data = chuffedData.campaign;
      const raised = (data.collected?.amount || 0) / 100;
      const target = (data.target?.amount || 0) / 100;
      const currency = data.target?.currency || 'AUD';
      const title = data.title || '';
      
      console.log(' Extracted Data:');
      console.log(`   Title: ${title || 'Not found'}`);
      console.log(`   Goal: ${target} ${currency}`);
      console.log(`   Raised: ${raised} ${currency}`);
      console.log(`   Donations: ${data.donations?.totalCount || 'Not found'}`);

      const updated = await this.updateCampaignData(
        campaign.id,
        target || null,
        raised || null,
        title,
        currency
      );

      if (updated) {
        this.metrics.successCount++;
        console.log(`✅ Success: Data updated`);
      } else {
        this.metrics.failureCount++;
        console.log(`❌ Error: Failed to update database`);
      }

      return updated;
    } catch (error) {
      this.metrics.failureCount++;
      console.error(`❌ Error processing Chuffed campaign: ${error.message}`);
      return false;
    }
  }

  async processGoFundMeCampaign(campaign, browser) {
    let page = null;
    
    try {
      page = await browser.newPage();
      
      // Initial page load with retries
      await this.retry(async () => {
        await Promise.race([
          page.goto(campaign.link, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          }),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('TimeoutError')), 30000)
          )
        ]);
      }, 'TimeoutError');

      const selectors = SITE_CONFIGS.GOFUNDME.selectors;

      // Wait for elements with retries
      await this.retry(async () => {
        const elementPromises = Object.values(selectors).map(selector =>
          page.waitForSelector(selector, { timeout: 5000 })
        );
        await Promise.all(elementPromises);
      }, 'ElementsNotFound');

      const data = await page.evaluate((selectors) => {
        const getData = (selector) => {
          const element = document.querySelector(selector);
          return {
            exists: !!element,
            text: element?.textContent?.trim() || null,
            html: element?.innerHTML?.trim() || null
          };
        };

        return {
          title: getData(selectors.title).text,
          goalText: getData(selectors.goal).text,
          raisedText: getData(selectors.raised).html || getData(selectors.raised).text,
          supportersCount: getData(selectors.supporters).text
        };
      }, selectors);

      const raisedData = this.parseRaisedAmount(data.raisedText);
      const targetData = this.parseTargetAmount(data.goalText);
      const supportersCount = this.parseGoFundMeSupporters(data.supportersCount);

      console.log(' Extracted Data:');
      console.log(`   Title: ${data.title || 'Not found'}`);
      console.log(`   Goal: ${targetData.amount} ${targetData.currency}`);
      console.log(`   Raised: ${raisedData.amount} ${raisedData.currency}`);
      console.log(`   Donations: ${supportersCount || 'Not found'}`);

      const updated = await this.updateCampaignData(
        campaign.id,
        targetData.amount === 'Not found' ? null : targetData.amount,
        raisedData.amount === 'Not found' ? null : raisedData.amount,
        data.title,
        raisedData.currency === 'Not found' ? null : raisedData.currency
      );

      if (updated) {
        this.metrics.successCount++;
        console.log(`✅ Success: Data updated`);
      } else {
        this.metrics.failureCount++;
        console.log(`❌ Error: Failed to update database`);
      }

      return updated;
    } catch (error) {
      this.metrics.failureCount++;
      console.error(`❌ Error processing GoFundMe campaign: ${error.message}`);
      return false;
    } finally {
      if (page) await page.close();
    }
  }

  async scrapeCampaign(campaign, browser) {
    try {
      if (!campaign.link) {
        this.metrics.skippedCount++;
        console.log(`⏭️ Skipped: Invalid URL`);
        return false;
      }

      const siteType = this.detectSiteType(campaign.link);
      if (!siteType) {
        this.metrics.skippedCount++;
        console.log(`⏭️ Skipped: Unsupported platform URL`);
        return false;
      }

      await this.rateLimiter();

      if (siteType === SITE_CONFIGS.CHUFFED.type) {
        return this.processChuffedCampaign(campaign);
      } else if (siteType === SITE_CONFIGS.GOFUNDME.type) {
        return this.processGoFundMeCampaign(campaign, browser);
      }

      return false;
    } catch (error) {
      this.metrics.failureCount++;
      console.error(`❌ Error processing campaign: ${error.message}`);
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
    console.log(`���️ Total Runtime: ${minutes}m ${seconds}s`);
    
    if (this.failedScans.items.length > 0) {
      console.log(this.generateFailedScansReport());
    }
    
    console.log('='.repeat(50) + '\n');
  }

  async run({ startIndex = 1, endIndex = null }) {
    try {
      this.displayLogo();
      
      const campaigns = await this.fetchCampaignUrls();
      if (!campaigns?.length) {
        console.log('No campaigns found to process');
        return;
      }

      const campaignsToProcess = campaigns.slice(
        startIndex - 1,
        endIndex || campaigns.length
      );

      console.log(`Found ${campaigns.length} total campaigns`);
      console.log(`Processing campaigns from #${startIndex} to #${endIndex || campaigns.length}\n`);

      const browser = await puppeteer.launch(SHARED_CONFIG.BROWSER_CONFIG);
      
      try {
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
          
          // Periodic cleanup
          if (i % 10 === 0 && global.gc) {
            global.gc();
          }
        }
      } finally {
        await browser.close();
      }
      
      this.displaySummary();
      
    } catch (error) {
      console.error('Error during scanning:', error);
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