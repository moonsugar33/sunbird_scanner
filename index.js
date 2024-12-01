// Import dependencies using ES Module syntax
import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import cliProgress from 'cli-progress';

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

// Add this helper function for console clearing
function clearLastLines(count) {
  process.stdout.write(`\x1b[${count}A\x1b[0J`);
}

// Main scraping function
async function scrapeGoFundMe(row) {
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

    await page.goto(row.link, {
      waitUntil: 'domcontentloaded',
      timeout: 20000
    });

    const selectors = [
      'h1.p-campaign-title',
      '.progress-meter_progressBarHeading__Nxc77',
      '.progress-meter_circleGoalDonations__5gSh1'
    ];

    try {
      await Promise.all(selectors.map(selector => 
        page.waitForSelector(selector, { timeout: 8000 })
      ));
    } catch (error) {
      console.log(`Warning: Some elements not found for ${row.link}`);
    }

    const data = await page.evaluate(() => {
      const goalText = document.querySelector('.progress-meter_circleGoalDonations__5gSh1')?.textContent.trim();
      const raisedText = document.querySelector('.progress-meter_progressBarHeading__Nxc77')?.innerHTML.trim();
      
      return {
        title: document.querySelector('h1.p-campaign-title')?.textContent.trim(),
        goalText,
        raisedText
      };
    });

    const raisedData = parseRaisedAmount(data.raisedText);
    const targetData = parseTargetAmount(data.goalText);

    const processedData = {
      title: data.title,
      goalAmount: targetData.raw,
      goalAmountNormalized: targetData.amount,
      goalCurrency: targetData.currency,
      raisedAmount: raisedData.raw,
      raisedAmountNormalized: raisedData.amount,
      raisedCurrency: raisedData.currency,
    };

    const updated = await updateCampaignData(
      row.id,
      processedData.goalAmountNormalized,
      processedData.raisedAmountNormalized,
      processedData.title,
      processedData.raisedCurrency
    );

    return true;
  } catch (error) {
    // Clear and update error status
    clearLastLines(1);
    console.log(`Last Error: ${error.message}`);
    return false;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Main process function
async function processAllCampaigns() {
  try {
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

    // Initial render of status
    console.log(`Found ${campaigns.length} total campaigns`);
    console.log(`Processing campaigns from #${startIndex + 1} to #${endIndex}`);
    console.log('');
    console.log('Progress |░░░░░░░░░░| 0%');  // Initial progress bar
    console.log('');  // URL
    console.log('');  // Status
    console.log('');  // Error
    console.log('');  // Empty line

    for (let i = 0; i < campaignsToProcess.length; i++) {
      const campaign = campaignsToProcess[i];
      const percentage = Math.round((i / totalToProcess) * 100);
      const progressBarWidth = Math.round((i / totalToProcess) * 10);
      const progressBar = '|' + '█'.repeat(progressBarWidth) + '░'.repeat(10 - progressBarWidth) + '|';

      // Clear previous status lines (always clear all 8 lines)
      clearLastLines(8);

      // Rewrite everything
      console.log(`Found ${campaigns.length} total campaigns`);
      console.log(`Processing campaigns from #${startIndex + 1} to #${endIndex}`);
      console.log('');
      console.log(`Progress ${progressBar} ${percentage}%`);
      console.log(`URL: ${campaign.link}`);

      // Check if it's a GoFundMe URL
      if (!campaign.link.includes('gofundme.com')) {
        skippedCount++;
        console.log(`Status: ⚠️ Skipped - Not a GoFundMe URL`);
        console.log(`Last Error: None`);
        console.log('');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      console.log(`Status: Processing...`);
      console.log(`Last Error: None`);
      console.log('');

      const result = await scrapeGoFundMe(campaign);

      // Clear and update status (all 8 lines again)
      clearLastLines(8);

      // Rewrite everything again
      console.log(`Found ${campaigns.length} total campaigns`);
      console.log(`Processing campaigns from #${startIndex + 1} to #${endIndex}`);
      console.log('');
      console.log(`Progress ${progressBar} ${percentage}%`);
      console.log(`URL: ${campaign.link}`);
      
      if (result) {
        successCount++;
        console.log(`Status: ✅ Success`);
      } else {
        if (campaign.link.includes('Not found')) {
          notFoundCount++;
          console.log(`Status: ⚠️ Not Found`);
        } else {
          failedCount++;
          console.log(`Status: ❌ Failed`);
        }
      }
      console.log(`Last Error: None`);
      console.log('');

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Clear final status
    clearLastLines(8);

    // Show final summary
    console.log(`\nSummary of Results:`);
    console.log(`Successful campaigns: ${successCount}`);
    console.log(`Not Found campaigns: ${notFoundCount}`);
    console.log(`Failed campaigns: ${failedCount}`);
    console.log(`Skipped (non-GoFundMe) URLs: ${skippedCount}`);

  } catch (error) {
    console.error('Error processing campaigns:', error.message);
  }
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