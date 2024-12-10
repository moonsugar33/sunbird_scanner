import inquirer from 'inquirer';
import { spawn } from 'child_process';
import figlet from 'figlet';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { FundraisingScanner, SCANNER_CONFIGS } from './scanner.js';

const execAsync = promisify(exec);

// Get current file's directory (needed for ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
    .option('scanner', {
        alias: 's',
        description: 'Scanner type to run',
        type: 'string',
        choices: Object.keys(SCANNER_CONFIGS)
    })
    .option('start', {
        alias: 'from',
        description: 'Start index',
        type: 'number'
    })
    .option('end', {
        alias: 'to',
        description: 'End index',
        type: 'number'
    })
    .option('quiet', {
        alias: 'q',
        description: 'Run in quiet mode (no ASCII logo)',
        type: 'boolean',
        default: false
    })
    .option('skip-deps', {
        description: 'Skip dependency check',
        type: 'boolean',
        default: false
    })
    .help()
    .argv;

// Use path.join for cross-platform path handling
const CONFIG_PATH = join(__dirname, '.env');

// ASCII Logo display function
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

// Environment setup questions
const envQuestions = [
    {
        type: 'input',
        name: 'SUPABASE_URL',
        message: 'Enter your Supabase URL (found in your project settings):',
        validate: input => input.trim().length > 0 || 'This field is required'
    },
    {
        type: 'input',
        name: 'SUPABASE_ANON_KEY',
        message: 'Enter your Supabase Anon Key (found in your project settings):',
        validate: input => input.trim().length > 0 || 'This field is required'
    }
];

// Script selection questions
const questions = [
    {
        type: 'list',
        name: 'scannerType',
        message: 'Which scanner would you like to run?',
        choices: Object.entries(SCANNER_CONFIGS).map(([key, config]) => ({
            name: config.displayName,
            value: key
        }))
    },
    {
        type: 'confirm',
        name: 'useRange',
        message: 'Would you like to specify a range of URLs to scan?',
        default: false
    },
    {
        type: 'input',
        name: 'startRange',
        message: 'Enter start index (first item is 1):',
        default: '1',
        when: (answers) => answers.useRange,
        validate: (value) => {
            const num = parseInt(value);
            return (!isNaN(num) && num > 0) || 'Please enter a valid number greater than 0';
        }
    },
    {
        type: 'input',
        name: 'endRange',
        message: 'Enter end index:',
        when: (answers) => answers.useRange,
        validate: (value, answers) => {
            const num = parseInt(value);
            const start = parseInt(answers.startRange);
            return (!isNaN(num) && num >= start) || 'Please enter a valid number greater than or equal to start index';
        }
    }
];

async function checkAndInstallDependencies() {
    try {
        console.log('Checking and installing dependencies...');
        await execAsync('npm install');
        console.log('Dependencies installed successfully!\n');
    } catch (error) {
        console.error('Error installing dependencies:', error.message);
        process.exit(1);
    }
}

async function checkAndCreateEnvFile() {
    const envPath = '.env';
    
    try {
        // Check if .env exists
        if (!existsSync(envPath)) {
            console.log('No .env file found. Let\'s set it up!\n');
            console.log('You\'ll need your Supabase project credentials for this step.');
            console.log('You can find these in your Supabase project settings under "API".\n');
            
            const answers = await inquirer.prompt(envQuestions);
            
            // Create .env content
            const envContent = Object.entries(answers)
                .map(([key, value]) => `${key}=${value}`)
                .join('\n');
            
            // Write .env file
            await fs.writeFile(envPath, envContent);
            console.log('\n.env file created successfully!\n');
        }
    } catch (error) {
        console.error('Error setting up .env file:', error.message);
        process.exit(1);
    }
}

async function main() {
    // Only show logo if not in quiet mode
    if (!argv.quiet) {
        displayLogo();
    }
    
    try {
        // Skip dependency check if flag is set
        if (!argv['skip-deps']) {
            await checkAndInstallDependencies();
        }
        await checkAndCreateEnvFile();
        
        let scannerType, startIndex, endIndex;

        if (argv.scanner) {
            // Use command line arguments if provided
            scannerType = argv.scanner;
            startIndex = argv.start || 1;
            endIndex = argv.end || null;
        } else {
            // Fall back to interactive mode if no scanner specified
            const answers = await inquirer.prompt(questions);
            scannerType = answers.scannerType;
            startIndex = answers.useRange ? parseInt(answers.startRange) : 1;
            endIndex = answers.useRange ? parseInt(answers.endRange) : null;
        }

        // Initialize the selected scanner
        const scanner = new FundraisingScanner(scannerType);
        
        // Run the scanner with specified range
        await scanner.run({
            startIndex: startIndex,
            endIndex: endIndex
        });
        
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

main();
