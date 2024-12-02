import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import chalk from 'chalk';
import url from 'url';
import fetch from 'node-fetch';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Modern logging utility with optional verbose mode
const log = {
  verbose: process.env.DEBUG === 'true',
  info: (msg, verbose = false) => {
    if (verbose && !log.verbose) return;
    console.log(chalk.blue('→'), msg);
  },
  success: (msg) => console.log(chalk.green('✓'), msg),
  error: (msg, error = null) => {
    console.error(chalk.red('✖'), msg);
    if (error?.stack && log.verbose) console.error(chalk.red(error.stack));
  },
  warning: (msg) => console.log(chalk.yellow('!'), msg),
  progress: (current, total, msg) => {
    console.log(chalk.cyan(`[${current}/${total}]`), msg);
  }
};

// Adjust rate limit constants for 15 RPM
const RATE_LIMITS = {
  baseDelay: 4000,          // Base delay between requests (4s to respect 15 RPM)
  maxDelay: 60000,          // Maximum delay (60s)
  backoffFactor: 2,         // More aggressive backoff multiplier
  successReduceFactor: 0.9, // More conservative reduction (slower ramp-up)
  currentDelay: 4000,       // Starting delay (4s)
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
};

async function archiveLink(url, attempt = 1) {
  try {
    new URL(url);
    log.info(`Attempt ${attempt}: Archiving URL`, true);
    
    const response = await fetch(`https://web.archive.org/save/${url}`, {
      method: 'GET',
      headers: {
        'Authorization': `LOW ${process.env.ARCHIVE_KEY}`,
        'User-Agent': 'ArchiveBot/1.0',
      },
      timeout: 30000,
    });

    // Handle rate limiting specifically
    if (response.status === 429) {
      RATE_LIMITS.consecutiveFailures++;
      RATE_LIMITS.consecutiveSuccesses = 0;
      RATE_LIMITS.currentDelay = Math.min(
        RATE_LIMITS.currentDelay * RATE_LIMITS.backoffFactor,
        RATE_LIMITS.maxDelay
      );
      throw new Error('Rate limit exceeded');
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Success - gradually reduce delay
    RATE_LIMITS.consecutiveSuccesses++;
    RATE_LIMITS.consecutiveFailures = 0;
    if (RATE_LIMITS.consecutiveSuccesses > 5) {
      RATE_LIMITS.currentDelay = Math.max(
        RATE_LIMITS.baseDelay,
        RATE_LIMITS.currentDelay * RATE_LIMITS.successReduceFactor
      );
    }

    const archiveUrl = response.headers.get('content-location') 
      ? `https://web.archive.org${response.headers.get('content-location')}`
      : response.url.includes('/web/') 
        ? response.url 
        : null;

    if (!archiveUrl) {
      throw new Error('Could not determine archive URL');
    }

    return archiveUrl;

  } catch (error) {
    log.error(`Archive attempt ${attempt} failed: ${error.message}`, error);
    return null;
  }
}

async function main() {
  log.info('Starting archiving process...');
  
  try {
    // Update main constants
    const BATCH_SIZE = 3;        // Reduced from 5 to better handle rate limits
    const CONCURRENT_REQUESTS = 2; // Reduced from 3 to stay under 15 RPM
    const PAGE_SIZE = 50;        // Reduced from 100 to manage memory and rate limits better
    let processedCount = 0;
    let hasMore = true;

    while (hasMore) {
      // Fetch next page of URLs
      const { data: urls, error } = await supabase
        .from('gv-links')
        .select('id, link, archived_at')
        .is('archived_at', null)
        .order('id', { ascending: true })
        .range(processedCount, processedCount + PAGE_SIZE - 1);

      if (error) throw error;
      if (!urls?.length) {
        log.warning('No more URLs found to archive');
        hasMore = false;
        break;
      }

      log.info(`Processing URLs ${processedCount + 1} to ${processedCount + urls.length}`);

      // Process URLs in batches
      for (let i = 0; i < urls.length; i += BATCH_SIZE) {
        const batch = urls.slice(i, i + BATCH_SIZE);
        const promises = batch.map(async (urlRecord) => {
          log.progress(processedCount + i + batch.indexOf(urlRecord) + 1, processedCount + urls.length, urlRecord.link);

          let archiveUrl = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            if (attempt > 1) {
              const retryDelay = RATE_LIMITS.currentDelay * attempt;
              log.info(`Waiting ${retryDelay}ms before retry ${attempt} (Current rate limit: ${RATE_LIMITS.currentDelay}ms)`, true);
              await new Promise(resolve => setTimeout(resolve, retryDelay));
            }

            archiveUrl = await archiveLink(urlRecord.link, attempt);
            if (archiveUrl) break;
          }

          if (archiveUrl) {
            return supabase
              .from('gv-links')
              .update({
                archived_at: new Date().toISOString(),
                archive_url: archiveUrl,
                last_checked: new Date().toISOString(),
              })
              .eq('id', urlRecord.id);
          }
        });

        // Process batch with concurrency limit
        await Promise.all(
          promises.reduce((acc, promise, index) => {
            const batch = Math.floor(index / CONCURRENT_REQUESTS);
            if (!acc[batch]) acc[batch] = [];
            acc[batch].push(promise);
            return acc;
          }, []).map(batch => Promise.all(batch))
        );

        // Dynamic delay between batches based on current rate limit state
        const batchDelay = RATE_LIMITS.currentDelay;
        log.info(`Waiting ${batchDelay}ms between batches`, true);
        await new Promise(resolve => setTimeout(resolve, batchDelay));
      }

      processedCount += urls.length;
      hasMore = urls.length === PAGE_SIZE;

      // Adaptive delay between pages based on rate limit state
      const pageDelay = Math.max(2000, RATE_LIMITS.currentDelay);
      log.info(`Waiting ${pageDelay}ms between pages`, true);
      await new Promise(resolve => setTimeout(resolve, pageDelay));
    }

    log.success(`Archiving process completed. Processed ${processedCount} URLs total.`);

  } catch (error) {
    log.error('Main process error', error);
    throw error;
  }
}

// Handle script termination
process.on('SIGINT', () => {
  log.warning('Script interrupted, shutting down...');
  process.exit();
});

// Run the script
if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    log.error(`Fatal error: ${error.message}`);
    process.exit(1);
  });
}

export { archiveLink, main };
