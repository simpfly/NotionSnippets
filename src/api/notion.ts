import { Client } from "@notionhq/client";
import { Preferences, Snippet, SnippetIndex, DatabaseMetadata } from "../types/index";
import { getPreferenceValues, showToast, Toast, Color } from "@raycast/api";

function mapNotionColor(notionColor: string): string | undefined {
  const map: Record<string, string> = {
    default: Color.SecondaryText,
    gray: Color.SecondaryText,
    brown: Color.SecondaryText, // Brown not in common Raycast Color?
    orange: Color.Orange,
    yellow: Color.Yellow,
    green: Color.Green,
    blue: Color.Blue,
    purple: Color.Purple,
    pink: Color.Magenta,
    red: Color.Red,
  };
  return map[notionColor.toLowerCase()];
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    if (retries > 0 && (error.code === "ECONNRESET" || error.status === 502 || error.status === 429)) {
       console.log(`Retrying after error: ${error.code || error.status}. Retries left: ${retries}`);
       await new Promise(res => setTimeout(res, delay));
       return withRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
}

function extractIcon(iconObj: any): string | undefined {
  if (!iconObj) return undefined;
  if (iconObj.type === "emoji") return iconObj.emoji;
  if (iconObj.type === "external") return iconObj.external.url;
  if (iconObj.type === "file") return iconObj.file.url;
  return undefined;
}

// Fetch full snippet content on demand
export async function fetchSnippetContent(pageId: string): Promise<string> {
  const preferences = getPreferenceValues<Preferences>();
  const notion = new Client({ auth: preferences.notionToken });
  
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    const props = (page as any).properties;
    
    const findProp = (names: string[]) => {
      for (const name of names) {
        const match = Object.keys(props).find((key) => key.toLowerCase() === name);
        if (match) return props[match];
      }
      return undefined;
    };
    
    const contentProp = findProp([
      "content", "body", "text", "snippet content", "value", "内容", "正文", "snippet text",
      "url", "website", "href", "link", "summary", "ai summary", "dic", "description", "desc"
    ]);
    
    let content = "";
    if (contentProp?.type === "url") {
      content = contentProp.url || "";
    } else if (contentProp?.type === "title" && Array.isArray(contentProp.title)) {
      content = contentProp.title.map((t: any) => t?.plain_text || "").join("");
    } else if (contentProp?.type === "rich_text" && Array.isArray(contentProp.rich_text)) {
      content = contentProp.rich_text.map((t: any) => t?.plain_text || "").join("");
    } else {
      const textProps = Object.keys(props).filter(k => props[k].type === "rich_text" && props[k].rich_text?.length > 0);
      if (textProps.length > 0) {
        const bestKey = textProps.reduce((a, b) => 
          props[a].rich_text.map((t:any)=>t.plain_text).join("").length > props[b].rich_text.map((t:any)=>t.plain_text).join("").length ? a : b
        );
        content = props[bestKey].rich_text.map((t: any) => t?.plain_text || "").join("");
      }
    }
    
    const urlKey = Object.keys(props).find(k => props[k].type === "url" && props[k].url);
    if (!content && urlKey) content = props[urlKey].url;
    
    return content || "";
  } catch (error) {
    console.error(`Failed to fetch content for snippet ${pageId}:`, error);
    return "";
  }
}

