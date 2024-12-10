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
        'Capture-Outlinks': 'false'
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
    // Fetch all unarchived URLs in one go
    const { data: urls, error } = await supabase
      .from('gv-links')
      .select('id, link, archived_at')
      .order('id', { ascending: true });

    if (error) throw error;
    if (!urls?.length) {
      log.warning('No URLs found to archive');
      return;
    }

    log.info(`Found ${urls.length} total URLs to process`);
    let processedCount = 0;

    // Process URLs one at a time
    for (const urlRecord of urls) {
      log.info(`[${processedCount + 1}/${urls.length}] Processing URL: ${urlRecord.link}`);
      log.info(`Current rate limit delay: ${RATE_LIMITS.currentDelay}ms`, true);

      let archiveUrl = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) {
          const retryDelay = RATE_LIMITS.currentDelay * attempt;
          log.info(`Waiting ${retryDelay}ms before retry ${attempt}`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }

        archiveUrl = await archiveLink(urlRecord.link, attempt);
        if (archiveUrl) break;
      }

      if (archiveUrl) {
        log.success(`Successfully archived: ${urlRecord.link} -> ${archiveUrl}`);
        await supabase
          .from('gv-links')
          .update({
            archived_at: new Date().toISOString(),
            archive_url: archiveUrl,
            last_checked: new Date().toISOString(),
          })
          .eq('id', urlRecord.id);
      } else {
        log.error(`Failed to archive after 3 attempts: ${urlRecord.link}`);
      }

      // Always wait between requests to respect rate limit
      log.info(`Waiting ${RATE_LIMITS.currentDelay}ms before next request`);
      await new Promise(resolve => setTimeout(resolve, RATE_LIMITS.currentDelay));
      processedCount++;
    }

    log.success(`Archiving process completed. Processed ${processedCount}/${urls.length} URLs total.`);

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
