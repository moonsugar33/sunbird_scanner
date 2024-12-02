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
  requestsPerMinute: 20,
  minDelay: 1000,
  maxDelay: 3000
};

// Add near other constants (like CURRENCY_MAPPING)
const ERROR_STRATEGIES = {
  'TimeoutError': { retries: 3, delay: 5000 },
  'NetworkError': { retries: 5, delay: 3000 },
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

// Replace the existing delay in scrapeGoFundMe
const rateLimiter = (() => {
  let lastRequest = Date.now();
  return async () => {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequest;
    const minWait = (60000 / RATE_LIMIT.requestsPerMinute);
    const randomDelay = Math.floor(Math.random() * (RATE_LIMIT.maxDelay - RATE_LIMIT.minDelay) + RATE_LIMIT.minDelay);
    const waitTime = Math.max(minWait - timeSinceLastRequest, randomDelay);
    
    if (waitTime > 0) {
      await delay(waitTime);
    }
    lastRequest = Date.now();
  };
})();

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
        currency: currency || null
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

  // Match the number and check for K/k suffix
  const match = text.match(/([\d,.]+)(K|k)?\s*donations/i);
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

// Main scraping function
async function scrapeCampaign(row) {
  await rateLimiter();
  
  let browser;
  try {
    if (!row.link) {
      throw new Error('Invalid URL provided');
    }

    const siteType = detectSiteType(row.link);
    if (!siteType) {
      console.log(`⏭️ Skipped: Unsupported platform URL`);
      return false;
    }

    if (siteType === SITE_TYPES.CHUFFED) {
      const projectId = extractChuffedId(row.link);
      if (!projectId) {
        throw new Error('Failed to extract project ID from URL');
      }

      const chuffedData = await fetchChuffedData(projectId);
      if (!chuffedData) {
        throw new Error('Failed to fetch data from Chuffed API');
      }

      // Convert cents to whole currency units by dividing by 100
      const totalSupporters = chuffedData?.campaign?.donations?.totalCount || 'Not found';
      const totalRaised = chuffedData?.campaign?.collected?.amount 
        ? Math.floor(parseInt(chuffedData.campaign.collected.amount) / 100)
        : 'Not found';
      const currency = chuffedData?.campaign?.target?.currencyNode?.symbol || 'Not found';
      const targetAmount = chuffedData?.campaign?.target?.amount 
        ? Math.floor(parseInt(chuffedData.campaign.target.amount) / 100)
        : 'Not found';

      console.log(`✅ Chuffed Data Extracted: Raised ${currency}${totalRaised}, Donations: ${totalSupporters}, Target: ${currency}${targetAmount}`);

      const updated = await updateCampaignData(
        row.id,
        targetAmount === 'Not found' ? null : targetAmount,
        totalRaised === 'Not found' ? null : totalRaised,
        chuffedData?.campaign?.title || null,
        currency === 'Not found' ? null : currency
      );

      if (!updated) {
        throw new Error('Database update failed - no changes were made');
      }

      return true;
    }

    // Handle GoFundMe via scraping
    if (siteType === SITE_TYPES.GOFUNDME) {
      browser = await puppeteer.launch({
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
        ]
      });

      const page = await browser.newPage();
      
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const resourceType = request.resourceType();
        if (['document', 'script', 'xhr', 'fetch'].includes(resourceType)) {
          request.continue();
        } else {
          request.abort();
        }
      });

      await page.setViewport({ width: 800, height: 600 });
      await page.setCacheEnabled(false);

      try {
        await retry(async () => {
          await page.goto(row.link, {
            waitUntil: 'networkidle0',
            timeout: 30000
          });
        });
      } catch (error) {
        throw new Error(`Failed to load page after retries: ${error.message}`);
      }

      const selectors = SELECTORS[siteType];

      // Check each element individually
      const elementPresence = {};
      for (const [key, selector] of Object.entries(selectors)) {
        try {
          await page.waitForSelector(selector, { 
            timeout: 10000,
            visible: true
          });
          elementPresence[key] = true;
        } catch (error) {
          elementPresence[key] = false;
          console.log(`⚠️ Warning: ${key} element not found (${selector})`);
        }
      }

      if (!Object.values(elementPresence).some(present => present)) {
        throw new Error('No required elements found on page');
      }

      const data = await page.evaluate((selectors, siteType, SITE_TYPES) => {
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
      }, selectors, siteType, SITE_TYPES);

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
    }

  } catch (error) {
    console.error(`❌ Error processing campaign: ${error.message}`);
    return false;
  } finally {
    if (browser) {
      await browser.close().catch(err => 
        console.error(`⚠️ Warning: Browser cleanup failed - ${err.message}`)
      );
    }
  }
}

