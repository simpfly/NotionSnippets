import { Client } from "@notionhq/client";
import { Preferences, Snippet } from "../types/index";
import { getPreferenceValues, showToast, Toast } from "@raycast/api";

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
      let hasMore = true;
      let startCursor: string | undefined = undefined;

      while (hasMore) {
        console.log(`fetchSnippets: Querying database ${dbId} with cursor ${startCursor}...`);
        const response = await notion.databases.query({
          database_id: dbId,
          start_cursor: startCursor,
        });

        if (!response || !response.results) {
           console.warn(`fetchSnippets: Invalid response from DB ${dbId}`);
           break;
        }
        
        hasMore = response.has_more;
        startCursor = response.next_cursor || undefined;

        // Fetch database details to get the title
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
