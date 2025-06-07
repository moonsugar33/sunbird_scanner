#!/bin/bash

# Change to the directory containing the script
cd "$(dirname "$0")"

# Set NODE_ENV to production to avoid development-specific behavior
export NODE_ENV=production

# Log start time
echo "$(date): Starting daily scanner runs" >> scanner_cron.log

# Run the first scanner
echo "$(date): Running first scanner" >> scanner_cron.log
bun run.js --scanner=sunbird --start=1 --end=1000 --quiet --skip-deps
echo "$(date): First scanner completed" >> scanner_cron.log

# Wait a few seconds between runs
sleep 5

# Run the second scanner
echo "$(date): Running second scanner" >> scanner_cron.log
bun run.js --scanner=gazavetters --start=1 --end=1000 --quiet --skip-deps
echo "$(date): Second scanner completed" >> scanner_cron.log

# Log completion
echo "$(date): All scanner runs completed" >> scanner_cron.log
echo "----------------------------------------" >> scanner_cron.log 