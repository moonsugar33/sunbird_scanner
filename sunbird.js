import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import cliProgress from 'cli-progress';
import figlet from 'figlet';
import rateLimit from 'express-rate-limit';
import axios from 'axios';

// Configure dotenv
dotenv.config();

// Get current file's directory (needed for ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Define currency mapping at the top level
const CURRENCY_MAPPING = {
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
  
  // Nordic currencies (typically appearing after amount)
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
};

// Add currency symbol mapping near the top with other constants
const CURRENCY_SYMBOLS = {
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
};

// Add near the top with other constants
const RATE_LIMIT = {
  requestsPerMinute: 30,
  minDelay: 5000,
  maxDelay: 20000
};

// Add near other constants (like CURRENCY_MAPPING)
const ERROR_STRATEGIES = {
  'TimeoutError': { retries: 3, delay: 5000 },
  'NetworkError': { retries: 3, delay: 3000 },
  'ElementsNotFound': { retries: 3, delay: 2000 },
  'default': { retries: 2, delay: 2000 }
};

// Add near other constants
const SITE_TYPES = {
  GOFUNDME: 'gofundme',
  CHUFFED: 'chuffed'
};

const SELECTORS = {
  [SITE_TYPES.GOFUNDME]: {
    title: 'h1.p-campaign-title',
    raised: '.progress-meter_progressBarHeading__Nxc77',
    goal: '.progress-meter_circleGoalDonations__5gSh1',
    supporters: '.progress-meter_circleGoalDonations__5gSh1'
  },
  [SITE_TYPES.CHUFFED]: {
    title: 'h1.campaign-container__title',
    raised: '[data-testid="progress-meter-raised"]',
    goal: '[data-testid="progress-meter-target"]',
    supporters: '.campaign-container__share-values h3'
  }
};

// Add near the top with other constants
const BATCH_SIZE = 5; // Number of concurrent processes
const BROWSER_CONFIG = {
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
    '--disable-ipc-flooding-protection'
  ],
  defaultViewport: { width: 800, height: 600 },
  ignoreHTTPSErrors: true,
  waitForInitialPage: false
};

// Update the rate limiter to be a simpler but effective implementation
const rateLimiter = (() => {
  let lastRequest = Date.now();
  const minWait = Math.floor(60000 / RATE_LIMIT.requestsPerMinute); // Minimum time between requests
  
  return async () => {
    const now = Date.now();
    const elapsed = now - lastRequest;
    const delay = Math.max(0, minWait - elapsed);
    
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    lastRequest = Date.now();
  };
})();

// Add browser pool management
const browserPool = {
  instances: [],
  maxInstances: BATCH_SIZE,
  
  async getInstance() {
    // Reuse existing instance if available
    const availableInstance = this.instances.find(i => !i.inUse);
    if (availableInstance) {
      availableInstance.inUse = true;
      return availableInstance;
    }
    
    // Create new instance if under limit
    if (this.instances.length < this.maxInstances) {
      const browser = await puppeteer.launch(BROWSER_CONFIG);
      const instance = { browser, inUse: true };
      this.instances.push(instance);
      return instance;
    }
    
    // Wait for an instance to become available
    return new Promise(resolve => {
      const checkInterval = setInterval(() => {
        const instance = this.instances.find(i => !i.inUse);
        if (instance) {
          clearInterval(checkInterval);
          instance.inUse = true;
          resolve(instance);
        }
      }, 100);
    });
  },
  
  releaseInstance(instance) {
    instance.inUse = false;
  },
  
  async cleanup() {
    await Promise.all(this.instances.map(async i => {
      try {
        await i.browser.close();
      } catch (error) {
        console.error('Error closing browser:', error);
      }
    }));
    this.instances = [];
  }
};

// Helper functions
async function fetchCampaignUrls() {
  try {
    const { data, error } = await supabase
      .from('sunbird')
      .select('id, link')
      .order('id', { ascending: true });

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error fetching URLs from Supabase:', error);
    return [];
  }
}

