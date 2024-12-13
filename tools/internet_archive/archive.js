import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import chalk from 'chalk';
import url from 'url';
import fetch from 'node-fetch';
import inquirer from 'inquirer';
import fs from 'fs/promises';
import path from 'path';

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
  baseDelay: 4000,
  maxDelay: 60000,
  backoffFactor: 2,
  successReduceFactor: 0.9,
  currentDelay: 4000,
  minDelay: 4000,
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  
  reset() {
    this.currentDelay = this.baseDelay;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
  },
  
  calculateNextDelay(isSuccess) {
    // Add jitter to help prevent thundering herd
    const jitter = Math.random() * 1000;
    if (isSuccess) {
      this.consecutiveSuccesses++;
      this.consecutiveFailures = 0;
      if (this.consecutiveSuccesses > 5) {
        this.currentDelay = Math.max(
          this.minDelay,
          this.currentDelay * this.successReduceFactor
        );
      }
    } else {
      this.consecutiveFailures++;
      this.consecutiveSuccesses = 0;
      this.currentDelay = Math.min(
        this.currentDelay * this.backoffFactor,
        this.maxDelay
      );
    }
    return this.currentDelay;
  }
};

// Add these constants at the top with other constants
const RETRY_CONFIG = {
  maxAttempts: 3,
  // Error categories and their retry strategies
  errorCategories: {
    RATE_LIMIT: {
      // 429 errors
      shouldRetry: true,
      backoffMultiplier: 2,
      baseDelay: RATE_LIMITS.baseDelay * 2
    },
    TIMEOUT: {
      // Timeout errors
      shouldRetry: true,
      backoffMultiplier: 1.5,
      baseDelay: RATE_LIMITS.baseDelay
    },
    SERVER_ERROR: {
      // 500-599 errors
      shouldRetry: true,
      backoffMultiplier: 1.5,
      baseDelay: RATE_LIMITS.baseDelay
    },
    CLIENT_ERROR: {
      // 400-499 errors (except 429)
      shouldRetry: false
    },
    NETWORK_ERROR: {
      // Connection errors
      shouldRetry: true,
      backoffMultiplier: 1.5,
      baseDelay: RATE_LIMITS.baseDelay
    }
  }
};

// Add this new function to categorize errors
function categorizeError(error, responseStatus) {
  if (responseStatus === 429) return 'RATE_LIMIT';
  if (error.name === 'AbortError') return 'TIMEOUT';
  if (responseStatus >= 500) return 'SERVER_ERROR';
  if (responseStatus >= 400) return 'CLIENT_ERROR';
  if (error.message.includes('fetch failed') || error.message.includes('network')) return 'NETWORK_ERROR';
  return 'UNKNOWN';
}

// Enhanced retry function
async function retryWithBackoff(url, operation, captureOutlinks) {
  let lastError = null;
  let attempt = 1;

  while (attempt <= RETRY_CONFIG.maxAttempts) {
    try {
      // Always respect the base rate limit delay
      if (attempt > 1) {
        const retryDelay = RATE_LIMITS.currentDelay;
        log.info(`Retry ${attempt}/${RETRY_CONFIG.maxAttempts}: Waiting ${retryDelay}ms before attempt`, true);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }

      const result = await operation();
      RATE_LIMITS.calculateNextDelay(true);
      return result;

    } catch (error) {
      lastError = error;
      const errorCategory = categorizeError(error, error.status);
      const errorConfig = RETRY_CONFIG.errorCategories[errorCategory];

      log.error(
        `Attempt ${attempt}/${RETRY_CONFIG.maxAttempts} failed: ${error.message} (${errorCategory})`,
        error
      );

      if (!errorConfig?.shouldRetry || attempt === RETRY_CONFIG.maxAttempts) {
        throw new Error(`Final attempt failed: ${error.message}`);
      }

      // Calculate delay based on error category and attempt number
      const baseDelay = errorConfig.baseDelay || RATE_LIMITS.baseDelay;
      const multiplier = errorConfig.backoffMultiplier || 1;
      const delay = Math.min(
        baseDelay * Math.pow(multiplier, attempt - 1),
        RATE_LIMITS.maxDelay
      );

      RATE_LIMITS.calculateNextDelay(false);
      RATE_LIMITS.currentDelay = Math.max(RATE_LIMITS.currentDelay, delay);
      
      attempt++;
    }
  }

  throw lastError;
}

async function checkEnvFile() {
  try {
    await fs.access('.env');
    dotenv.config();
  } catch {
    console.log(chalk.yellow('No .env file found. Please provide the required values:'));
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'SUPABASE_URL',
        message: 'Enter your Supabase URL:',
        validate: input => input.length > 0
      },
      {
        type: 'input',
        name: 'SUPABASE_ANON_KEY',
        message: 'Enter your Supabase anonymous key:',
        validate: input => input.length > 0
      },
      {
        type: 'input',
        name: 'ARCHIVE_KEY',
        message: 'Enter your Internet Archive key:',
        validate: input => input.length > 0
      }
    ]);

    const envContent = Object.entries(answers)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    await fs.writeFile('.env', envContent);
    dotenv.config();
  }
}

