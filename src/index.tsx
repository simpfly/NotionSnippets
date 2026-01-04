import { ActionPanel, Action, List, useNavigation, Clipboard, showToast, Toast, open, Icon, getPreferenceValues, confirmAlert, Alert, Color } from "@raycast/api"; 
import { useCachedState } from "@raycast/utils";
import { useEffect, useState } from "react";
import { fetchSnippets, fetchDatabases } from "./api/notion";
import { Snippet, Preferences } from "./types/index";
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
  const [snippets, setSnippets] = useCachedState<Snippet[]>("notion-snippets", []);
  const [databases, setDatabases] = useState<{ id: string; title: string }[]>([]);
  const [selectedDbId, setSelectedDbId] = useState<string>("all");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [searchText, setSearchText] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [dbStatus, setDbStatus] = useState<string>("Initializing...");
  
/**
 * ... (skipping unchanged lines for brevity in tool call, will target specific lines)
 */


  
  // Hooks
  const { push } = useNavigation();
  const preferences = getPreferenceValues<Preferences>();

  useEffect(() => {
    let isMounted = true;
    async function load() {
      setIsLoading(true);
      try {
        console.log("Index: Calling fetchSnippets()...");
        const [data, dbs] = await Promise.all([fetchSnippets(), fetchDatabases()]);
        if (isMounted) {
          const safeData = data || [];
          console.log(`Index: fetchSnippets returned ${safeData.length} items`);
          setSnippets(safeData);
          setDatabases(dbs);
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
      const data = await fetchSnippets();
      setSnippets(data || []);
      setDbStatus(data.length > 0 ? `Loaded ${data.length} snippets` : "No snippets found.");
      console.log(`refreshSnippets: Successfully loaded ${data?.length} snippets`);
    } catch (error) {
      console.error("refreshSnippets: Failed", error);
      setDbStatus(`Error: ${String(error)}`);
    } finally {
      setIsLoading(false);
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
    if (expandedContent !== snippet.content) {
      console.log("handleSelect: Expanded {clipboard} or {date} placeholders");
    }
    
    const placeholders = parsePlaceholders(expandedContent) || [];
    if (placeholders.length > 0) {
      console.log(`handleSelect: Found ${placeholders.length} custom placeholders, pushing FillerForm`);
      push(<FillerForm snippet={{ ...snippet, content: expandedContent }} placeholders={placeholders} />);
    } else {
      console.log("handleSelect: No placeholders left, pasting content...");
      await Clipboard.paste(expandedContent);
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

  return (
    <List 
      isLoading={isLoading} 
      searchBarPlaceholder={`Search ${snippets?.length || 0} snippets by name or trigger...`}
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
              <List.Dropdown.Item key={db.id} title={db.title} value={db.id} />
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
          </ActionPanel>
        }
      />
      {(snippets || [])
        .filter((snippet) => {
          if (selectedDbId !== "all" && snippet.databaseId !== selectedDbId) return false;

          if (!searchText) return true;
          const lowerSearch = searchText.toLowerCase();
          const lowerName = (snippet.name || "").toLowerCase();
          const lowerTrigger = (snippet.trigger || "").toLowerCase();
          
          // 1. Keep if search text matches name or trigger (partial match)
          if (lowerName.includes(lowerSearch) || lowerTrigger.includes(lowerSearch)) return true;

          // 2. Keep if it looks like we are typing a "trigger + argument" command
          //    e.g. Trigger is "hello", Search is "hello world"
          if (snippet.trigger && lowerSearch.startsWith(lowerTrigger + " ")) return true;
          
          return false;
        })
        .sort((a, b) => {
          // Exact match
          if (searchText && a.trigger === searchText) return -1;
          if (searchText && b.trigger === searchText) return 1;
          
          // Trigger + Argument match (starts with trigger + space)
          const aArg = searchText && a.trigger && searchText.startsWith(a.trigger + " ");
          const bArg = searchText && b.trigger && searchText.startsWith(b.trigger + " ");
          if (aArg && !bArg) return -1;
          if (!aArg && bArg) return 1;

          return 0;
        })
        .map((snippet) => {
          const placeholders = parsePlaceholders(snippet.content);
          // Highlight placeholders: {{key}} -> `{{key}}` (using code style for visibility)
          // We use a regex that matches either {key} or {{key}} and wraps it in backticks and bold
          const highlightedContent = snippet.content.replace(/(\{?\{{1,2}.*?\}{1,2}\}?)/g, "**`$1`**");

          return (
            <List.Item
              key={snippet.id}
              id={snippet.id}
              icon={Icon.Text}
              title={snippet.name}
              keywords={snippet.trigger ? [snippet.trigger] : []}
              accessories={snippet.trigger ? [{ tag: { value: snippet.trigger, color: Color.Blue } }] : []}
              detail={
                <List.Item.Detail 
                  markdown={highlightedContent}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="Information" />
                      <List.Item.Detail.Metadata.Label title="Name" text={snippet.name} />
                      {snippet.trigger && (
                        <List.Item.Detail.Metadata.Label title="Trigger" text={snippet.trigger} />
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
                      <List.Item.Detail.Metadata.Label title="Source" text={snippet.sourceDb} />
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel>
              <ActionPanel.Section>
                <Action title="Paste Snippet" icon={Icon.Clipboard} onAction={() => handleSelect(snippet)} />
                <Action.CreateSnippet
                  title="Sync to Official (Native)"
                  icon={Icon.PlusCircle}
                  shortcut={{ modifiers: ["cmd"], key: "n" }}
                  snippet={{
                    name: snippet.name,
                    text: snippet.content,
                    keyword: snippet.trigger,
                  }}
                />
                <Action
                  title="Create New Snippet"
                  icon={Icon.Plus}
                  shortcut={{ modifiers: ["cmd"], key: "n" }}
                  onAction={() => push(<SnippetForm onSuccess={refreshSnippets} />)}
                />
                <Action
                  title="Edit Snippet"
                  icon={Icon.Pencil}
                  shortcut={{ modifiers: ["cmd"], key: "e" }}
                  onAction={() => push(<SnippetForm snippet={snippet} onSuccess={refreshSnippets} />)}
                />
              </ActionPanel.Section>
              
              <ActionPanel.Section title="Bulk Actions">
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