async function updateCampaignData(id, target, raised, name, currency) {
  try {
    const { data, error } = await supabase
      .from('sunbird')
      .update({
        target: parseInt(target) || null,
        raised: parseInt(raised) || null,
        title: name || null,
        currency: currency || null,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select();

    if (error) {
      console.error('Database update failed:', error.message);
      return false;
    }

    return data ? true : false;
  } catch (error) {
    console.error('Database update error:', error.message);
    return false;
  }
}

// Amount parsing functions
const parseRaisedAmount = (text) => {
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
      currency: CURRENCY_MAPPING[rawCurrency] || rawCurrency,
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
      currency: CURRENCY_MAPPING[rawCurrency] || rawCurrency,
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
      currency: CURRENCY_MAPPING[rawCurrency] || rawCurrency,
      amount: amount,
      raw: preAmountMatch[0]
    };
  }

  return {
    currency: 'Not found',
    amount: 'Not found',
    raw: 'Not found'
  };
};

const parseTargetAmount = (text) => {
  if (!text) return {
    currency: 'Not found',
    amount: 'Not found',
    raw: 'Not found'
  };

  // Remove extra text like "target·75 donations"
  text = text.split('·')[0].trim();

  // Helper function to normalize amount with K suffix
  const normalizeAmount = (amount, hasK = false) => {
    amount = amount.replace(/[,\s]/g, '');
    const numAmount = parseFloat(amount);
    return hasK ? (numAmount * 1000).toString() : amount;
  };

  // Handle K suffix for thousands (now checking for k/K at the end of number)
  const kSuffixMatch = text.match(/([€$£¥₹₽₪₱₩R$]|[Kk]r\.?|EUR|USD|GBP)?\s*([\d,. ]+)[kK]\b/i);
  if (kSuffixMatch) {
    const amount = normalizeAmount(kSuffixMatch[2], true);
    const rawCurrency = kSuffixMatch[1]?.trim().toUpperCase() || 'EUR';
    return {
      currency: CURRENCY_MAPPING[rawCurrency] || rawCurrency,
      amount: amount,
      raw: text
    };
  }

  // First, try to match the GoFundMe specific HTML format
  const gfmMatch = text.match(
    /<span[^>]*>([\d,. ]+)[kK]?\s*<\/span>\s*<span[^>]*>([A-Z]{3}|[Kk][Rr]?)\s*<\/span>/i
  );

  if (gfmMatch) {
    const hasK = gfmMatch[1].toLowerCase().endsWith('k');
    const amount = normalizeAmount(gfmMatch[1].replace(/[kK]$/, ''), hasK);
    const rawCurrency = gfmMatch[2].trim().toUpperCase();
    return {
      currency: CURRENCY_MAPPING[rawCurrency] || rawCurrency,
      amount: amount,
      raw: gfmMatch[0]
    };
  }

  // Then try to match post-amount currencies
  const postAmountMatch = text.match(
    /([\d,. ]+)[kK]?\s*([A-Z]{3}|[Kk][Rr]?)\b/i
  );

  if (postAmountMatch) {
    const hasK = postAmountMatch[1].toLowerCase().endsWith('k');
    const amount = normalizeAmount(postAmountMatch[1].replace(/[kK]$/, ''), hasK);
    const rawCurrency = postAmountMatch[2].trim().toUpperCase();
    return {
      currency: CURRENCY_MAPPING[rawCurrency] || rawCurrency,
      amount: amount,
      raw: postAmountMatch[0]
    };
  }

  // Finally, try to match pre-amount currencies
  const preAmountMatch = text.match(
    /([€$£¥₹₽₪₱₩R$]|[Kk]r\.?|EUR|USD|GBP)\s*([\d,.]+)[kK]?\b/i
  );

  if (preAmountMatch) {
    const hasK = preAmountMatch[2].toLowerCase().endsWith('k');
    const amount = normalizeAmount(preAmountMatch[2].replace(/[kK]$/, ''), hasK);
    const rawCurrency = preAmountMatch[1].trim().toUpperCase();
    return {
      currency: CURRENCY_MAPPING[rawCurrency] || rawCurrency,
      amount: amount,
      raw: preAmountMatch[0]
    };
  }

  return {
    currency: 'Not found',
    amount: 'Not found',
    raw: 'Not found'
  };
};

