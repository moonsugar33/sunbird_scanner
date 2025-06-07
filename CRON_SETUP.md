# Running Sunbird Scanner as a Daily Cron Job

This guide explains how to set up the Sunbird Scanner to run automatically every day on your Linux VPS.

## Prerequisites

Ensure you have installed:
- Bun runtime
- Node.js
- All dependencies for the scanner

## Setup Instructions

1. Make sure the `run_daily.sh` script is executable:
   ```bash
   chmod +x run_daily.sh
   ```

2. Test the script manually to ensure it works:
   ```bash
   ./run_daily.sh
   ```

3. Open your crontab for editing:
   ```bash
   crontab -e
   ```

4. Add the following line to run the script daily at 2 AM (adjust the time as needed):
   ```
   0 2 * * * /full/path/to/your/sunbird_scanner/run_daily.sh >> /full/path/to/your/sunbird_scanner/cron_output.log 2>&1
   ```

   Replace `/full/path/to/your/sunbird_scanner/` with the actual path to the directory containing the script.

5. Save and exit the editor.

## Customizing the Schedule

- To run at a different time, modify the cron timing expression.
- Common examples:
  - Every day at midnight: `0 0 * * *`
  - Every day at 3 PM: `0 15 * * *`
  - Every Sunday at 1 AM: `0 1 * * 0`

## Customizing Scanner Arguments

Edit the `run_daily.sh` script to modify the scanner arguments:

```bash
bun run.js --scanner=TYPE --start=N --end=M --quiet --skip-deps
```

Replace:
- `TYPE` with your desired scanner type
- `N` with your start index
- `M` with your end index

## Troubleshooting

If the cron job isn't running:

1. Check the logs:
   ```bash
   cat cron_output.log
   cat scanner_cron.log
   ```

2. Ensure all paths in the crontab are absolute paths.

3. Make sure the user running the cron job has appropriate permissions. 