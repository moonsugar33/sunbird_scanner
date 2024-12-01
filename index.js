// Import dependencies using ES Module syntax
import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import cliProgress from 'cli-progress';
import figlet from 'figlet';
import rateLimit from 'express-rate-limit';

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
      .from('gv-links')
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
      .from('gv-links')
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

// Main scraping function
async function scrapeGoFundMe(row) {
  await rateLimiter();
  
  let browser;
  try {
    if (!row.link) {
      throw new Error('Invalid URL provided');
    }

    if (!row.link.includes('gofundme.com')) {
      return false;
    }

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

    // Add timeout and error handling for page load
    try {
      await retry(async () => {
        await page.goto(row.link, {
          waitUntil: 'domcontentloaded',
          timeout: 20000
        });
      });
    } catch (error) {
      throw new Error(`Failed to load page after retries: ${error.message}`);
    }

    const selectors = {
      title: 'h1.p-campaign-title',
      raised: '.progress-meter_progressBarHeading__Nxc77',
      goal: '.progress-meter_circleGoalDonations__5gSh1'
    };

    // Check each element individually with detailed error reporting
    const elementPresence = {};
    for (const [key, selector] of Object.entries(selectors)) {
      try {
        await page.waitForSelector(selector, { timeout: 8000 });
        elementPresence[key] = true;
      } catch (error) {
        elementPresence[key] = false;
        console.log(`⚠️ Warning: ${key} element not found (${selector})`);
      }
    }

    // If no elements were found, throw error
    if (!Object.values(elementPresence).some(present => present)) {
      throw new Error('No required elements found on page - possible layout change or invalid page');
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

      return {
        title: title.text,
        goalText: goal.text,
        raisedText: raised.html,
        elementStatus: {
          title: title.exists,
          raised: raised.exists,
          goal: goal.exists
        }
      };
    }, selectors);

    // Validate scraped data
    if (!data.elementStatus.title && !data.elementStatus.raised && !data.elementStatus.goal) {
      throw new Error('Failed to extract any data from page elements');
    }

    // Log warnings for missing data
    if (!data.title) console.log('⚠️ Warning: Campaign title is missing');
    if (!data.raisedText) console.log('⚠️ Warning: Raised amount is missing');
    if (!data.goalText) console.log('⚠️ Warning: Goal amount is missing');

    const raisedData = parseRaisedAmount(data.raisedText);
    const targetData = parseTargetAmount(data.goalText);

    // Validate parsed amounts
    if (raisedData.amount === 'Not found' && targetData.amount === 'Not found') {
      throw new Error('Failed to parse both raised and target amounts');
    }

    const processedData = {
      title: data.title || null,
      goalAmount: targetData.raw,
      goalAmountNormalized: targetData.amount === 'Not found' ? null : targetData.amount,
      goalCurrency: targetData.currency === 'Not found' ? null : targetData.currency,
      raisedAmount: raisedData.raw,
      raisedAmountNormalized: raisedData.amount === 'Not found' ? null : raisedData.amount,
      raisedCurrency: raisedData.currency === 'Not found' ? null : raisedData.currency,
    };

    // Log warnings for mismatched currencies
    if (processedData.goalCurrency && processedData.raisedCurrency && 
        processedData.goalCurrency !== processedData.raisedCurrency) {
      console.log(`⚠️ Warning: Currency mismatch - Goal: ${processedData.goalCurrency}, Raised: ${processedData.raisedCurrency}`);
    }

    // Log successful data extraction
    console.log(' Extracted Data:');
    console.log(`   Title: ${processedData.title || 'Not found'}`);
    console.log(`   Goal: ${processedData.goalAmountNormalized ? 
      `${CURRENCY_SYMBOLS[processedData.goalCurrency] || processedData.goalCurrency || ''}${processedData.goalAmountNormalized} (Raw: ${processedData.goalAmount})` : 
      'Not found'}`);
    console.log(`   Raised: ${processedData.raisedAmountNormalized ? 
      `${CURRENCY_SYMBOLS[processedData.raisedCurrency] || processedData.raisedCurrency || ''}${processedData.raisedAmountNormalized} (Raw: ${processedData.raisedAmount})` : 
      'Not found'}`);

    // Attempt database update
    const updated = await updateCampaignData(
      row.id,
      processedData.goalAmountNormalized,
      processedData.raisedAmountNormalized,
      processedData.title,
      processedData.raisedCurrency
    );

    if (!updated) {
      throw new Error('Database update failed - no changes were made');
    }

    await page.evaluate(() => {
      window.gc && window.gc();
    });

    return true;
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    if (error.stack) {
      console.log(`   Stack: ${error.stack.split('\n')[1].trim()}`);
    }
    return false;
  } finally {
    if (browser) {
      await browser.close().catch(err => 
        console.log(`⚠️ Warning: Browser cleanup failed - ${err.message}`)
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

    if (args.indexOf('--start') !== -1) {
      startIndex = parseInt(args[args.indexOf('--start') + 1]);
      endIndex = parseInt(args[args.indexOf('--end') + 1]);
      totalToProcess = endIndex - startIndex;
    } else {
      startIndex = 0;
      endIndex = campaigns.length;
      totalToProcess = campaigns.length;
    }

    const campaignsToProcess = campaigns.slice(startIndex, endIndex);

    let successCount = 0;
    let notFoundCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    // Initial status display
    console.log(`Found ${campaigns.length} total campaigns`);
    console.log(`Processing campaigns from #${startIndex + 1} to #${endIndex}\n`);

    for (let i = 0; i < campaignsToProcess.length; i++) {
      if (isShuttingDown) {
        console.log('🛑 Shutdown requested, stopping gracefully...');
        break;
      }

      const campaign = campaignsToProcess[i];
      const percentage = Math.round((i / totalToProcess) * 100);
      
      console.log(`\n--- Campaign ${i + 1}/${totalToProcess} (${percentage}%) ---`);
      console.log(`URL: ${campaign.link}`);

      try {
        if (!campaign.link) {
          throw new Error('Invalid or empty URL');
        }

        if (!campaign.link.includes('gofundme.com')) {
          skippedCount++;
          console.log(`⏭️ Skipped: Not a GoFundMe URL`);
          continue;
        }

        console.log(`⏳ Processing...`);

        const result = await scrapeGoFundMe(campaign).catch(error => {
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