// Add this helper function for console clearing
function clearLastLines(count) {
  process.stdout.write(`\x1b[${count}A\x1b[0J`);
}

// Add near other helper functions
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Enhance the retry function
async function retry(fn, errorType = 'default') {
  const strategy = ERROR_STRATEGIES[errorType] || ERROR_STRATEGIES.default;
  let lastError;
  
  for (let i = 0; i < strategy.retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.log(`⚠️ ${errorType} retry ${i + 1}/${strategy.retries} in ${strategy.delay}ms`);
      await delay(strategy.delay);
    }
  }
  throw lastError;
}

// Enhance the metrics object
const metrics = {
  startTime: null,
  successCount: 0,
  failureCount: 0,
  avgProcessingTime: 0,
  memoryUsage: [],
  responseTimesMs: [],
  errors: {},
  
  recordError(error) {
    const errorType = error.name || 'Unknown';
    this.errors[errorType] = (this.errors[errorType] || 0) + 1;
  },
  
  recordResponseTime(ms) {
    this.responseTimesMs.push(ms);
  },
  
  getSummary() {
    return {
      runtime: Date.now() - this.startTime,
      successRate: (this.successCount / (this.successCount + this.failureCount)) * 100,
      avgResponseTime: this.responseTimesMs.reduce((a, b) => a + b, 0) / this.responseTimesMs.length,
      errorBreakdown: this.errors,
      peakMemoryUsage: Math.max(...this.memoryUsage)
    };
  }
};

// Add this helper function
function detectSiteType(url) {
  if (!url) return null;
  
  if (url.includes('gofundme.com')) return SITE_TYPES.GOFUNDME;
  if (url.includes('chuffed.org')) return SITE_TYPES.CHUFFED;
  
  return null;
}

// Add Chuffed-specific amount parsing function
const parseChuffedAmount = (text) => {
  if (!text) return {
    currency: 'Not found',
    amount: 'Not found',
    raw: 'Not found'
  };

  // Remove any "Raised of" prefix
  text = text.replace('Raised of', '').trim();
  
  // If we have HTML, extract the text from inside the span
  if (text.includes('<span>')) {
    const spanMatch = text.match(/<span>(.*?)<\/span>/);
    if (spanMatch) {
      text = spanMatch[1].replace(/&nbsp;/g, ' ').trim();
    }
  }
  
  // Match amount and currency (Chuffed format: "190 €" or "50 000 €")
  const match = text.match(/([\d\s,.]+)\s*([A-Z€£$]{1,3})/i);
  
  if (match) {
    // Remove spaces and normalize amount
    const amount = match[1].replace(/[\s,]/g, '');
    const rawCurrency = match[2].trim();
    
    return {
      currency: CURRENCY_MAPPING[rawCurrency] || rawCurrency,
      amount: amount,
      raw: text
    };
  }

  return {
    currency: 'Not found',
    amount: 'Not found',
    raw: 'Not found'
  };
};

// Add a delay helper specifically for animations
const waitForAnimation = async (page, selector, timeout = 5000) => {
  const startTime = Date.now();
  let lastValue = null;
  
  // Keep checking until the value stabilizes
  while (Date.now() - startTime < timeout) {
    const currentValue = await page.$eval(selector, el => el.textContent);
    if (currentValue === lastValue) {
      return true; // Value has stabilized
    }
    lastValue = currentValue;
    await delay(100); // Check every 100ms
  }
  return false; // Timeout reached
};

// Helper function to parse GoFundMe supporters
const parseGoFundMeSupporters = (text) => {
  if (!text) return null;

  // Match the number and check for K/k suffix, allow for both donation/donations
  const match = text.match(/([\d,.]+)(K|k)?\s*donation[s]?/i);
  if (match) {
    // Remove commas and convert to float
    const number = parseFloat(match[1].replace(/,/g, ''));
    // Check if K/k suffix exists
    const hasKSuffix = match[2]?.toLowerCase() === 'k';
    
    // Return the appropriate number
    return hasKSuffix ? Math.round(number * 1000) : Math.round(number);
  }
  return null;
};

