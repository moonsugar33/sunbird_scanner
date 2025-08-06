# Sunbird Scanner

## What does this do?

Sunbird Scanner is a custom built tool to scrape GoFundMe campaigns using [Puppeteer](https://pptr.dev/), and then reports campaign stats to a [Supabase](https://supabase.com/) table.

## Features

- Uses a loader script to support multiple tables
- Loads links directly from tables, using Supabase API
- Performant and fast
- Cross-platform
- Supports both Chuffed and GoFundMe


## Getting Started

This guide will walk you through the steps needed to set up the project. No prior experience is necessary — just follow the instructions below.

---

### Prerequisites

You'll need the following installed on your computer:

- **Git**: A tool to clone and manage the project code.
- **Bun**: A platform for running JavaScript code.
- **Supabase Account**: A backend-as-a-service platform where you'll set up your database.

---

### Step 1: Install Git

Git is a tool that helps you download and manage the project code.

1. Visit [git-scm.com](https://git-scm.com/).
2. Download the version for your operating system.
3. Run the installer and follow the default setup options.
4. After installation, open a terminal and type `git --version` to confirm Git is installed.

---

### Step 2: Install Bun

Bun is a fast all-in-one JavaScript runtime and toolkit.

1. Visit [bun.sh](https://bun.sh)
2. Install Bun using the following command:
   ```bash
   # For Windows (PowerShell):
   powershell -c "irm bun.sh/install.ps1|iex"
   
   # For macOS or Linux:
   curl -fsSL https://bun.sh/install | bash
   ```
3. After installation, open a terminal and type `bun --version` to confirm installation.

---

### Step 3: Clone the Project Repository

1. Open a terminal or command prompt.
2. Navigate to the folder where you'd like to store the project:
   ```bash
   cd path/to/your/folder
   ```
3. Run the following command to clone the project:
   ```bash
   git clone https://github.com/moonsugar33/sunbird_scanner
   ```
4. Navigate into the project folder:
   ```bash
   cd sunbird_scanner
   ```

---

### Step 4: Install Dependencies

The project dependencies are managed by Bun.

1. In the project folder, run:
   ```bash
   bun install
   ```
   This will download and set up everything needed.

---

### Step 5: Set Up a Supabase Database

Supabase is a service that provides a database and API for your project.

1. Go to [supabase.com](https://supabase.com/) and sign up for a free account.
2. Create a new project:
   - Enter a project name.
   - Choose a database region close to you.
   - Set a database password (keep this safe!).
3. Once the project is created, go to the "Table Editor" tab.
4. Create a new table with the following schema:

| Column Name | Data Type | Default | Constraints           |
|-------------|-----------|---------|-----------------------|
| `id`        | `int4`    | `auto`  | Primary Key           |
| `title`     | `text`    |         |                       |
| `link`      | `text`    |         |                       |
| `currency`  | `text`    |         |                       |
| `target`    | `int4`    |         |                       |
| `raised`    | `int4`    |         |                       |
| `donations` | `int4`    |         |                       |
| `updated_at`| `timestampz`| `now()`| Automatically Updated |

5. Save the table.

---

### Step 6: Get Your Supabase API Keys

1. In your Supabase dashboard, go to **Project Settings** > **Data API**.
2. Note the **`Project URL`** on this page.
3. Then, navigate to **Project Settings** > **API Keys** and go to the **Legacy API Keys** tab.
4. Note the **`anon`** (public) key on this page.
5. Paste these two values into your terminal when requested. ``run.js`` will ask for them automatically.

---

### You're Ready to Go!

Now, you have everything set up. Run your project using:
```bash
bun run.js
```

Or use the provided batch script:
```bash
run.bat
```

## Acknowledgements

 - [Script by Sneethan](https://sneethan.xyz)
 - [Databases by Supabase](https://supabase.com/)
 - [I am soft-sunbird](https://soft-sunbird.tumblr.com/) 

## Disclaimers

This code may break at any time if GoFundMe or Chuffed update their sites, and may have bugs and instablities. If you find bugs and know how to fix them, pull requests are very much appreciated.