export async function fetchSnippets(
  onProgress?: (count: number) => void, 
  onBatch?: (snippets: SnippetIndex[]) => void,
  onError?: (error: Error, dbId: string, pageCount: number, cursor?: string) => Promise<boolean> // Return true to retry
): Promise<SnippetIndex[]> {
  console.log("fetchSnippets: Function called");
  const preferences = getPreferenceValues<Preferences>();
  const notion = new Client({ auth: preferences.notionToken });

  const dbIdsRaw = (preferences.databaseIds || "").replace(/[\[\]"']/g, "").split(",");
  const dbIds = Array.from(new Set(dbIdsRaw.map((id) => id.trim()).filter(id => id.length > 5)));
  
  console.log(`fetchSnippets: Starting parallel fetch for ${dbIds.length} databases (NO LIMITS)`);

  let totalFound = 0;
  let totalExtracted = 0;
  
  // Process databases sequentially instead of in parallel to reduce memory peak
  // This is slower but much safer for large datasets
  const allSnippets: SnippetIndex[] = [];
  
  for (const dbId of dbIds) {
    const dbSnippets = await (async () => {
    try {
      console.log(`fetchSnippets: [${dbId}] Starting fetch...`);
      const snippets: SnippetIndex[] = [];
      let hasMore = true;
      let startCursor: string | undefined = undefined;
      let pageCount = 0;

      // NO LIMITS - fetch all data with retry support
      const MAX_RETRIES = 3;
      let retryCount = 0;
      
      while (hasMore) {
        try {
          pageCount++;
          console.log(`fetchSnippets: [${dbId}] Querying page ${pageCount} (cursor: ${startCursor || "start"})`);
          
          const response = await withRetry(() => notion.databases.query({
            database_id: dbId,
            start_cursor: startCursor,
          }));

          console.log(`fetchSnippets: [${dbId}] Received page ${pageCount} (${response.results.length} results)`);
          
          let pageExtracted = 0;
          for (const page of response.results) {
            if ("properties" in page) {
              const snippet = extractSnippetIndexFromPage(page, dbId);
              if (snippet) {
                snippets.push(snippet);
                pageExtracted++;
              }
            }
          }

          totalFound += response.results.length;
          totalExtracted += pageExtracted;
          
          console.log(`fetchSnippets: [${dbId}] Extracted ${pageExtracted}/${response.results.length} from this page`);

          // Batch updates: use very small batches and immediate processing
          if (onBatch && pageExtracted > 0) {
            // Send only the new items from this page, not all accumulated items
            const newItems = snippets.slice(-pageExtracted);
            // Very small batch size (5) to minimize memory pressure
            const BATCH_SIZE = 5;
            for (let i = 0; i < newItems.length; i += BATCH_SIZE) {
              const batch = newItems.slice(i, i + BATCH_SIZE);
              onBatch(batch);
              // Delay between batches to allow processing and GC
              if (i + BATCH_SIZE < newItems.length) {
                await new Promise(resolve => setTimeout(resolve, 50));
              }
            }
          }
          
          if (onProgress) onProgress(totalExtracted);
          
          // Aggressive cleanup: clear old items from memory every 10 pages
          if (pageCount % 10 === 0 && snippets.length > 100) {
            console.log(`fetchSnippets: [${dbId}] Memory cleanup: keeping last 100 items, clearing older ones`);
            // Keep only the most recent 100 items in memory during fetch
            // The rest are already sent via onBatch
            snippets.splice(0, snippets.length - 100);
          }
          
          // Small delay every 50 pages to allow GC
          if (pageCount % 50 === 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }

          hasMore = response.has_more;
          startCursor = response.next_cursor || undefined;
          retryCount = 0; // Reset retry count on success
          
        } catch (error: any) {
          const errorMessage = error?.message || String(error);
          const isMemoryError = errorMessage.includes("memory") || errorMessage.includes("heap");
          
          console.error(`fetchSnippets: [${dbId}] Error on page ${pageCount}:`, errorMessage);
          
          if (isMemoryError && retryCount < MAX_RETRIES && onError) {
            retryCount++;
            console.log(`fetchSnippets: [${dbId}] Memory error detected, attempting recovery (attempt ${retryCount}/${MAX_RETRIES})`);
            
            // Clear accumulated snippets to free memory
            const savedCount = snippets.length;
            snippets.splice(0, snippets.length);
            
            // Notify error handler
            const shouldRetry = await onError(error, dbId, pageCount, startCursor);
            
            if (shouldRetry) {
              console.log(`fetchSnippets: [${dbId}] Retrying from page ${pageCount} (saved ${savedCount} items so far)`);
              // Wait a bit before retry to allow GC
              await new Promise(resolve => setTimeout(resolve, 1000));
              continue; // Retry the same page
            } else {
              console.log(`fetchSnippets: [${dbId}] Recovery cancelled by error handler`);
              break;
            }
          } else {
            // Non-memory error or max retries reached
            throw error;
          }
        }
      }
      
      // No limits - just log progress
      if (pageCount > 0 && pageCount % 50 === 0) {
        console.log(`fetchSnippets: [${dbId}] Progress: ${pageCount} pages, ${snippets.length} snippets`);
      }

      console.log(`fetchSnippets: [${dbId}] Completed. Collected ${snippets.length} total.`);
      return snippets;
    } catch (error: any) {
      console.error(`fetchSnippets: [${dbId}] Error:`, error);
      return [];
    }
    })();
    
    allSnippets.push(...dbSnippets);
    totalExtracted += dbSnippets.length;
    
    // Clear memory after each database - small delay to allow GC
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(`fetchSnippets: Sync Finished. Total Results: ${totalFound}, Successfully Extracted: ${allSnippets.length}`);
  return allSnippets;
}

function extractSnippetIndexFromPage(page: any, dbId: string): SnippetIndex | null {
  const props = page.properties;
  if (!props) return null;

  const findProp = (names: string[]) => {
    for (const name of names) {
      const match = Object.keys(props).find((key) => key.toLowerCase() === name);
      if (match) return props[match];
    }
    return undefined;
  };

  const nameProp = findProp(["name", "title", "label", "snippet name", "标题", "名称", "snippet title", "task", "subject"]);
  const contentProp = findProp([
    "content", "body", "text", "snippet content", "value", "内容", "正文", "snippet text",
    "url", "website", "href", "link", "summary", "ai summary", "dic", "description", "desc"
  ]);
  const triggerProp = findProp(["trigger", "shortcut", "key", "keyword", "触发词", "快捷键", "snippet trigger", "trigger word", "alias"]);
  const descProp = findProp(["description", "desc", "info", "notes", "描述", "备注", "snippet description", "summary"]);

  let name = "Untitled";
  try {
    if (nameProp?.type === "title" && Array.isArray(nameProp.title)) {
      name = nameProp.title[0]?.plain_text || "Untitled";
    } else if (nameProp?.type === "rich_text" && Array.isArray(nameProp.rich_text)) {
      name = nameProp.rich_text[0]?.plain_text || "Untitled";
    } else {
       // FALLBACK: Find ANY title or rich_text property if specific ones aren't found
       const anyTitleKey = Object.keys(props).find(k => props[k].type === "title");
       if (anyTitleKey && props[anyTitleKey].title?.[0]) {
         name = props[anyTitleKey].title[0].plain_text || "Untitled";
       }
    }
  } catch (e) { /* silent */ }

  let content = "";
  try {
    if (contentProp?.type === "url") {
      content = contentProp.url || "";
    } else if (contentProp?.type === "title" && Array.isArray(contentProp.title)) {
      content = contentProp.title.map((t: any) => t?.plain_text || "").join("");
    } else if (contentProp?.type === "rich_text" && Array.isArray(contentProp.rich_text)) {
      content = contentProp.rich_text.map((t: any) => t?.plain_text || "").join("");
    } else {
      // FALLBACK: Find the largest rich_text field that isn't the name
      const textProps = Object.keys(props).filter(k => props[k].type === "rich_text" && props[k].rich_text?.length > 0);
      if (textProps.length > 0) {
        // Pick the one with the most content
        const bestKey = textProps.reduce((a, b) => 
          props[a].rich_text.map((t:any)=>t.plain_text).join("").length > props[b].rich_text.map((t:any)=>t.plain_text).join("").length ? a : b
        );
        content = props[bestKey].rich_text.map((t: any) => t?.plain_text || "").join("");
      }
    }
  } catch (e) { /* silent */ }

  // Fallback: If content is still empty, look for any URL property
  if (!content) {
    const urlKey = Object.keys(props).find(k => props[k].type === "url" && props[k].url);
    if (urlKey) content = props[urlKey].url;
  }

  // Fallback: If name is generic/missing and we have content (common for "Say"/Microblog DBs),
  // use the first sentence of the content as the name.
  if ((name === "Untitled" || name.trim() === "") && content.trim().length > 0) {
      name = content.split('\n')[0].substring(0, 60).trim();
  }

  let type, typeColor, status, statusColor;
  const typeProp = findProp(["type", "category", "label", "tag", "类型", "分类", "标签"]);
  if (typeProp?.type === "select" && typeProp.select) {
    type = typeProp.select.name;
    typeColor = mapNotionColor(typeProp.select.color);
  } else if (typeProp?.type === "multi_select" && typeProp.multi_select?.[0]) {
    type = typeProp.multi_select[0].name;
    typeColor = mapNotionColor(typeProp.multi_select[0].color);
  }

  const statusProp = findProp(["status", "state", "stage", "状态", "阶段"]);
  if (statusProp?.status) {
    status = statusProp.status.name;
    statusColor = mapNotionColor(statusProp.status.color);
  } else if (statusProp?.select) {
    status = statusProp.select.name;
    statusColor = mapNotionColor(statusProp.select.color);
  }

  let trigger = undefined;
  if (triggerProp?.type === "rich_text" && Array.isArray(triggerProp.rich_text)) {
    trigger = triggerProp.rich_text[0]?.plain_text;
  }

  let description = undefined;
  if (descProp?.type === "rich_text" && Array.isArray(descProp.rich_text)) {
    description = descProp.rich_text[0]?.plain_text;
  }

  const usageProp = findProp(["usage count", "usage", "count", "times used", "copy count", "使用次数", "使用", "次数"]);
  const lastUsedProp = findProp(["last used", "last used at", "recent", "time", "date", "最后使用", "时间", "日期"]);

  let usageCount = 0;
  if (usageProp?.type === "number") usageCount = usageProp.number || 0;

  let lastUsed = undefined;
  if (lastUsedProp?.type === "date") lastUsed = lastUsedProp.date?.start;

  const previewProp = findProp(["preview", "image", "thumb", "picture", "预览图", "img", "pic"]);
  let preview = undefined;
  try {
    if (previewProp?.type === "files" && Array.isArray(previewProp.files) && previewProp.files[0]) {
      const fileObj = previewProp.files[0];
      preview = fileObj.type === "file" ? fileObj.file?.url : fileObj.external?.url;
    }
  } catch (e) { /* silent */ }

  if (!content && description) content = description;

  if ((!name || name === "Untitled") && content) {
    const firstLine = content.split("\n")[0];
    const firstSentence = firstLine.split(/[.!?。！？]/)[0];
    name = firstSentence.substring(0, 30).trim() + (firstLine.length > 30 ? "..." : "");
  }

  if (!content) {
    // If we have snippets but they are failing to extract the content property, this is the main issue.
    // console.log(`extractSnippetIndexFromPage: Failed to extract content. Page ID: ${page.id}, Properties present:`, Object.keys(props).join(", "));
    return null;
  }

  // Store only preview (first 500 chars) and length - full content loaded on demand
  const contentPreview = content.length > 500 ? content.substring(0, 500) + "..." : content;
  const contentLength = content.length;

  return {
    id: page.id,
    name: name, // No length limit
    contentPreview,
    contentLength,
    trigger: trigger, // No length limit
    description: description && description.length > 1000 ? description.substring(0, 1000) + "..." : description,
    databaseId: dbId,
    preview,
    usageCount,
    lastUsed,
    url: page.url,
    type,
    typeColor,
    status,
    statusColor,
  };
}

// Helper to convert index to full snippet (for backward compatibility)
export function snippetIndexToSnippet(index: SnippetIndex, content: string): Snippet {
  return {
    ...index,
    content,
  };
}

export async function updateSnippet(
  pageId: string,
  payload: {
    name: string;
    content: string;
    trigger?: string;
  }
): Promise<void> {
  const preferences = getPreferenceValues<Preferences>();
  const notion = new Client({ auth: preferences.notionToken });

  const page = await notion.pages.retrieve({ page_id: pageId });
  const props = (page as any).properties;

  const findPropName = (names: string[], type: string) => {
    return Object.keys(props).find((key) => {
      const p = props[key];
      return names.includes(key.toLowerCase()) && p.type === type;
    });
  };

  const titleKey = Object.keys(props).find((key) => props[key].type === "title") || "Name";
  const contentKey =
    findPropName(["content", "body", "text", "snippet content", "value", "内容", "正文"], "rich_text") ||
    Object.keys(props).find((k) => props[k].type === "rich_text" && k.toLowerCase().includes("content")) ||
    "Content";
  const triggerKey = findPropName(["trigger", "shortcut", "key", "keyword", "触发词", "快捷键"], "rich_text") || "Trigger";

  const properties: any = {
    [titleKey]: {
      title: [{ text: { content: payload.name } }],
    },
    [contentKey]: {
      rich_text: [{ text: { content: payload.content } }],
    },
  };

  if (payload.trigger !== undefined && props[triggerKey]) {
    properties[triggerKey] = {
      rich_text: [{ text: { content: payload.trigger } }],
    };
  }

  await notion.pages.update({
    page_id: pageId,
    properties: properties,
  });
}

export async function updateSnippetUsage(
  pageId: string,
  currentUsageCount: number = 0
): Promise<void> {
  const preferences = getPreferenceValues<Preferences>();
  const notion = new Client({ auth: preferences.notionToken });

  try {
      const page = await notion.pages.retrieve({ page_id: pageId });
      const props = (page as any).properties;

      const findPropName = (names: string[], type: string) => {
        return Object.keys(props).find((key) => {
          const p = props[key];
          return names.includes(key.toLowerCase()) && p.type === type;
        });
      };

      const usageKey = findPropName(["usage count", "usage", "count", "times used", "copy count", "使用次数", "使用", "次数"], "number");
      const lastUsedKey = findPropName(["last used", "last used at", "recent", "time", "date", "最后使用", "时间", "日期"], "date");

      const properties: any = {};
      
      if (usageKey) {
        properties[usageKey] = { number: currentUsageCount + 1 };
      }
      
      if (lastUsedKey) {
        properties[lastUsedKey] = { date: { start: new Date().toISOString() } };
      }

      if (Object.keys(properties).length > 0) {
        await notion.pages.update({
          page_id: pageId,
          properties: properties,
        });
        console.log(`Updated usage for snippet ${pageId}: count=${currentUsageCount + 1}`);
      } else {
        console.warn(`Could not find Usage/Last Used properties for page ${pageId}`);
      }

  } catch (e) {
    console.error(`Failed to update usage for snippet ${pageId}`, e);
  }
}

export async function createSnippet(payload: {
  dbId: string;
  name: string;
  content: string;
  trigger?: string;
}): Promise<string> {
  const preferences = getPreferenceValues<Preferences>();
  const notion = new Client({ auth: preferences.notionToken });

  const db = await notion.databases.retrieve({ database_id: payload.dbId });
  const props = db.properties;

  const findPropName = (names: string[], type: string) => {
    return Object.keys(props).find((key) => {
      const p = props[key];
      return names.includes(key.toLowerCase()) && p.type === type;
    });
  };

  const titleKey = Object.keys(props).find((key) => props[key].type === "title") || "Name";
  const contentKey = findPropName(["content", "body", "text", "snippet content", "value", "内容", "正文"], "rich_text") || 
                     Object.keys(props).find(k => props[k].type === "rich_text" && k.toLowerCase().includes("content")) ||
                     "Content";
  const triggerKey = findPropName(["trigger", "shortcut", "key", "keyword", "触发词", "快捷键"], "rich_text") || "Trigger";

  const properties: any = {
    [titleKey]: {
      title: [{ text: { content: payload.name } }],
    },
    [contentKey]: {
      rich_text: [{ text: { content: payload.content } }],
    },
  };

  if (payload.trigger && props[triggerKey]) {
    properties[triggerKey] = {
      rich_text: [{ text: { content: payload.trigger } }],
    };
  }

  const response = await notion.pages.create({
    parent: { database_id: payload.dbId },
    properties: properties,
  });

  return response.id;
}

export async function fetchDatabases(): Promise<DatabaseMetadata[]> {
  console.log("fetchDatabases: Starting...");
  const preferences = getPreferenceValues<Preferences>();
  const notion = new Client({ auth: preferences.notionToken });
  
  const dbIdsRaw = (preferences.databaseIds || "").replace(/[\[\]"']/g, "").split(",");
  const dbIds = Array.from(new Set(dbIdsRaw.map((id) => id.trim()).filter(id => id.length > 5)));
  
  console.log(`fetchDatabases: Fetching metadata for ${dbIds.length} unique databases`);

  const fetchTasks = dbIds.map(async (id) => {
    try {
      console.log(`fetchDatabases: [${id}] Retrieving metadata...`);
      const res = await withRetry(() => notion.databases.retrieve({ database_id: id }));
      let title = id.substring(0, 8);
      if ("title" in res && Array.isArray(res.title)) {
        title = res.title[0]?.plain_text || title;
      }
      const icon = extractIcon((res as any).icon);
      console.log(`fetchDatabases: [${id}] Metadata retrieved: ${title}`);
      return { id, title, icon };
    } catch (e) {
      console.error(`fetchDatabases: [${id}] Failed:`, e);
      return { id, title: `Database (${id.substring(0, 6)}...)` };
    }
  });

  const results = await Promise.all(fetchTasks);
  console.log(`fetchDatabases: All complete. Found ${results.length} entries.`);
  return results;
}