async function getConfig() {
  // First get the table choice
  const { table } = await inquirer.prompt([
    {
      type: 'list',
      name: 'table',
      message: 'Which table would you like to scan?',
      choices: ['gv-links', 'sunbird']
    }
  ]);

  // Get the maximum ID from the selected table
  const { data: maxIdResult, error: maxIdError } = await supabase
    .from(table)
    .select('id')
    .order('id', { ascending: false })
    .limit(1)
    .single();

  if (maxIdError) {
    log.error('Error fetching maximum ID:', maxIdError);
    throw maxIdError;
  }

  const maxId = maxIdResult?.id || 1;

  // Get the rest of the configuration
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'startId',
      message: 'Enter start ID (minimum 1):',
      default: '1',
      validate: input => {
        const num = parseInt(input);
        if (isNaN(num)) return 'Please enter a valid number';
        return num >= 1 ? true : 'Please enter a number greater than or equal to 1';
      },
      filter: (input) => {
        const num = parseInt(input);
        return isNaN(num) ? 1 : num;
      }
    },
    {
      type: 'input',
      name: 'endId',
      message: `Enter end ID (optional, press enter for max: ${maxId}):`,
      default: String(maxId),
      validate: (input, answers) => {
        if (input === '') return true;
        const num = parseInt(input);
        if (isNaN(num)) return 'Please enter a valid number';
        return num >= answers.startId ? true : 'End ID must be greater than or equal to start ID';
      },
      filter: (input) => {
        if (input === '') return maxId;
        const num = parseInt(input);
        return isNaN(num) ? maxId : num;
      }
    },
    {
      type: 'confirm',
      name: 'captureOutlinks',
      message: 'Would you like to capture outlinks?',
      default: false
    },
    {
      type: 'confirm',
      name: 'skipArchived',
      message: 'Skip already archived URLs?',
      default: true
    }
  ]);
  
  // Convert to 0-based indices for internal use
  return {
    table,
    startId: answers.startId - 1,
    endId: answers.endId - 1,
    captureOutlinks: answers.captureOutlinks,
    skipArchived: answers.skipArchived
  };
}

// Update the archiveLink function to use the new retry mechanism
async function archiveLink(url, attempt = 1, captureOutlinks = false) {
  // URL validation remains the same
  if (!url?.trim()) {
    throw new Error('Empty or invalid URL provided');
  }

  try {
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Invalid URL protocol - must be http or https');
    }
    
    if (!parsedUrl.hostname) {
      throw new Error('Invalid URL: missing hostname');
    }

    return await retryWithBackoff(url, async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      try {
        const response = await fetch(`https://web.archive.org/save/${url}`, {
          method: 'GET',
          headers: {
            'Authorization': `LOW ${process.env.ARCHIVE_KEY}`,
            'User-Agent': 'ArchiveBot/1.0',
            'Capture-Outlinks': captureOutlinks.toString()
          },
          signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
          error.status = response.status;
          throw error;
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

      } finally {
        clearTimeout(timeout);
      }
    }, captureOutlinks);

  } catch (error) {
    log.error(`Archive failed: ${error.message}`, error);
    return null;
  }
}

async function main() {
  await checkEnvFile();
  const config = await getConfig();
  log.info('Starting archiving process...');
  
  try {
    // Build the query based on the range
    let query = supabase
      .from(config.table)
      .select('id, link, archived_at')
      .order('id', { ascending: true });

    // Only add range filters if we have valid values
    if (typeof config.startId === 'number' && config.startId >= 0) {
      query = query.gte('id', config.startId);
    }

    if (typeof config.endId === 'number' && config.endId >= 0) {
      query = query.lte('id', config.endId);
    }

    if (config.skipArchived) {
      query = query.is('archived_at', null);
    }

    const { data: urls, error } = await query;

    if (error) {
      log.error('Database query error:', error);
      throw error;
    }

    if (!urls?.length) {
      log.warning('No URLs found to archive in the specified range');
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

        archiveUrl = await archiveLink(urlRecord.link, attempt, config.captureOutlinks);
        if (archiveUrl) break;
      }

      if (archiveUrl) {
        log.success(`Successfully archived: ${urlRecord.link} -> ${archiveUrl}`);
        const { error: updateError } = await supabase
          .from(config.table)
          .update({
            archived_at: new Date().toISOString(),
            archive_url: archiveUrl,
            last_checked: new Date().toISOString(),
          })
          .eq('id', urlRecord.id);

        if (updateError) {
          log.error(`Failed to update database for ${urlRecord.link}:`, updateError);
          continue;
        }
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
let isShuttingDown = false;

process.on('SIGINT', async () => {
  if (isShuttingDown) {
    log.warning('Forced shutdown initiated...');
    process.exit(1);
  }
  
  isShuttingDown = true;
  log.warning('Graceful shutdown initiated, completing current operation...');
  // Allow current operation to complete
  setTimeout(() => {
    log.warning('Shutdown timeout exceeded, forcing exit...');
    process.exit(1);
  }, 30000); // 30 second timeout
});

// Run the script
if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    log.error(`Fatal error: ${error.message}`);
    process.exit(1);
  });
}

export { archiveLink, main };