// Function to extract the project ID from a Chuffed URL
function extractChuffedId(url) {
  const match = url.match(/chuffed\.org\/project\/(\d+)/);
  return match ? match[1] : null;
}

// Function to fetch data from the Chuffed API
async function fetchChuffedData(projectId) {
  try {
    const response = await axios.post('https://chuffed.org/api/graphql', [{
      operationName: 'getCampaign',
      variables: { id: parseInt(projectId) },
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

// Add near the top
let browserInstance = null;

// Main scraping function
async function scrapeCampaign(row, browser) {
  await rateLimiter();
  let page = null;

  try {
    if (!row.link) {
      throw new Error('Invalid URL provided');
    }

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Overall scraping timeout')), 120000);
    });

    const scrapingPromise = async () => {
      const siteType = detectSiteType(row.link);
      if (!siteType) {
        console.log(`⏭️ Skipped: Unsupported platform URL`);
        return false;
      }

      // Handle Chuffed via API
      if (siteType === SITE_TYPES.CHUFFED) {
        const projectId = extractChuffedId(row.link);
        if (!projectId) {
          throw new Error('Invalid Chuffed URL format');
        }

        const chuffedData = await fetchChuffedData(projectId);
        if (!chuffedData || !chuffedData.campaign) {
          throw new Error('Failed to fetch Chuffed campaign data');
        }

        const campaign = chuffedData.campaign;
        const raised = (campaign.collected?.amount || 0) / 100;
        const target = (campaign.target?.amount || 0) / 100;
        const currency = campaign.target?.currency || 'AUD';
        const title = campaign.title || '';
        
        console.log(' Extracted Data:');
        console.log(`   Title: ${title || 'Not found'}`);
        console.log(`   Goal: ${target} ${currency}`);
        console.log(`   Raised: ${raised} ${currency}`);
        console.log(`   Donations: ${campaign.donations?.totalCount || 'Not found'}`);

        const updated = await updateCampaignData(
          row.id,
          target || null,
          raised || null,
          title,
          currency
        );

        if (!updated) {
          throw new Error('Database update failed - no changes were made');
        }

        return true;
      }

      // Existing GoFundMe handling...
      if (siteType === SITE_TYPES.GOFUNDME) {
        page = await browser.newPage();
        
        try {
          // Initial page load attempt with shorter timeout
          try {
            await Promise.race([
              page.goto(row.link, {
                waitUntil: 'domcontentloaded',
                timeout: 15000  // Shorter initial timeout
              }),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('TimeoutError')), 15000)
              )
            ]);
          } catch (error) {
            // If initial fast attempt fails, then try with retries
            await retry(async () => {
              await Promise.race([
                page.goto(row.link, {
                  waitUntil: 'domcontentloaded',
                  timeout: 30000
                }),
                new Promise((_, reject) => 
                  setTimeout(() => reject(new Error('TimeoutError')), 30000)
                )
              ]);
            }, 'TimeoutError');
          }

          const selectors = SELECTORS[siteType];

          // Initial quick element check
          try {
            const elementPromises = Object.entries(selectors).map(async ([key, selector]) => {
              try {
                await page.waitForSelector(selector, { timeout: 2000 });  // Shorter initial timeout
                return true;
              } catch {
                return false;
              }
            });

            const elementResults = await Promise.all(elementPromises);
            if (!elementResults.some(result => result)) {
              throw new Error('ElementsNotFound');
            }
          } catch (error) {
            // If quick check fails, then try with retries
            await retry(async () => {
              const elementPromises = Object.entries(selectors).map(async ([key, selector]) => {
                try {
                  await page.waitForSelector(selector, { timeout: 5000 });
                  return true;
                } catch {
                  return false;
                }
              });

              const elementResults = await Promise.all(elementPromises);
              if (!elementResults.some(result => result)) {
                throw new Error('ElementsNotFound');
              }
              return true;
            }, 'ElementsNotFound');
          }

          const data = await page.evaluate((selectors) => {
            const getData = (selector) => {
              const element = document.querySelector(selector);
              return {
                exists: !!element,
                text: element?.textContent?.trim() || null,
                html: element?.innerHTML?.trim() || null
              };
            };

            const title = getData(selectors.title);
            const raised = getData(selectors.raised);
            const goal = getData(selectors.goal);
            const supporters = getData(selectors.supporters);

            return {
              title: title.text,
              goalText: goal.text,
              raisedText: raised.html || raised.text,
              supportersCount: supporters.text,
              elementStatus: {
                title: title.exists,
                raised: raised.exists,
                goal: goal.exists,
                supporters: supporters?.exists
              }
            };
          }, selectors);

          const raisedData = parseRaisedAmount(data.raisedText);
          const targetData = parseTargetAmount(data.goalText);
          const supportersCount = parseGoFundMeSupporters(data.supportersCount);

          console.log(' Extracted Data:');
          console.log(`   Title: ${data.title || 'Not found'}`);
          console.log(`   Goal: ${targetData.amount} ${targetData.currency}`);
          console.log(`   Raised: ${raisedData.amount} ${raisedData.currency}`);
          console.log(`   Donations: ${supportersCount || 'Not found'}`);

          const updated = await updateCampaignData(
            row.id,
            targetData.amount === 'Not found' ? null : targetData.amount,
            raisedData.amount === 'Not found' ? null : raisedData.amount,
            data.title,
            raisedData.currency === 'Not found' ? null : raisedData.currency
          );

          if (!updated) {
            throw new Error('Database update failed - no changes were made');
          }

          return true;
        } catch (error) {
          throw new Error(`Failed to load page after retries: ${error.message}`);
        } finally {
          if (page) await page.close();
        }
      }

      return false;
    };

    return await Promise.race([scrapingPromise(), timeoutPromise]);

  } catch (error) {
    if (!error.message.includes('retry')) {
      console.error(`❌ Error processing campaign: ${error.message}`);
    }
    return false;
  }
}

