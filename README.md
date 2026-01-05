# Notion Snippets for Raycast

<img src="assets/icon.png" width="128" height="128" />

Turn your Notion databases into a high-performance snippet manager for Raycast. Sync code snippets, canned responses, microblogs, and bookmarks instanty.

## ✨ Features

- **🚀 High Performance**:
  - **Lightweight Indexing**: Loads metadata first, so you see your list instantly.
  - **On-Demand Loading**: Fetches full content only when you need it.
  - **Memory Safe**: Automatically manages memory usage (safe limit of 1000 recent items).
- **🧠 Smart Support**:
  - **Snippets**: Standard name/content/trigger support.
  - **Microblogs ("Say")**: Automatically handles "Untitled" posts by showing content as the title.
  - **Bookmarks ("Media")**: intelligently grabs URLs for bookmark items.
- **⚡️ Quick Actions**:
  - `Enter`: Paste to active app (fills placeholders if present).
  - `Cmd + C`: Copy content.
  - `Cmd + E`: Export selected snippets (great for AI contexts).
- **🧩 Dynamic Placeholders**: Supports standard placeholders (e.g., `{{clipboard}}`) and custom fillable forms.

## 🛠 Setup Guide

### 1. Create Integration

1. Go to [Notion My Integrations](https://www.notion.so/my-integrations).
2. Create a new integration (e.g., "Raycast Snippets").
3. **Copy the "Internal Integration Secret"**.

### 2. Connect Databases

You can use any database. The extension effectively guesses the right fields:

**Supported Fields (Case-Insensitive):**

- **Name**: `Name`, `Title`, `Subject`, `In`
- **Content**: `Content`, `Body`, `Code`, `URL`, `Link`
- **Trigger**: `Trigger`, `Keyword`, `Shortcut`
- **Description**: `Description`, `Notes`, `Tags`

**Important**:
Click the `...` menu on your Notion Database page -> `Connections` -> **Add your integration**.

### 3. Configure Raycast

1. Install this extension.
2. In Raycast Settings -> Extensions -> Notion Snippets:
   - **Notion Token**: Paste your secret starting with `secret_...`
   - **Database IDs**: Paste your Database ID(s). Can be multiple, separated by commas.

_(The Database ID is the 32-char code in your Notion URL, e.g. `notion.so/myworkspace/THIS_PART_IS_THE_ID?v=...`)_

## 💡 Usage Tips

- **Search Scope**: The search bar shows the total count. Select a specific database from the dropdown to filter the count.
- **Safety Limit**: To ensure Raycast stays fast, the extension fetches the **1000 most recently updated** items.
- **Microblogs**: Perfect for quick thoughts. If you leave the "Name" blank in Notion, the extension will display the start of your content as the title.

## License

MIT