// Add this function near the top with other helper functions
function displayLogo() {
    console.clear();
    console.log(
        figlet.textSync('Sunbird Scanner', {
            font: 'Standard',
            horizontalLayout: 'default',
            verticalLayout: 'default'
        })
    );
    console.log('\n');
}

// Main process function
async function processAllCampaigns() {
  try {
    displayLogo();
    
    const campaigns = await fetchCampaignUrls();
    if (!campaigns || campaigns.length === 0) {
      console.log('No campaigns found to process');
      return;
    }

    const args = process.argv.slice(2);
    let startIndex, endIndex, totalToProcess;
    let campaignsToProcess;

    if (args.indexOf('--start') !== -1) {
      // Keep startIndex as the actual number input (no subtraction)
      startIndex = parseInt(args[args.indexOf('--start') + 1]);
      endIndex = parseInt(args[args.indexOf('--end') + 1]);
      totalToProcess = endIndex - startIndex + 1; // Add 1 to include both start and end numbers
      
      // Only subtract 1 when using as array index
      const sliceStart = startIndex - 1;
      campaignsToProcess = campaigns.slice(sliceStart, endIndex);
    } else {
      startIndex = 1; // Start from 1 for consistency
      endIndex = campaigns.length;
      totalToProcess = campaigns.length;
      campaignsToProcess = campaigns;
    }

    console.log(`Found ${campaigns.length} total campaigns`);
    console.log(`Processing campaigns from #${startIndex} to #${endIndex}\n`);

    let successCount = 0;
    let notFoundCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < campaignsToProcess.length; i++) {
      if (isShuttingDown) {
        console.log('🛑 Shutdown requested, stopping gracefully...');
        break;
      }

      const campaign = campaignsToProcess[i];
      const percentage = Math.round(((i + 1) / totalToProcess) * 100);
      
      // When no range specified, show current/total, otherwise show range progress
      if (args.indexOf('--start') !== -1) {
        console.log(`\n--- Campaign ${startIndex + i}/${endIndex} (${percentage}% of range) ---`);
      } else {
        console.log(`\n--- Campaign ${i + 1}/${totalToProcess} (${percentage}%) ---`);
      }
      
      console.log(`URL: ${campaign.link} | ID: ${campaign.id}`);

      try {
        if (!campaign.link) {
          throw new Error('Invalid or empty URL');
        }

        // Replace the GoFundMe check with a site type check
        const siteType = detectSiteType(campaign.link);
        if (!siteType) {
          skippedCount++;
          console.log(`⏭️ Skipped: Not a supported platform URL`);
          continue;
        }

        console.log(`⏳ Processing...`);

        const result = await scrapeCampaign(campaign).catch(error => {
          throw new Error(`Scraping failed: ${error.message}`);
        });
        
        if (result) {
          successCount++;
          console.log(`✅ Success: Data updated`);
        } else {
          if (campaign.link.includes('Not found')) {
            notFoundCount++;
            console.log(`⚠️ Warning: Campaign not found`);
          } else {
            failedCount++;
            console.log(`❌ Error: Failed to process campaign`);
          }
        }

      } catch (error) {
        failedCount++;
        console.log(`❌ Error: ${error.message}`);
        
        // Additional error details if available
        if (error.stack) {
          console.log(`   Stack trace: ${error.stack.split('\n')[1].trim()}`);
        }
        if (error.cause) {
          console.log(`   Cause: ${error.cause}`);
        }
      }

      // Add a small delay between processing
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Final summary (appended at the end)
    console.log('\n' + '='.repeat(50));
    console.log('📊 Final Summary');
    console.log('='.repeat(50));
    console.log(`✅ Successful: ${successCount}`);
    console.log(`⚠️ Not Found: ${notFoundCount}`);
    console.log(`❌ Failed: ${failedCount}`);
    console.log(`⏭️ Skipped: ${skippedCount}`);
    console.log('='.repeat(50) + '\n');

  } catch (error) {
    console.error('\n❌ Fatal Error:', error.message);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
  }
}

// Add near the top of the file
let isShuttingDown = false;

process.on('SIGINT', async () => {
  console.log('\n\n🛑 Graceful shutdown initiated...');
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