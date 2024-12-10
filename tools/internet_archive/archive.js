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
  
  calculateNextDelay(isSuccess) {
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
  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'table',
      message: 'Which table would you like to scan?',
      choices: ['gv-links', 'sunbird']
    },
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
        return isNaN(num) ? 1 : num;  // Return 1 if invalid input
      }
    },
    {
      type: 'input',
      name: 'endId',
      message: 'Enter end ID (optional, press enter to scan all):',
      validate: (input, answers) => {
        if (input === '') return true;
        const num = parseInt(input);
        if (isNaN(num)) return 'Please enter a valid number';
        return num >= answers.startId ? true : 'End ID must be greater than or equal to start ID';
      },
      filter: (input) => {
        if (input === '') return null;
        const num = parseInt(input);
        return isNaN(num) ? null : num;
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
    ...answers,
    startId: answers.startId - 1,
    endId: answers.endId !== null ? answers.endId - 1 : null
  };
}

async function archiveLink(url, attempt = 1, captureOutlinks = false) {
  try {
    // Validate URL more robustly
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Invalid URL protocol - must be http or https');
    }
    
    if (!url.trim()) {
      throw new Error('Empty URL provided');
    }

    log.info(`Attempt ${attempt}: Archiving URL`, true);
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

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
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw new Error('Request timed out');
    }
    log.error(`Archive attempt ${attempt} failed: ${error.message}`, error);
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