// Add this helper function near the top with other helper functions
function setTerminalTitle(title) {
  process.stdout.write(`\x1b]0;${title}\x1b\\`);
}

// Modify the displayLogo function
function displayLogo() {
    console.clear();
    setTerminalTitle('Sunbird Scanner - Running');
    console.log(
        figlet.textSync('Sunbird Scanner', {
            font: 'Standard',
            horizontalLayout: 'default',
            verticalLayout: 'default'
        })
    );
    console.log('\n');
}

// Update the main process function to use a single optimized runner
async function processAllCampaigns() {
  try {
    displayLogo();
    
    const campaigns = await fetchCampaignUrls();
    if (!campaigns?.length) {
      console.log('No campaigns found to process');
      return;
    }

    // Process command line arguments
    const args = process.argv.slice(2);
    const startIndex = args.indexOf('--start') !== -1 ? 
      parseInt(args[args.indexOf('--start') + 1]) : 1;
    const endIndex = args.indexOf('--end') !== -1 ? 
      parseInt(args[args.indexOf('--end') + 1]) : campaigns.length;
    
    const campaignsToProcess = campaigns.slice(startIndex - 1, endIndex);
    const totalToProcess = campaignsToProcess.length;

    console.log(`Found ${campaigns.length} total campaigns`);
    console.log(`Processing campaigns from #${startIndex} to #${endIndex}\n`);

    const stats = { success: 0, notFound: 0, failed: 0, skipped: 0 };
    
    // Initialize a single browser instance
    const browser = await puppeteer.launch(BROWSER_CONFIG);
    
    try {
      for (let i = 0; i < campaignsToProcess.length; i++) {
        if (isShuttingDown) {
          console.log('🛑 Shutdown requested, stopping gracefully...');
          break;
        }
        
        const campaign = campaignsToProcess[i];
        const current = i + 1;
        
        await processCampaign(campaign, current, totalToProcess, stats, browser);
        
        // Periodic cleanup
        if (i % 10 === 0) { // Every 10 campaigns
          cleanupMemory();
        }
      }
      
      // Display final summary
      console.log('\n' + '='.repeat(50));
      console.log('📊 Final Summary');
      console.log('='.repeat(50));
      console.log(`✅ Successful: ${stats.success}`);
      console.log(`⚠️ Not Found: ${stats.notFound}`);
      console.log(`❌ Failed: ${stats.failed}`);
      console.log(`⏭️ Skipped: ${stats.skipped}`);
      console.log('='.repeat(50) + '\n');
      
    } finally {
      await browser.close();
    }
    
  } catch (error) {
    console.error('\n❌ Fatal Error:', error);
  }
}

