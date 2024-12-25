#!/usr/bin/env bash

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to install Bun based on OS
install_bun() {
    if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "win32" ]]; then
        powershell -c "iwr bun.sh/install.ps1|iex"
    else
        curl -fsSL https://bun.sh/install | bash
    fi
}

# Check if Bun is installed
if ! command_exists bun; then
    echo "Bun is not installed. Installing Bun..."
    install_bun
    
    # Add Bun to current session PATH
    if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "win32" ]]; then
        export PATH="$HOME/.bun/bin:$PATH"
    else
        export PATH="$HOME/.bun/bin:$PATH"
    fi
fi

# Verify Bun installation
if ! command_exists bun; then
    echo "Failed to install Bun. Please install it manually from https://bun.sh"
    exit 1
fi

echo "Using Bun version: $(bun --version)"

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    bun install
fi

# Run the scanner with error handling
echo "Starting Sunbird Scanner..."
if ! bun run start -- "$@"; then
    echo "Scanner failed to start. Check the error messages above."
    exit 1
fi 