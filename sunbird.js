// Import dependencies using ES Module syntax
import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

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

async function updateCampaignData(id, target, raised, name) {
  try {
    const { data, error } = await supabase
      .from('sunbird')
      .update({
        target: parseInt(target) || null,
        raised: parseInt(raised) || null,
        name: name || null,
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

async function scrapeGoFundMe(row) {
  let browser;
  try {
    if (!row.link) {
      throw new Error('Invalid URL provided');
    }

    // Add URL validation check
    if (!row.link.includes('gofundme.com')) {
      console.log(`\nSkipping [ID: ${row.id}]: Not a GoFundMe URL (${row.link})`);
      return;
    }

    console.log(`\nProcessing [ID: ${row.id}]:`, row.link);
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // Prevents memory issues in Docker/Linux
        '--disable-gpu', // Reduces memory usage
        '--disable-extensions', // We don't need extensions
        '--disable-audio', // Disable audio - we don't need it
        '--disable-notifications', // Disable notifications
        '--disable-background-timer-throttling', // Improve timer precision
        '--disable-backgrounding-occluded-windows',
        '--disable-ipc-flooding-protection' // Can improve performance
      ]
    });

    const page = await browser.newPage();
    
    // Block unnecessary resources
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      // Only allow necessary resource types
      if (['document', 'script', 'xhr', 'fetch'].includes(resourceType)) {
        request.continue();
      } else {
        request.abort();
      }
    });

    // Optimize memory usage
    await page.setViewport({ width: 800, height: 600 }); // Smaller viewport
    
    // Cache disabled to ensure fresh data
    await page.setCacheEnabled(false);

    // Add timeout to page load with faster initial check
    await page.goto(row.link, {
      waitUntil: 'domcontentloaded', // Faster than 'networkidle0'
      timeout: 20000 // Reduced timeout to 20 seconds
    });

    // Wait for specific elements with reduced timeout
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
      // Parse target/goal amount
      const parseTargetAmount = (text) => {
        const beforeTarget = text?.split('target')[0];
        const match = beforeTarget?.match(
          /([€$£¥₹₽₪₱₩R$]|[Kk]r\.?|kr|NOK|SEK|DKK|USD|EUR|GBP|JPY|INR|RUB|ILS|PHP|KRW|BRL)[\s]?([\d,.]+[kKmMbB]?)/
        );

        if (!match) return {
          currency: 'Not found',
          amount: 'Not found',
          raw: 'Not found'
        };

        const currency = match[1];
        let amount = match[2];

        // Normalize the amount
        const normalizeAmount = (amountStr) => {
          let normalized = amountStr.replace(/[,\s]/g, '');
          if (normalized.toLowerCase().endsWith('k')) {
            const number = parseFloat(normalized.slice(0, -1));
            normalized = (number * 1000).toString();
          } else if (normalized.toLowerCase().endsWith('m')) {
            const number = parseFloat(normalized.slice(0, -1));
            normalized = (number * 1000000).toString();
          } else if (normalized.toLowerCase().endsWith('b')) {
            const number = parseFloat(normalized.slice(0, -1));
            normalized = (number * 1000000000).toString();
          }
          return normalized;
        };

        return {
          currency,
          amount: normalizeAmount(amount),
          raw: match[0]
        };
      };

      // Parse raised amount
      const parseRaisedAmount = (text) => {
        const match = text?.match(
          /([€$£¥₹₽₪₱₩R$]|[Kk]r\.?|kr|NOK|SEK|DKK|USD|EUR|GBP|JPY|INR|RUB|ILS|PHP|KRW|BRL|AUD|CAD|NZD|SGD|MXN|CZK|HUF|THB|MYR|PHP|ZAR|AED|NPR|BHD|QAR|KWD|JOD|DZD|MAD|TND|CLP|COP|PEN|PAB|UYU|VND|RSD|RON|HRK|BGN|ISK|NOK|SEK|DKK|NOK|XOF|XAF|XPF)[\s]?([\d,.]+)/i
        );
        
        if (!match) return {
          currency: 'Not found',
          amount: 'Not found',
          raw: 'Not found'
        };

        return {
          currency: match[1],
          amount: match[2].replace(/,/g, ''),
          raw: match[0]
        };
      };



      const goalText = document.querySelector('.progress-meter_circleGoalDonations__5gSh1')?.textContent.trim();
      const raisedText = document.querySelector('.progress-meter_progressBarHeading__Nxc77')?.textContent.trim();
      
      const targetData = parseTargetAmount(goalText);
      const raisedData = parseRaisedAmount(raisedText);
      
      return {
        title: document.querySelector('h1.p-campaign-title')?.textContent.trim(),
        goalAmount: targetData.raw,
        goalAmountNormalized: targetData.amount,
        goalCurrency: targetData.currency,
        raisedAmount: raisedData.raw,
        raisedAmountNormalized: raisedData.amount,
        raisedCurrency: raisedData.currency,
      };
    });

    const updated = await updateCampaignData(
      row.id,
      data.goalAmountNormalized,
      data.raisedAmountNormalized,
      data.title
    );

    console.log(data.raisedAmount);
    console.log('Status:', updated ? '✅ Success' : '❌ Failed');

    return true;
  } catch (error) {
    console.error('Error processing:', row.link);
    console.error('Error details:', error.message);
    return false;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function processAllCampaigns() {
  try {
    const campaigns = await fetchCampaignUrls();
    if (!campaigns || campaigns.length === 0) {
      console.log('No campaigns found to process');
      return;
    }
    
    console.log(`Found ${campaigns.length} campaigns to process\n`);

    // Parse command line arguments
    const args = process.argv.slice(2);
    let startIndex, endIndex, totalToProcess;
    
    if (args.indexOf('--start') !== -1) {
      // Range was specified
      startIndex = parseInt(args[args.indexOf('--start') + 1]);
      endIndex = parseInt(args[args.indexOf('--end') + 1]);
      totalToProcess = endIndex - startIndex + 1;  // Calculate total for range (inclusive)
    } else {
      // No range specified - process all items
      startIndex = 0;
      totalToProcess = campaigns.length;
      endIndex = startIndex + totalToProcess;
    }

    // Filter campaigns based on range
    const campaignsToProcess = campaigns.slice(startIndex, endIndex);
    
    console.log(`Processing campaigns from #${startIndex + 1} to #${endIndex} (${totalToProcess} campaigns)\n`);

    // Initialize counters for success and failures
    let successCount = 0;
    let notFoundCount = 0;
    let failedCount = 0;

    for (let i = 0; i < campaignsToProcess.length; i++) {
      const campaign = campaignsToProcess[i];
      console.log(`Processing campaign ${i + 1} of ${totalToProcess}`);
      
      const result = await scrapeGoFundMe(campaign);
      
      // Check the result and update counters
      if (result) {
        successCount++;
      } else {
        if (campaign.link.includes('Not found')) {
          notFoundCount++;
        } else {
          failedCount++;
        }
      }
      
      const delay = 2000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    // Print summary of results
    console.log(`\nSummary of Results:`);
    console.log(`Successful campaigns: ${successCount}`);
    console.log(`Not Found campaigns: ${notFoundCount}`);
    console.log(`Failed campaigns: ${failedCount}`);

  } catch (error) {
    console.error('Error processing campaigns:', error.message);
  }
}

// Add better error handling to the main execution
processAllCampaigns()
  .then(() => {
    console.log('Scraping complete');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });

