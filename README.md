# Notion Snippets for Raycast

Sync your personal code snippets, canned responses, and notes from Notion directly into Raycast.

## Features

- **Seamless Sync**: Fetches snippets from your specified Notion Database(s).
- **Smart Search**: Instantly fuzzy search through snippet names, content, and triggers.
- **Quick Actions**:
  - `Enter`: Paste snippet to the active application.
  - `Cmd + C`: Copy snippet content to clipboard.
  - `Cmd + E`: Export specialized prompts (for AI Context).
- **Dynamic Placeholders**: Supports standard placeholders (similar to Raycast Snippets) if you use them in your Notion content.

## Setup Guide

### 1. Prerequisities

You need a Notion Integration Token.

1. Go to [My Integrations](https://www.notion.so/my-integrations).
2. Create a new integration (e.g., "Raycast Snippets").
3. **Copy the "Internal Integration Secret"**.

### 2. Prepare Your Notion Database

Create a Database in Notion with the following properties (case-insensitive):

| Property Name | Type | Description |
|p ------------- | ----------- | ------------------------------------ |
| **Name** | Title | The name of the snippet. |
| **Content** | Text / URL | The actual text content to paste. |
| **Trigger** | Text | (Optional) A keyword or shortcut. |
| **Description**| Text | (Optional) Extra context or tags. |

**Important**:

- You must **share** this database with your integration. Click the `...` menu on the database page -> `Connections` -> Add your integration.
- Copy the **Database ID** from the URL.
  - URL format: `https://www.notion.so/myworkspace/DATABASE_ID?v=...`
  - It is the 32-character part before the `?`.

### 3. Configure Extension

1. Install this extension in Raycast.
2. Open Raycast Settings (`Cmd + ,`) -> Extensions -> Notion Snippets.
3. Paste your **Notion Token**.
4. Paste your **Database ID** (you can provide multiple IDs separated by commas).

## Usage

- **List View**: Shows all synced snippets.
- **Search**: Type to filter.
- **Multi-Select**: Use `Shift + Down` to select multiple snippets, then press `Enter` to export/copy them as a combined list (great for compiling prompts).

## Troubleshooting

- **"Database Empty or Hidden"**: ensure you have actually connected the specific database to your Integration user in Notion.
- **Crash / Error**: Check the logs or ensure your token is correct.

## License

MIT
