import inquirer from 'inquirer';
import { spawn } from 'child_process';
import figlet from 'figlet';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

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

// Script selection questions
const questions = [
    {
        type: 'list',
        name: 'script',
        message: 'Which script would you like to run?',
        choices: [
            { name: '1. GazaVetters Index', value: 'index' },
            { name: '2. Sunbirds Index', value: 'sunbird' }
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
        message: 'Enter start index:',
        default: '0',
        when: (answers) => answers.useRange,
        validate: (value) => !isNaN(value) || 'Please enter a valid number'
    },
    {
        type: 'input',
        name: 'endRange',
        message: 'Enter end index:',
        when: (answers) => answers.useRange,
        validate: (value) => !isNaN(value) || 'Please enter a valid number'
    }
];

async function main() {
    displayLogo();
    
    try {
        // Dynamically import inquirer
        const inquirer = await import('inquirer');
        const answers = await inquirer.default.prompt(questions);
        
        // Construct the command and arguments
        const script = answers.script === 'index' ? 'index.js' : 'Sunbird.js';
        const args = ['node', script];
        
        if (answers.useRange) {
            args.push('--start', answers.startRange, '--end', answers.endRange);
        }
        
        // Use spawn instead of exec for better output handling
        const child = spawn('node', [script, ...args], {
            stdio: 'inherit' // This will pipe all output directly to the parent process
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
