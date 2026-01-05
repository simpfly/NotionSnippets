import { ActionPanel, Action, List, useNavigation, Clipboard, showToast, Toast, open, Icon, getPreferenceValues, confirmAlert, Alert, Color, closeMainWindow } from "@raycast/api"; 
import { useCachedState } from "@raycast/utils";
import { useEffect, useState, useMemo } from "react";
import { fetchSnippets, fetchDatabases, updateSnippetUsage } from "./api/notion";
import { Snippet, Preferences, DatabaseMetadata } from "./types/index";
import { parsePlaceholders, processOfficialPlaceholders } from "./utils/placeholder";
import SnippetForm from "./components/SnippetForm";
import FillerForm from "./components/FillerForm";
import fs from "fs";
import os from "os";
import path from "path";
import { exec } from "child_process";

export default function Command() {
  console.log("Rendering Notion Snippets Command");

  // State
  const preferences = getPreferenceValues<Preferences>();
  const [showMetadata, setShowMetadata] = useCachedState<boolean>("show-metadata", preferences.showMetadata);
  const [snippets, setSnippets] = useCachedState<Snippet[]>("notion-snippets", []);
  const [databases, setDatabases] = useCachedState<DatabaseMetadata[]>("notion-databases", []);
  const [selectedDbId, setSelectedDbId] = useState<string>("all");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [searchText, setSearchText] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [dbStatus, setDbStatus] = useState<string>("Initializing...");

  const dbMap = useMemo(() => {
    const map: Record<string, DatabaseMetadata> = {};
    databases.forEach(db => { map[db.id] = db; });
    return map;
  }, [databases]);
  
/**
 * ... (skipping unchanged lines for brevity in tool call, will target specific lines)
 */


  
  // Hooks
  const { push } = useNavigation();

  useEffect(() => {
    let isMounted = true;
    async function load() {
      setIsLoading(true);
      try {
        console.log("Index: Calling fetchDatabases()...");
        fetchDatabases().then(dbs => {
          if (isMounted) {
            setDatabases(dbs || []);
          }
        });

        console.log("Index: Calling fetchSnippets()...");
        const data = await fetchSnippets();
        if (isMounted) {
          const safeData = data || [];
          console.log(`Index: fetchSnippets returned ${safeData.length} items`);
          setSnippets(safeData);
          setDbStatus(safeData.length > 0 ? `Loaded ${safeData.length} snippets` : "No snippets found.");
        }
      } catch (error) {
        if (isMounted) {
          console.error("Index: fetchSnippets failed", error);
          setDbStatus(`Error: ${String(error)}`);
          showToast({
            style: Toast.Style.Failure,
            title: "Failed to fetch snippets",
            message: String(error),
          });
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }
    load();
    return () => { isMounted = false; };
  }, []);

  const refreshSnippets = async () => {
    console.log("refreshSnippets: Manually triggered");
    setIsLoading(true);
    try {
      const [data, dbs] = await Promise.all([fetchSnippets(), fetchDatabases()]);
      setSnippets(data || []);
      setDatabases(dbs || []);
      setDbStatus(data.length > 0 ? `Loaded ${data.length} snippets from ${dbs.length} databases` : "No snippets found.");
      console.log(`refreshSnippets: Successfully loaded ${data?.length} snippets`);
    } catch (error) {
      console.error("refreshSnippets: Failed", error);
      setDbStatus(`Error: ${String(error)}`);
    } finally {
      setIsLoading(false);
    }
  };

  const increaseUsage = (snippetId: string) => {
    // 1. Optimistic Update (Immediate UI feedback)
    const updatedSnippets = snippets.map(s => {
        if (s.id === snippetId) {
            return { 
                ...s, 
                usageCount: (s.usageCount || 0) + 1,
                lastUsed: new Date().toISOString()
            };
        }
        return s;
    });
    // Sort logic will automatically re-order them on next render if we updating state
    setSnippets(updatedSnippets);

    // 2. Fire and Forget API Update (Background)
    const snippet = snippets.find(s => s.id === snippetId);
    if (snippet) {
        // Use the OLD count for the increment logic in the API helper if needed, 
        // but here we pass the CURRENT known count. The API helper adds 1.
        updateSnippetUsage(snippetId, snippet.usageCount || 0).catch(err => {
            console.error("Background usage update failed", err);
        });
    }
  };

  const handleSelect = async (snippet: Snippet) => {
    console.log(`handleSelect: Processing snippet "${snippet.name}"`);
    if (!snippet || !snippet.content) return;
    
    // Expand official Raycast placeholders first
    const clipboardText = await Clipboard.readText() || "";
    console.log(`handleSelect: Clipboard read (${clipboardText.length} chars)`);
    
    // Extract argument if searchText starts with trigger + space
    let argument = "";
    if (snippet.trigger && searchText.startsWith(snippet.trigger + " ")) {
      argument = searchText.substring(snippet.trigger.length + 1);
    }

    const expandedContent = processOfficialPlaceholders(snippet.content, clipboardText, argument);
    
    const placeholders = parsePlaceholders(expandedContent) || [];
    if (placeholders.length > 0) {
      console.log(`handleSelect: Found ${placeholders.length} custom placeholders, pushing FillerForm`);
      push(<FillerForm 
        snippet={{ ...snippet, content: expandedContent }} 
        placeholders={placeholders} 
        onPaste={() => {
            increaseUsage(snippet.id);
            closeMainWindow();
        }}
      />);
    } else {
      console.log("handleSelect: No placeholders left, pasting content...");
      increaseUsage(snippet.id);
      await Clipboard.paste(expandedContent);
      await closeMainWindow();
    }
  };

  const exportSelectedAndReveal = async () => {
    try {
      const itemsToExport = (selectedIds?.length || 0) > 0 
        ? snippets.filter(s => selectedIds.includes(s.id))
        : snippets; 

      if ((itemsToExport?.length || 0) === 0) {
        throw new Error("No snippets selected to export.");
      }

      if (await confirmAlert({
        title: "Enable Global Triggers",
        message: "To use triggers in any application, you must import these snippets into Raycast's native database.\n\n1. We will generate a JSON file.\n2. Open Raycast Settings > Extensions > Snippets.\n3. Select 'Import Snippets' and choose this file.",
        primaryAction: { title: "Export & Reveal JSON" },
        dismissAction: { title: "Cancel" },
      }) === false) {
        return;
      }

      const raycastSnippets = itemsToExport.map((s) => ({
        name: s.name,
        text: s.content,
        keyword: s.trigger || "",
      }));

      const fileName = itemsToExport.length === 1 ? `snippet_${itemsToExport[0].name.substring(0, 10)}.json` : `selected_${itemsToExport.length}_snippets.json`;
      const exportPath = path.join(os.homedir(), "Downloads", fileName);
      fs.writeFileSync(exportPath, JSON.stringify(raycastSnippets, null, 2));

      const script = `tell application "Finder" to reveal posix file "${exportPath}"
      tell application "Finder" to activate`;
      
      exec(`osascript -e '${script}'`);

      await showToast({
        style: Toast.Style.Success,
        title: `Exported ${itemsToExport.length} Snippets`,
        message: "File highlighted in Finder. Drag it to Raycast settings.",
      });

      await open("raycast://extensions/raycast/snippets/manage-snippets");
      
    } catch (error) {
      showToast({
        style: Toast.Style.Failure,
        title: "Export Failed",
        message: String(error),
      });
    }
  };

  const filteredAndSortedSnippets = useMemo(() => {
    return (snippets || [])
      .filter((snippet) => {
        if (selectedDbId !== "all" && snippet.databaseId !== selectedDbId) return false;

        if (!searchText) return true;
        const lowerSearch = searchText.toLowerCase();
        const lowerName = (snippet.name || "").toLowerCase();
        const lowerTrigger = (snippet.trigger || "").toLowerCase();
        
        // Match name or trigger
        if (lowerName.includes(lowerSearch) || lowerTrigger.includes(lowerSearch)) return true;

        // Trigger + argument match
        if (snippet.trigger && lowerSearch.startsWith(lowerTrigger + " ")) return true;
        
        return false;
      })
      .sort((a, b) => {
        // Exact trigger match
        if (searchText && a.trigger === searchText) return -1;
        if (searchText && b.trigger === searchText) return 1;
        
        // Case-insensitive trigger match
        if (searchText && a.trigger?.toLowerCase() === searchText.toLowerCase()) return -1;
        if (searchText && b.trigger?.toLowerCase() === searchText.toLowerCase()) return 1;

        // Usage Count (High to Low)
        const usageA = a.usageCount || 0;
        const usageB = b.usageCount || 0;
        if (usageA !== usageB) return usageB - usageA;

        // Last Used (Recent first)
        const dateA = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
        const dateB = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
        if (dateA !== dateB) return dateB - dateA;

        // Name alphabetical
        return a.name.localeCompare(b.name);
      });
  }, [snippets, selectedDbId, searchText]);

  return (
    <List 
      isLoading={isLoading} 
      searchBarPlaceholder={`Search ${filteredAndSortedSnippets.length} snippets by name or trigger...`}
      isShowingDetail={true}
      onSearchTextChange={setSearchText}
      onSelectionChange={(ids) => {
        if (!ids) {
          setSelectedIds([]);
        } else if (Array.isArray(ids)) {
          setSelectedIds(ids);
        } else {
          setSelectedIds([ids as string]);
        }
      }}
      searchBarAccessory={
        <List.Dropdown
          tooltip="Filter by Database"
          storeValue={true}
          onChange={(newValue) => setSelectedDbId(newValue)}
        >
          <List.Dropdown.Section title="Databases">
            <List.Dropdown.Item title="All Snippets" value="all" />
            {databases.map((db) => (
              <List.Dropdown.Item key={db.id} title={db.title} value={db.id} icon={db.icon} />
            ))}
          </List.Dropdown.Section>
        </List.Dropdown>
      }
    >
      <List.EmptyView
        title="Sync Status"
        description={`${dbStatus}\n\nCurrent Configured IDs: ${preferences.databaseIds || ""}`}
        actions={
          <ActionPanel>
            <Action
              title="Open Notion Integration Settings"
              onAction={() =>
                open("https://www.notion.so/my-integrations")
              }
            />
            <Action
              title="Retry Fetch"
              icon={Icon.Repeat}
              onAction={() => {
                setIsLoading(true);
                Promise.all([fetchSnippets(), fetchDatabases()]).then(([data, dbs]) => {
                  const safeData = data || [];
                  setSnippets(safeData);
                  setDatabases(dbs);
                  setDbStatus(safeData.length > 0 ? `Loaded ${safeData.length} snippets` : "Still no snippets found.");
                  setIsLoading(false);
                });
              }}
            />
            <Action
              title="Create New Snippet"
              icon={Icon.Plus}
              shortcut={{ modifiers: ["cmd"], key: "n" }}
              onAction={() => push(<SnippetForm onSuccess={refreshSnippets} />)}
            />
            <Action 
              title={showMetadata ? "Hide Metadata" : "Show Metadata"}
              icon={showMetadata ? Icon.EyeDisabled : Icon.Eye}
              shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
              onAction={() => setShowMetadata(!showMetadata)}
            />
          </ActionPanel>
        }
      />
      {filteredAndSortedSnippets.map((snippet) => {
          const placeholders = parsePlaceholders(snippet.content);
          // Highlight placeholders: {{key}} -> `{{key}}` (using code style for visibility)
          // We use a regex that matches either {key} or {{key}} and wraps it in backticks and bold
          let highlightedContent = snippet.content.replace(/(\{?\{{1,2}.*?\}{1,2}\}?)/g, "**`$1`**");

          if (snippet.preview) {
            // Use HTML img tag for right alignment and size control (Raycast supports this subset)
            // height="150" makes it "smaller"
            // align="right" floats it to the top-right
            highlightedContent = `<img src="${snippet.preview}" alt="Preview" height="150" align="right" />\n\n` + highlightedContent;
          }

          return (
            <List.Item
              key={snippet.id}
              id={snippet.id}
              icon={dbMap[snippet.databaseId || ""]?.icon || (snippet.typeColor ? { source: Icon.Dot, tintColor: snippet.typeColor as Color } : Icon.Dot)}
              title={snippet.name}
              keywords={snippet.trigger ? [snippet.trigger] : []}
              accessories={[
                ...(snippet.type ? [{ tag: { value: snippet.type, color: snippet.typeColor as Color } }] : []),
                ...(snippet.trigger ? [{ tag: { value: snippet.trigger, color: Color.Blue } }] : [])
              ]}
              detail={
                <List.Item.Detail 
                  markdown={highlightedContent}
                  metadata={
                    showMetadata ? (
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="Information" />
                      <List.Item.Detail.Metadata.Label title="Name" text={snippet.name} />
                      {snippet.type && (
                        <List.Item.Detail.Metadata.TagList title="Type">
                          <List.Item.Detail.Metadata.TagList.Item text={snippet.type} color={snippet.typeColor as Color} />
                        </List.Item.Detail.Metadata.TagList>
                      )}
                      {snippet.status && (
                        <List.Item.Detail.Metadata.TagList title="Status">
                          <List.Item.Detail.Metadata.TagList.Item text={snippet.status} color={snippet.statusColor as Color} />
                        </List.Item.Detail.Metadata.TagList>
                      )}
                      {snippet.trigger && (
                        <List.Item.Detail.Metadata.Label title="Trigger" text={snippet.trigger} />
                      )}
                      
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.Label 
                        title="Usage" 
                        text={`${snippet.usageCount || 0} times`} 
                        icon={Icon.BarChart}
                      />
                      {snippet.lastUsed && (
                        <List.Item.Detail.Metadata.Label 
                          title="Last Used" 
                          text={new Date(snippet.lastUsed).toLocaleString()} 
                          icon={Icon.Clock}
                        />
                      )}

                      {placeholders.length > 0 && (
                        <>
                          <List.Item.Detail.Metadata.Separator />
                          <List.Item.Detail.Metadata.Label title="Variables" />
                          {placeholders.map((p) => (
                            <List.Item.Detail.Metadata.Label 
                              key={p} 
                              title={p} 
                              icon={{ source: Icon.Pencil, tintColor: Color.Orange }}
                            />
                          ))}
                        </>
                      )}

                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.Label 
                        title="Source" 
                        text={dbMap[snippet.databaseId || ""]?.title || "Unknown"} 
                        icon={dbMap[snippet.databaseId || ""]?.icon}
                      />
                    </List.Item.Detail.Metadata>
                    ) : undefined
                  }
                />
              }
              actions={
                <ActionPanel>
              <ActionPanel.Section>
                <Action title="Paste Snippet" icon={Icon.Clipboard} onAction={() => handleSelect(snippet)} />
                <Action 
                  title={showMetadata ? "Hide Metadata" : "Show Metadata"}
                  icon={showMetadata ? Icon.EyeDisabled : Icon.Eye}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
                  onAction={() => setShowMetadata(!showMetadata)}
                />
                <Action
                  title="Open in Notion"
                  icon={Icon.Link}
                  shortcut={{ modifiers: ["ctrl"], key: "n" }}
                  onAction={() => {
                    if (snippet.url) {
                      open(snippet.url);
                    } else {
                      showToast({ style: Toast.Style.Failure, title: "No URL", message: "This snippet doesn't have a Notion URL" });
                    }
                  }}
                />
                <Action
                  title="Edit Snippet"
                  icon={Icon.Pencil}
                  shortcut={{ modifiers: ["cmd"], key: "e" }}
                  onAction={() => push(<SnippetForm snippet={snippet} onSuccess={refreshSnippets} />)}
                />
                <Action
                  title="Create New Snippet"
                  icon={Icon.Plus}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "n" }}
                  onAction={() => push(<SnippetForm onSuccess={refreshSnippets} />)}
                />
              </ActionPanel.Section>
              <ActionPanel.Section title="Sync & Export">
                <Action
                  title="Refresh Sync"
                  icon={Icon.RotateAntiClockwise}
                  shortcut={{ modifiers: ["cmd"], key: "r" }}
                  onAction={refreshSnippets}
                />
                <Action
                  title={(selectedIds?.length || 0) > 1 ? `Export ${selectedIds.length} for Global Use` : "Export All for Global Use"}
                  icon={Icon.Download}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "e" }}
                  onAction={exportSelectedAndReveal}
                />
                <Action.CopyToClipboard title="Copy Raw Content" content={snippet.content} />
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      );
    })}
    </List>
  );
}
