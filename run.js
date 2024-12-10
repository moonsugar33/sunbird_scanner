import inquirer from 'inquirer';
import { spawn } from 'child_process';
import figlet from 'figlet';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { FundraisingScanner, SCANNER_CONFIGS } from './scanner.js';

const execAsync = promisify(exec);

// Get current file's directory (needed for ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
    displayLogo();
    
    try {
        await checkAndInstallDependencies();
        await checkAndCreateEnvFile();
        
        const answers = await inquirer.prompt(questions);
        
        // Initialize the selected scanner
        const scanner = new FundraisingScanner(answers.scannerType);
        
        // Run the scanner with any specified range
        await scanner.run({
            startIndex: answers.useRange ? parseInt(answers.startRange) : 1,
            endIndex: answers.useRange ? parseInt(answers.endRange) : null
        });
        
    } catch (error) {
        console.error('Error:', error);
    }
}

main();
