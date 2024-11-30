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

async function main() {
    displayLogo();
    
    try {
        const inquirer = await import('inquirer');
        const answers = await inquirer.default.prompt(questions);
        
        const script = answers.script === 'index' ? 'index.js' : 'Sunbird.js';
        const args = ['node', script];
        
        if (answers.useRange) {
            // Get the raw user inputs (1-based)
            const userStart = parseInt(answers.startRange);
            const userEnd = parseInt(answers.endRange);
            
            // Calculate total items to process
            const totalItems = userEnd - userStart + 1;
            
            // Convert start to 0-based for array indexing
            const startIndex = userStart - 1;
            // End index is start plus total items
            const endIndex = startIndex + totalItems;
        
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
