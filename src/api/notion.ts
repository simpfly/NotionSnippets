import { Client } from "@notionhq/client";
import { Preferences, Snippet } from "../types/index";
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

export async function fetchSnippets(): Promise<Snippet[]> {
  console.log("fetchSnippets: Function called");
  let preferences: Preferences;
  
  try {
    preferences = getPreferenceValues<Preferences>();
    console.log("fetchSnippets: Preferences loaded", { 
      hasToken: !!preferences.notionToken, 
      dbIdsLen: preferences.databaseIds?.length 
    });
  } catch (e) {
    console.error("fetchSnippets: Failed to load preferences", e);
    throw new Error("Failed to load Raycast preferences. Please check your extension settings.");
  }

  let notion: Client;
  try {
    notion = new Client({ auth: preferences.notionToken });
    console.log("fetchSnippets: Notion Client initialized");
  } catch (e) {
    console.error("fetchSnippets: Failed to init Notion Client", e);
    throw new Error("Invalid Notion Token.");
  }

  const dbIds = (preferences.databaseIds || "").replace(/[\[\]"']/g, "").split(",").map((id) => id.trim()).filter(id => id.length > 0);
  console.log(`fetchSnippets: Parsing ${dbIds.length} Database IDs`);

  const allSnippets: Snippet[] = [];

  for (const dbId of dbIds) {
    if (!dbId || dbId.length < 5) continue;

    try {
      // Fetch database details once per database
      let dbName = dbId;
      try {
        const dbInfo = await notion.databases.retrieve({ database_id: dbId });
        if ("title" in dbInfo && Array.isArray(dbInfo.title) && dbInfo.title.length > 0) {
          dbName = dbInfo.title[0].plain_text;
        } else if ("title" in dbInfo && Array.isArray(dbInfo.title)) {
          dbName = "Untitled Database";
        }
      } catch (e) {
        console.warn(`Could not fetch title for DB ${dbId}`, e);
      }

      let hasMore = true;
      let startCursor: string | undefined = undefined;

      while (hasMore) {
        console.log(`fetchSnippets: Querying database ${dbId} ("${dbName}") with cursor ${startCursor}...`);
        const response = await notion.databases.query({
          database_id: dbId,
          start_cursor: startCursor,
        });

        console.log(`fetchSnippets: Database ${dbId} ("${dbName}") responded. Results: ${response.results.length}`);

        if (response.results.length === 0) {
          console.warn(`Database ${dbId} returned 0 results.`);
          // Only show toast if it's the first page and empty
          if (!startCursor) { 
             showToast({
              style: Toast.Style.Animated,
              title: "Database Empty or Hidden",
              message: `DB: ${dbName} returned zero items.`,
            });
          }
        }

        for (const page of response.results) {
          if ("properties" in page) {
            const props = (page as any).properties;

            const findProp = (names: string[]) => {
              if (!props) return undefined;
              const match = Object.keys(props).find((key) => names.includes(key.toLowerCase()));
              return match ? props[match] : undefined;
            };

            const nameProp = findProp(["name", "title", "label", "snippet name", "标题", "名称", "snippet title"]);
            const contentProp = findProp(["content", "body", "text", "snippet content", "value", "内容", "正文", "snippet text"]);
            const triggerProp = findProp(["trigger", "shortcut", "key", "keyword", "触发词", "快捷键", "snippet trigger", "trigger word"]);
            const descProp = findProp(["description", "desc", "info", "notes", "描述", "备注", "snippet description"]);

            // Extract Name
            let name = "Untitled";
            try {
               if (nameProp?.type === "title" && Array.isArray((nameProp as any).title)) {
                  name = (nameProp as any).title[0]?.plain_text || "Untitled";
               } else if (nameProp?.type === "rich_text" && Array.isArray((nameProp as any).rich_text)) {
                  name = (nameProp as any).rich_text[0]?.plain_text || "Untitled";
               }
            } catch (e) {
               console.log("Error extracting name property", e);
            }

            // Extract Content
            let content = "";
            try {
               if (contentProp?.type === "rich_text" && Array.isArray((contentProp as any).rich_text)) {
                 content = (contentProp as any).rich_text.map((t: any) => t?.plain_text || "").join("");
               } else if (contentProp?.type === "title" && Array.isArray((contentProp as any).title)) {
                 content = (contentProp as any).title.map((t: any) => t?.plain_text || "").join("");
               } else if (contentProp?.type === "url") {
                 content = (contentProp as any).url || "";
               }
            } catch (e) {
               console.log("Error extracting content property", e);
            }

            // Extract Type and Status
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
            if (statusProp?.type === "status" && statusProp.status) {
              status = statusProp.status.name;
              statusColor = mapNotionColor(statusProp.status.color);
            } else if (statusProp?.type === "select" && statusProp.select) {
              status = statusProp.select.name;
              statusColor = mapNotionColor(statusProp.select.color);
            }

            // Extract Trigger
            let trigger = undefined;
            try {
               if (triggerProp?.type === "rich_text" && Array.isArray((triggerProp as any).rich_text)) {
                  trigger = (triggerProp as any).rich_text[0]?.plain_text;
               } else if (triggerProp?.type === "title" && Array.isArray((triggerProp as any).title)) {
                  trigger = (triggerProp as any).title[0]?.plain_text;
               }
            } catch (e) { console.log("Error extracting trigger", e); }



            // Extract Description
            let description = undefined;
            try {
               if (descProp?.type === "rich_text" && Array.isArray((descProp as any).rich_text)) {
                  description = (descProp as any).rich_text[0]?.plain_text;
               }
            } catch (e) { console.log("Error extracting description", e); }

            // Extract Usage Stats
            const usageProp = findProp(["usage count", "usage", "count", "times used", "copy count", "使用次数", "使用", "次数"]);
            const lastUsedProp = findProp(["last used", "last used at", "recent", "time", "date", "最后使用", "时间", "日期"]);

            let usageCount = 0;
            if (usageProp?.type === "number") {
               usageCount = (usageProp as any).number || 0;
            }

            let lastUsed = undefined;
            if (lastUsedProp?.type === "date") {
               lastUsed = (lastUsedProp as any).date?.start;
            }

            // Extract Preview Image
            const previewProp = findProp(["preview", "image", "thumb", "picture", "预览图", "img", "pic"]);
            let preview = undefined;
            try {
               if (previewProp?.type === "files" && Array.isArray((previewProp as any).files)) {
                  const files = (previewProp as any).files;
                  if (files.length > 0) {
                     const fileObj = files[0];
                     if (fileObj.type === "file") {
                        preview = fileObj.file?.url;
                     } else if (fileObj.type === "external") {
                        preview = fileObj.external?.url;
                     }
                  }
               }
            } catch (e) { console.log("Error extracting preview image", e); }

            // Fallback: If content is empty, use description as content
            if (!content && description) {
              console.log(`Using description as content for snippet: ${name}`);
              content = description;
            }

            // Fallback: If name is "Untitled", use first sentence of content
            if ((!name || name === "Untitled") && content) {
               const firstLine = content.split('\n')[0];
               // Split by common punctuation (English and CJK)
               const firstSentence = firstLine.split(/[.!?。！？]/)[0];
               name = firstSentence.substring(0, 30).trim();
               if (firstLine.length > 30) name += "...";
               if (!name) name = "Untitled"; 
            }

            if (content) {
              allSnippets.push({
                id: page.id,
                name,
                content,
                trigger,
                description,
                sourceDb: dbName,
                databaseId: dbId,
                preview, 
                usageCount,
                lastUsed,
                url: (page as any).url,
                type,
                typeColor,
                status,
                statusColor,
              });
            }
          }
        }
      } // End while loop
    } catch (error: any) {
      console.error(`fetchSnippets: Error processing DB ${dbId}:`, error);
      showToast({
        style: Toast.Style.Failure,
        title: "Notion Sync Error",
        message: error.message || String(error),
      });
    }
  }

  console.log(`fetchSnippets: Completed. Found ${allSnippets.length} snippets.`);
  return allSnippets;
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
      // We need to find the correct property names again since they might vary per database
      // Optimization: We can't cache property IDs easily without more complex logic, 
      // so we will query the page to get the property IDs or Names.
      // But since this is "fire-and-forget", a little overhead is acceptable.
      
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
    // Suppress error toast since this is a background operation
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

  // 1. Fetch DB properties to find correct keys
  const db = await notion.databases.retrieve({ database_id: payload.dbId });
  const props = db.properties;

  const findPropName = (names: string[], type: string) => {
    return Object.keys(props).find((key) => {
      const p = props[key];
      return names.includes(key.toLowerCase()) && p.type === type;
    });
  };

  // Detect properties
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

export async function fetchDatabases(): Promise<{ id: string; title: string }[]> {
  const preferences = getPreferenceValues<Preferences>();
  const notion = new Client({ auth: preferences.notionToken });
  const dbIds = (preferences.databaseIds || "").replace(/[\[\]"']/g, "").split(",").map((id) => id.trim()).filter(id => id.length > 0);
  
  const dbs: { id: string; title: string }[] = [];
  for (const id of dbIds) {
    try {
      const res = await notion.databases.retrieve({ database_id: id });
      let title = id.substring(0, 8);
      if ("title" in res && Array.isArray(res.title)) {
        title = res.title[0]?.plain_text || title;
      }
      dbs.push({ id, title });
    } catch (e) {
      console.error(`Failed to fetch title for DB ${id}`, e);
      dbs.push({ id, title: `Database (${id.substring(0, 6)}...)` });
    }
  }
  return dbs;
}
