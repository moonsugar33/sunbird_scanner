import inquirer from 'inquirer';
import { spawn } from 'child_process';
import figlet from 'figlet';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Get current file's directory (needed for ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
        name: 'script',
        message: 'Which script would you like to run?',
        choices: [
            { name: '1. GazaVetters index', value: 'index' },
            { name: "2. soft-sunbird's index", value: 'sunbird' }
        ]
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
        // Check and install dependencies first
        await checkAndInstallDependencies();
        
        // Check and create .env file if needed
        await checkAndCreateEnvFile();
        
        const answers = await inquirer.prompt(questions);
        
        const script = answers.script === 'index' ? 'index.js' : 'Sunbird.js';
        const args = [];
        
        if (answers.useRange) {
            // Convert user's 1-based input to 0-based index for start
            const startIndex = parseInt(answers.startRange) - 1;
            // Keep endIndex as-is since slice is exclusive
            const endIndex = parseInt(answers.endRange);
            
            if (isNaN(startIndex) || isNaN(endIndex)) {
                throw new Error('Invalid range values provided');
            }
            
            args.push('--start', startIndex.toString(), '--end', endIndex.toString());
        }        
        
        const child = spawn('node', [script, ...args], {
            stdio: 'inherit'
        });

        child.on('error', (error) => {
            console.error(`Error: ${error.message}`);
        });

        child.on('exit', (code) => {
            if (code !== 0) {
                console.log(`Process exited with code ${code}`);
            }
        });
        
    } catch (error) {
        console.error('Error:', error);
    }
}

main();