// Update the campaign processing function to use the shared browser instance
async function processCampaign(campaign, current, total, stats, browser) {
  const percentage = Math.round((current / total) * 100);
  console.log(`\n--- Campaign ${current}/${total} (${percentage}%) ---`);
  console.log(`ID: ${campaign.id} | URL: ${campaign.link}`);

  const campaignStartTime = Date.now();
  
  try {
    if (!campaign.link) throw new Error('Invalid or empty URL');

    const siteType = detectSiteType(campaign.link);
    if (!siteType) {
      stats.skipped++;
      console.log(`⏭️ Skipped: Not a supported platform URL`);
      return;
    }

    await rateLimiter();
    console.log(`⏳ Processing...`);

    const result = await scrapeCampaign(campaign, browser);
    
    if (result) {
      stats.success++;
      console.log(`✅ Success: Data updated`);
    } else {
      if (campaign.link.includes('Not found')) {
        stats.notFound++;
        console.log(`⚠️ Warning: Campaign not found`);
      } else {
        stats.failed++;
        failedCampaigns.push({
          id: campaign.id,
          url: campaign.link,
          reason: 'Processing failed'
        });
        console.log(`❌ Error: Failed to process campaign`);
      }
    }
  } catch (error) {
    stats.failed++;
    failedCampaigns.push({
      id: campaign.id,
      url: campaign.link,
      reason: error.message
    });
    console.log(`❌ Error: ${error.message}`);
  } finally {
    const duration = Date.now() - campaignStartTime;
    timingData.recordCampaignTime(campaign.id, duration);
  }
}

// Add near the top of the file
let isShuttingDown = false;

// Also update the shutdown handler to change the title
process.on('SIGINT', async () => {
  console.log('\n\n🛑 Graceful shutdown initiated...');
  setTerminalTitle('Sunbird Scanner - Shutting down');
  isShuttingDown = true;
  
  // Wait for current operation to complete
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  console.log('👋 Shutdown complete');
  process.exit(0);
});

// Add periodic garbage collection
if (global.gc) {
  setInterval(() => {
    global.gc();
  }, 30000);
}

// Add near other helper functions
function cleanupMemory() {
  if (global.gc) {
    global.gc();
  }
  
  // Clear response time history periodically
  if (metrics.responseTimesMs.length > 1000) {
    metrics.responseTimesMs = metrics.responseTimesMs.slice(-100);
  }
}

// Add to scrapeCampaign after each successful scrape
await cleanupMemory();

// Add near the top with other constants and global variables
const failedCampaigns = [];
const timingData = {
  startTime: null,
  campaignTimes: [],
  
  start() {
    this.startTime = Date.now();
  },
  
  recordCampaignTime(id, duration) {
    this.campaignTimes.push({ id, duration });
  },
  
  getSummary() {
    const totalDuration = Date.now() - this.startTime;
    const avgDuration = this.campaignTimes.length > 0 
      ? this.campaignTimes.reduce((acc, curr) => acc + curr.duration, 0) / this.campaignTimes.length 
      : 0;
    
    return {
      totalRuntime: `${(totalDuration / 1000 / 60).toFixed(2)} minutes`,
      averagePerCampaign: `${(avgDuration / 1000).toFixed(2)} seconds`,
      slowestCampaign: this.campaignTimes.length > 0 
        ? Math.max(...this.campaignTimes.map(t => t.duration)) / 1000 
        : 0,
      fastestCampaign: this.campaignTimes.length > 0 
        ? Math.min(...this.campaignTimes.map(t => t.duration)) / 1000 
        : 0
    };
  }
};

// Execute the main process
processAllCampaigns()
  .then(() => {
    console.log('Scraping complete');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });