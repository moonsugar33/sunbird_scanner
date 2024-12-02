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

const log = {
  info: (msg) => console.log(chalk.blue('ℹ'), chalk.blue(msg)),
  success: (msg) => console.log(chalk.green('✓'), chalk.green(msg)),
  error: (msg) => console.log(chalk.red('✖'), chalk.red(msg)),
  warning: (msg) => console.log(chalk.yellow('⚠'), chalk.yellow(msg)),
};

async function archiveLink(url) {
  try {
    log.info(`Archiving URL: ${url}`);
    
    const response = await fetch(`https://web.archive.org/save/${url}`, {
      method: 'GET',
      headers: {
        'Authorization': `LOW ${process.env.ARCHIVE_KEY}`,
      }
    });

    if (!response.ok) {
      throw new Error(`Archive.org API returned ${response.status}: ${response.statusText}`);
    }

    const archiveUrl = response.headers.get('content-location');
    
    if (archiveUrl) {
      const fullArchiveUrl = `https://web.archive.org${archiveUrl}`;
      log.success(`Successfully archived: ${url}`);
      log.info(`Archive URL: ${fullArchiveUrl}`);
      return fullArchiveUrl;
    }

    const responseUrl = response.url;
    if (responseUrl.includes('/web/')) {
      log.success(`Successfully archived: ${url}`);
      log.info(`Archive URL: ${responseUrl}`);
      return responseUrl;
    }

    throw new Error('Could not determine archive URL');

  } catch (error) {
    log.error(`Failed to archive ${url}: ${error.message}`);
    return null;
  }
}

async function main() {
  log.info('Starting archiving process...');
  
  try {
    const { data: urls, error } = await supabase
      .from('gv-links')
      .select('id, link, archived_at')
      .is('archived_at', null);

    if (error) throw error;
    
    if (urls.length === 0) {
      log.warning('No URLs found to archive');
      return;
    }

    log.info(`Found ${urls.length} URLs to archive`);

    // Process URLs
    for (const [index, urlRecord] of urls.entries()) {
      log.info(`Processing ${index + 1}/${urls.length}: ${urlRecord.link}`);
      
      let attempts = 0;
      const maxAttempts = 3;
      let archiveUrl = null;

      while (attempts < maxAttempts && !archiveUrl) {
        if (attempts > 0) {
          log.warning(`Retry attempt ${attempts + 1} for ${urlRecord.link}`);
          // Wait longer between retries
          await new Promise(resolve => setTimeout(resolve, 5000 * attempts));
        }

        archiveUrl = await archiveLink(urlRecord.link);
        attempts++;
      }
      
      if (archiveUrl) {
        // Update Supabase record
        const { error: updateError } = await supabase
          .from('gv-links')
          .update({
            archived_at: new Date().toISOString(),
            archive_url: archiveUrl
          })
          .eq('id', urlRecord.id);

        if (updateError) {
          log.error(`Failed to update database for ${urlRecord.link}: ${updateError.message}`);
        }
      } else {
        log.error(`Failed to archive ${urlRecord.link} after ${maxAttempts} attempts`);
      }

      // Add a small delay between URLs
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    log.success('Archiving process completed');

  } catch (error) {
    log.error(`Main process error: ${error.message}`);
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
